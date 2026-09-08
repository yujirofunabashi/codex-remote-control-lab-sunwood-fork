#!/usr/bin/env python3
"""Windows-side relay for one verified VM. Opens no network listener or shared folder."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from lab_guest import MAX_FRAME, PREFIX, decode_frame, encode_frame


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Lab relay redirects are not allowed")


class RelayClient:
    def __init__(self, base_url, token):
        url = urllib.parse.urlsplit(base_url)
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("Relay URL must be an origin")
        if url.scheme == "http":
            ip = ipaddress.ip_address(url.hostname)
            if not ip.is_loopback and ip not in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError("Plain HTTP is permitted only over the private Tailscale link")
        elif url.scheme != "https":
            raise ValueError("Unsupported relay URL")
        self.base_url, self.token = base_url.rstrip("/"), token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def post(self, operation, body):
        if operation not in ("poll", "result", "event"):
            raise ValueError("Unsupported worker operation")
        request = urllib.request.Request(self.base_url + "/worker/" + operation,
            data=json.dumps(body, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "X-Lab-Worker-Token": self.token}, method="POST")
        with self.opener.open(request, timeout=8) as response:
            data = response.read(512001)
            if len(data) > 512000:
                raise ValueError("Oversized relay response")
            return json.loads(data)


def load_guard(config):
    source = Path(config["guardHelper"])
    if source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != config["guardSha256"]:
        raise RuntimeError("The verified Windows guard changed")
    spec = importlib.util.spec_from_file_location("phone_lab_windows_guard", source)
    net = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(net)
    net.validate_acl(net.inspect())
    return net


class WindowsVM:
    def __init__(self, config, emit):
        self.config, self.emit = config, emit
        self.net = load_guard(config)
        self.check_attachment(self.net.inspect())
        self.pipe = None
        self.ready = False
        self.write_lock = threading.Lock()
        self.reader = None
        self.closed = False
        self.pending_status = set()
        self.snapshot = {"vmState": "unknown", "guestReady": False}
        self.inspected_at = 0

    def check_attachment(self, state):
        allowed = [self.config["seed"]]
        if state["State"] == "Off":
            allowed.append(self.config["previousSeed"])
        self.net.require(any(self.net.same_path(state["Dvd"], medium) for medium in allowed),
                         "別の実験の起動媒体です。その実験の終了と引き継ぎを確認してください。")

    def target(self):
        if time.monotonic() - self.inspected_at < 4:
            return dict(self.snapshot, guestReady=self.ready)
        try:
            state = self.net.inspect()
            self.net.validate_acl(state)
            self.check_attachment(state)
            names = {"Off": "off", "Running": "running", "Starting": "starting", "Stopping": "stopping"}
            self.snapshot = {"vmState": names.get(state["State"], "unknown"), "guestReady": self.ready}
            if state["State"] != "Running":
                self.ready = False
            elif self.pipe is None:
                self.open_pipe()
                request_id = str(uuid.uuid4())
                self.pending_status.add(request_id)
                self.send({"id": request_id, "op": "status", "args": {}})
        except Exception:
            self.ready = False
            self.snapshot = {"vmState": "unknown", "guestReady": False}
        self.inspected_at = time.monotonic()
        return dict(self.snapshot, guestReady=self.ready)

    def open_pipe(self):
        if self.pipe is not None:
            return
        self.pipe = open(self.net.PIPE, "r+b", buffering=0)
        self.reader = threading.Thread(target=self.read_pipe, daemon=True)
        self.reader.start()

    def read_pipe(self):
        import ctypes
        import msvcrt
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        peek.restype = wintypes.BOOL
        pipe = self.pipe
        pending = bytearray()
        try:
            while not self.closed:
                count = wintypes.DWORD()
                if not peek(msvcrt.get_osfhandle(pipe.fileno()), None, 0, None, ctypes.byref(count), None):
                    break
                if not count.value:
                    time.sleep(0.05)
                    continue
                pending.extend(pipe.read(min(count.value, 65536)))
                if len(pending) > MAX_FRAME:
                    pending.clear()
                    continue
                while b"\n" in pending:
                    line, _, rest = pending.partition(b"\n")
                    pending = bytearray(rest)
                    # Boot messages share this serial console. Only framed
                    # responses are protocol messages, never executable text.
                    start = line.find(PREFIX)
                    if start < 0:
                        continue
                    try:
                        message = decode_frame(line[start:])
                    except (ValueError, UnicodeError):
                        continue
                    if message.get("ready") is True and message.get("version") == 1:
                        self.ready = message.get("guestSha256") == self.config["guestSha256"]
                    elif message.get("id") in self.pending_status:
                        self.pending_status.discard(message["id"])
                        data = message.get("result", {}).get("data", {})
                        self.ready = data.get("ready") is True and data.get("guestSha256") == self.config["guestSha256"]
                    else:
                        self.emit(message)
        finally:
            self.ready = False
            if self.pipe is pipe:
                self.pipe = None
            pipe.close()

    def send(self, request):
        if self.pipe is None:
            raise RuntimeError("Guest console is unavailable")
        data = encode_frame(request)
        with self.write_lock:
            while data:
                count = self.pipe.write(data[:16384])
                if not count:
                    raise RuntimeError("Guest console write failed")
                data = data[count:]

    def start(self):
        current = self.net.inspect()
        self.net.validate_acl(current)
        self.check_attachment(current)
        if current["State"] == "Running":
            self.target()
            if not self.ready:
                raise RuntimeError("実験室は起動中ですが、接続処理の準備完了を確認できません。")
            return {"ready": self.ready}
        self.net.require(current["State"] == "Off" and not current["Switch"], "requires stopped disconnected VM")
        seed = Path(self.config["seed"])
        self.net.require(not seed.is_symlink() and hashlib.sha256(seed.read_bytes()).hexdigest() == self.config["seedSha256"], "verified lab medium changed")
        self.net.require(any(self.net.same_path(current["Dvd"], name) for name in (self.config["previousSeed"], str(seed))), "different prior VM medium")
        self.net.ps("Set-VMDvdDrive -VMName agent-lab -Path '" + str(seed).replace("'", "''") + "'")
        self.net.ps("Start-VM -Name agent-lab")
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            if self.pipe is None:
                try:
                    self.open_pipe()
                except OSError:
                    time.sleep(0.2)
                    continue
            if self.ready:
                self.inspected_at = 0
                return {"ready": True}
            time.sleep(0.1)
        raise RuntimeError("実験室の起動確認が時間切れになりました。通信は接続していません。")

    def network(self, enabled):
        current = self.net.inspect()
        self.net.validate_acl(current)
        self.check_attachment(current)
        if enabled:
            self.net.require(current["State"] == "Running" and self.ready, "guest must report ready before connecting")
            self.net.gateway_check(current)
            self.net.require(current["Switch"] in ("", "Default Switch", None), "different guest switch")
            self.net.ps("Connect-VMNetworkAdapter -VMName agent-lab -SwitchName 'Default Switch'")
            self.net.validate_acl(self.net.inspect())
        else:
            self.net.disconnect()


class HostAgent:
    def __init__(self, config, *, driver_factory=WindowsVM, client=None):
        self.config = config
        self.client = client or RelayClient(config["relayUrl"], config["workerToken"])
        self.messages = queue.Queue()
        self.driver = driver_factory(config, self.messages.put)
        self.state_file = Path(config["stateFile"])
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {"jobs": {}}
        self.inflight = set()
        self.sent_at = {}
        self.lock = threading.RLock()
        self.network_task = None
        self.watchdogs = {}
        # After a host relay restart, do not leave an old guest connection open.
        self.driver.network(False)
        for job in self.state["jobs"].values():
            if "result" not in job and job["command"]["op"] in ("start", "shutdown"):
                job["result"] = {"ok": False, "error": "中継が再起動したため、前回の起動・停止依頼の完了は未確認です。現在の状態を確認してください。"}
                job["delivered"] = False
        self.save()

    def save(self):
        temporary = self.state_file.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(self.state, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.state_file)

    def dispatch(self, command):
        task_id = command.get("id", "")
        if str(uuid.UUID(task_id)) != task_id or command.get("op") not in ("start", "shutdown", "browse", "read", "snapshot", "run", "interrupt"):
            raise ValueError("Invalid assigned command")
        with self.lock:
            prior = self.state["jobs"].get(task_id)
            if prior and "result" in prior:
                self.messages.put({"id": task_id, "result": prior["result"]})
                return
            if task_id in self.inflight:
                # Pure reads and task-specific interruption may be retried;
                # a turn or a VM start is never launched a second time here.
                if command["op"] not in ("browse", "read", "snapshot", "interrupt") or time.monotonic() - self.sent_at[task_id] < 10:
                    return
            self.state["jobs"][task_id] = {"command": command}
            self.inflight.add(task_id)
            self.sent_at[task_id] = time.monotonic()
            self.save()
        threading.Thread(target=self.execute, args=(command,), daemon=True).start()

    def execute(self, command):
        task_id, op = command["id"], command["op"]
        try:
            if op == "start":
                result = {"ok": True, "data": self.driver.start()}
                self.messages.put({"id": task_id, "result": result})
            else:
                if not self.driver.ready:
                    raise RuntimeError("実験室の準備完了を確認できません。")
                if op == "run":
                    with self.lock:
                        if self.network_task not in (None, task_id):
                            raise RuntimeError("別の作業の通信が終了していません。")
                        self.network_task = task_id
                        self.driver.network(True)
                        timer = threading.Timer(660, self.expire_run, args=(task_id,))
                        timer.daemon = True
                        self.watchdogs[task_id] = timer
                        timer.start()
                elif op == "shutdown":
                    self.driver.network(False)
                self.driver.send(command)
        except Exception as error:
            if op == "run":
                try:
                    with self.lock:
                        if self.network_task == task_id:
                            self.driver.network(False)
                            self.network_task = None
                except Exception:
                    pass
            self.messages.put({"id": task_id, "result": {"ok": False, "error": str(error)[:500]}})

    def expire_run(self, task_id):
        with self.lock:
            if self.network_task != task_id:
                return
            try:
                self.driver.network(False)
                detail = "通信を切断しました。実行終了は未確認です。"
            except Exception:
                detail = "通信切断を確認できません。Windows側の確認が必要です。"
            try:
                self.driver.send({"id": str(uuid.uuid4()), "op": "interrupt", "args": {"taskId": task_id}})
            except Exception:
                pass
            self.network_task = None
            self.messages.put({"id": task_id, "result": {"ok": False, "error": "応答の制限時間を超えたため、" + detail}})

    def drain(self):
        while not self.messages.empty():
            message = self.messages.get_nowait()
            task_id = message.get("id")
            with self.lock:
                job = self.state["jobs"].get(task_id)
                if not job:
                    continue
                if "result" in message:
                    if "result" in job:
                        job["delivered"] = False
                        continue
                    result = message["result"]
                    if job["command"]["op"] == "shutdown" and result.get("ok"):
                        self.driver.ready = False
                    if job["command"]["op"] == "run" and self.network_task == task_id:
                        try:
                            self.driver.network(False)
                        except Exception:
                            result = {"ok": False, "error": "作業後の通信切断を確認できません。Windows側の状態確認が必要です。", "data": result.get("data", {})}
                        self.network_task = None
                    timer = self.watchdogs.pop(task_id, None)
                    if timer:
                        timer.cancel()
                    job["result"] = result
                    job["delivered"] = False
                    self.inflight.discard(task_id)
                    self.save()
                elif "event" in message:
                    try:
                        self.client.post("event", message)
                    except Exception:
                        pass  # Heartbeats still identify a disconnected relay.
        # Durable outbox: a disconnected phone/relay cannot lose a completion.
        for task_id, job in list(self.state["jobs"].items()):
            if "result" in job and not job.get("delivered"):
                self.client.post("result", {"id": task_id, "result": job["result"]})
                with self.lock:
                    job["delivered"] = True
                    self.save()

    def tick(self):
        self.drain()
        response = self.client.post("poll", {"target": self.driver.target()})
        if response.get("command"):
            self.dispatch(response["command"])

    def run(self):
        print("Windows lab connection started. No credentials are printed.", flush=True)
        try:
            while True:
                try:
                    self.tick()
                    delay = 1
                except (OSError, ValueError, RuntimeError, urllib.error.URLError):
                    delay = 3
                time.sleep(delay)
        finally:
            for timer in list(self.watchdogs.values()):
                timer.cancel()
            self.driver.closed = True
            self.driver.network(False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt" or args.config.is_symlink():
        raise RuntimeError("Run this helper only on the verified Windows host")
    config = json.loads(args.config.read_text())
    HostAgent(config).run()


if __name__ == "__main__":
    main()
