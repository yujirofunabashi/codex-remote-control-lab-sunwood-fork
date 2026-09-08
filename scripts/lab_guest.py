#!/usr/bin/env python3
"""Bounded lab operations over the existing serial console, never a network listener."""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import threading
import time

PREFIX = b"PHONE_LAB_V1 "
MAX_FRAME = 400000
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def encode_frame(value):
    data = PREFIX + base64.b64encode(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()) + b"\n"
    if len(data) > MAX_FRAME:
        raise ValueError("Lab response is too large")
    return data


def decode_frame(line):
    if len(line) > MAX_FRAME or not line.startswith(PREFIX):
        raise ValueError("Invalid lab frame")
    value = json.loads(base64.b64decode(line[len(PREFIX):].strip(), validate=True))
    if not isinstance(value, dict):
        raise ValueError("Invalid lab message")
    return value


class WorkFiles:
    """Resolve each component through a pinned directory, rejecting all symlinks."""
    def __init__(self, root):
        self.root = str(root).rstrip("/")
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def close(self):
        os.close(self.fd)

    def parts(self, value):
        value = str(value or self.root)
        if value != self.root and not value.startswith(self.root + "/"):
            raise ValueError("実験用の作業フォルダの外は操作できません。")
        parts = value[len(self.root):].strip("/").split("/") if value != self.root else []
        if any(not part or part.startswith(".") or "\\" in part or "\x00" in part for part in parts):
            raise ValueError("隠しファイルや別の場所への参照は操作できません。")
        return parts

    @contextlib.contextmanager
    def opened(self, value, directory=False):
        pinned, current = os.fstat(self.fd), os.stat(self.root, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or (pinned.st_dev, pinned.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("実験用フォルダが置き換わったため操作を停止しました。")
        parts = self.parts(value)
        fd = os.dup(self.fd)
        try:
            for index, part in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if index < len(parts) - 1 or directory:
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            if directory and not stat.S_ISDIR(os.fstat(fd).st_mode):
                raise ValueError("フォルダではありません。")
            yield fd
        finally:
            os.close(fd)

    def browse(self, value):
        value = str(value or self.root)
        entries = []
        with self.opened(value, directory=True) as fd:
            for name in sorted(os.listdir(fd)):
                if name.startswith("."):
                    continue
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISDIR(info.st_mode):
                    entries.append({"name": name, "path": value + "/" + name, "isRepo": False, "pinned": False})
                if len(entries) >= 200:
                    break
        return {"path": value, "entries": entries, "isRepo": False, "pinned": False}

    def read(self, value):
        with self.opened(value) as fd:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 80000:
                raise ValueError("表示できるのは80KB以下の文章ファイルです。")
            data = os.read(fd, 80001)
            if len(data) > 80000 or b"\x00" in data:
                raise ValueError("文章として表示できないファイルです。")
            return {"path": value, "kind": "markdown" if value.endswith(".md") else "text", "text": data.decode("utf-8"), "modifiedAt": int(info.st_mtime * 1000)}

    def snapshot(self):
        artifacts = []
        def visit(directory, depth):
            if len(artifacts) >= 200 or depth > 3:
                return
            with self.opened(directory, directory=True) as fd:
                for name in sorted(os.listdir(fd)):
                    if name.startswith(".") or name == "node_modules":
                        continue
                    value = directory + "/" + name
                    try:
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        visit(value, depth + 1)
                    elif stat.S_ISREG(info.st_mode) and Path(name).suffix.lower() in (".md", ".txt", ".json", ".csv", ".py", ".js") and info.st_size <= 80000:
                        artifacts.append({"path": value, "size": info.st_size, "modifiedAt": int(info.st_mtime * 1000)})
                    if len(artifacts) >= 200:
                        return
        visit(self.root, 0)
        first = self.root + "/first-ai-task-01/PLAN.json"
        try:
            first_plan = self.read(first)
            if len(first_plan["text"].encode()) > 40000:
                first_plan = None
        except (OSError, ValueError, UnicodeError):
            first_plan = None
        return {"artifacts": artifacts, "firstPlan": first_plan}


def guarded_helper(config):
    if os.getuid() != 0 or not sys.platform.startswith("linux"):
        raise RuntimeError("The lab controller requires the isolated Linux guest")
    helper_path = Path(config["guardHelper"])
    if helper_path.is_symlink() or hashlib.sha256(helper_path.read_bytes()).hexdigest() != config["guardSha256"]:
        raise RuntimeError("The verified guest guard changed")
    spec = importlib.util.spec_from_file_location("phone_lab_guard", helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.guest_guard()
    return helper


def codex_command(config, workdir, session=None):
    args = [config["codex"], "-a", "never", "-c", 'forced_login_method="chatgpt"',
            "-c", 'cli_auth_credentials_store="file"', "-c", 'web_search="disabled"',
            "-c", 'sandbox_workspace_write.network_access=false', "-c", "agents.enabled=false",
            "-c", 'model_reasoning_effort="' + config["effort"] + '"']
    for feature in ("hooks", "plugins", "apps", "browser_use", "computer_use"):
        args += ["-c", "features." + feature + "=false"]
    args += ["exec", "--ignore-user-config", "--skip-git-repo-check", "--json", "--sandbox", "workspace-write", "-C", workdir, "-m", config["model"]]
    if session:
        if not UUID.fullmatch(session):
            raise ValueError("Invalid Codex conversation id")
        args += ["resume", session]
    return args + ["-"]


def service_command(config, task_id, workdir, session=None):
    if not UUID.fullmatch(task_id):
        raise ValueError("Invalid task id")
    properties = ["User=" + config["user"], "Group=" + config["user"], "WorkingDirectory=" + workdir,
                  "RuntimeMaxSec=600", "TimeoutStopSec=10", "KillMode=control-group", "NoNewPrivileges=yes",
                  "ProtectSystem=strict", "ProtectHome=read-only", "ReadWritePaths=" + config["workRoot"] + " " + config["authDir"],
                  "Type=exec", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectControlGroups=yes",
                  "CapabilityBoundingSet=", "RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK", "UMask=0077", "TasksMax=128", "MemoryMax=2G"]
    args = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect", "--no-ask-password", "--expand-environment=no", "--unit=phone-lab-turn-" + task_id]
    for prop in properties:
        args += ["--property=" + prop]
    args += ["--setenv=HTTPS_PROXY=http://127.0.0.1:3128", "--setenv=HTTP_PROXY=http://127.0.0.1:3128", "--setenv=RUST_LOG=off"]
    return args + codex_command(config, workdir, session)


class Guest:
    def __init__(self, config, emit, *, guard=None, launch=None):
        self.config, self.emit = config, emit
        self.guard = guard or (lambda: guarded_helper(config))
        self.launch = launch or subprocess.Popen
        self.guard()
        self.files = WorkFiles(config["workRoot"])
        self.state_dir = Path(config["stateDir"])
        self.state_dir.mkdir(mode=0o700, exist_ok=True)
        if self.state_dir.is_symlink() or self.state_dir.stat().st_mode & 0o077:
            raise RuntimeError("Unsafe controller state directory")
        self.state_file = self.state_dir / "state.json"
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {"tasks": {}, "sessions": {}}
        self.lock = threading.RLock()
        self.active = None
        self.stopping = False
        self.thread = None
        # Never re-run a task that might have started before a guest restart.
        for task_id, task in self.state["tasks"].items():
            if "result" not in task:
                task["result"] = {"ok": False, "error": "実験室が再起動したため作業の完了を確認できません。", "data": {"interrupted": True}}
        self.save()

    def save(self):
        temporary = self.state_file.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(self.state, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.state_file)

    def result(self, task_id, result):
        self.emit({"id": task_id, "result": result})

    def identity(self):
        return {"ready": not self.stopping, "activeTask": self.active, "guestSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

    def handle(self, request):
        task_id, op, args = request.get("id", ""), request.get("op"), request.get("args", {})
        if not UUID.fullmatch(task_id) or not isinstance(args, dict):
            raise ValueError("Invalid request")
        try:
            if op == "run":
                return self.start_run(task_id, args)
            if op == "interrupt":
                target = args.get("taskId", "")
                if not UUID.fullmatch(target):
                    raise ValueError("Invalid interruption target")
                with self.lock:
                    if self.active == target:
                        self.state["tasks"][target]["interrupted"] = True
                        self.save()
                        subprocess.run(["systemctl", "stop", "phone-lab-turn-" + target], check=True, timeout=20, capture_output=True)
                return self.result(task_id, {"ok": True, "data": {"interrupted": target}})
            if op == "status":
                return self.result(task_id, {"ok": True, "data": self.identity()})
            if op == "browse":
                data = self.files.browse(args.get("path"))
            elif op == "read":
                data = self.files.read(args.get("path", ""))
            elif op == "snapshot":
                data = self.files.snapshot()
            elif op == "shutdown":
                if self.active:
                    raise RuntimeError("作業中のため停止できません。")
                if not self.stopping:
                    subprocess.run(["shutdown", "-h", "+1"], check=True, timeout=10, capture_output=True)
                self.stopping = True
                self.result(task_id, {"ok": True, "data": {"stopping": True}})
                return
            else:
                raise ValueError("Unsupported guest operation")
            self.result(task_id, {"ok": True, "data": data})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            self.result(task_id, {"ok": False, "error": str(error)[:500]})

    def start_run(self, task_id, args):
        with self.lock:
            prior = self.state["tasks"].get(task_id)
            if prior:
                if "result" in prior:
                    return self.result(task_id, prior["result"])
                self.emit({"id": task_id, "event": {"type": "status", "state": "running"}})
                return
            if self.active:
                raise RuntimeError("実験室で別の作業が動いています。")
            if self.stopping:
                raise RuntimeError("実験室は停止処理中です。")
            prompt, thread_id, workdir = args.get("prompt"), args.get("threadId", ""), args.get("workdir", "")
            if not isinstance(prompt, str) or not 0 < len(prompt.strip()) <= 20000 or not re.fullmatch(r"lab-(?:first-plan|[a-f0-9-]{36})", thread_id):
                raise ValueError("Invalid task input")
            self.guard()
            with self.files.opened(workdir, directory=True):
                pass
            session = self.state["sessions"].get(thread_id)
            if session and session["workdir"] != workdir:
                raise ValueError("Conversation belongs to a different folder")
            self.state["tasks"][task_id] = {"threadId": thread_id, "workdir": workdir, "startedAt": time.time()}
            self.active = task_id
            self.save()  # Save before launch. A repeated delivery cannot execute again.
            self.thread = threading.Thread(target=self.execute, args=(task_id, args, session), daemon=False)
            self.thread.start()

    def execute(self, task_id, args, session):
        text, native_id, completed, failed = "", session and session["nativeId"], False, False
        process = None
        diagnostic = self.state_dir / (task_id + ".log")
        try:
            prompt = "この作業はWindows内の隔離された実験室だけで行います。作業フォルダ内の実装・検査を行い、公開・外部送信・実際の支出・本番操作・信頼側の台帳や制御の変更は禁止です。結果と実施した検査を日本語で報告してください。\n\n" + args["prompt"]
            if args["threadId"] == "lab-first-plan" and not session:
                prompt += "\n\n既存の計画草案:\n" + self.files.read(args["workdir"] + "/PLAN.json")["text"]
            command = service_command(self.config, task_id, args["workdir"], native_id)
            with diagnostic.open("x") as errors:
                process = self.launch(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True, encoding="utf-8")
                process.stdin.write(prompt)
                process.stdin.close()
                total = 0
                self.emit({"id": task_id, "event": {"type": "status", "state": "running"}})
                for line in process.stdout:
                    total += len(line)
                    if total > 4000000 or len(line) > 1000000:
                        subprocess.run(["systemctl", "stop", "phone-lab-turn-" + task_id], timeout=20, capture_output=True)
                        raise RuntimeError("実行記録の上限に達しました。")
                    event = json.loads(line)
                    if event.get("type") == "thread.started" and UUID.fullmatch(event.get("thread_id", "")):
                        native_id = event["thread_id"]
                    if event.get("type") == "item.completed" and event.get("item", {}).get("type") == "agent_message":
                        text = str(event["item"].get("text", "")).encode()[-100000:].decode("utf-8", errors="ignore")
                    completed |= event.get("type") == "turn.completed"
                    failed |= event.get("type") in ("turn.failed", "error")
                returncode = process.wait(timeout=20)
            with self.lock:
                interrupted = self.state["tasks"][task_id].get("interrupted", False)
            ok = returncode == 0 and completed and not failed and not interrupted
            result = {"ok": ok, "data": {"text": text, "interrupted": interrupted}}
            if not ok:
                result["error"] = "作業を中断しました。" if interrupted else "実験担当の作業が完了しませんでした。診断記録は実験室内に保存しました。"
            if native_id:
                with self.lock:
                    self.state["sessions"][args["threadId"]] = {"nativeId": native_id, "workdir": args["workdir"]}
        except Exception:
            if process is not None:
                try:
                    subprocess.run(["systemctl", "stop", "phone-lab-turn-" + task_id], timeout=20, capture_output=True)
                    process.wait(timeout=20)
                except (OSError, subprocess.SubprocessError):
                    pass
            result = {"ok": False, "error": "実験担当の起動または実行記録の確認に失敗しました。", "data": {"text": text}}
        with self.lock:
            self.state["tasks"][task_id]["result"] = result
            self.active = None
            self.save()
        self.result(task_id, result)


def main():
    import termios
    import tty
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if args.config.is_symlink() or args.config.stat().st_uid != 0 or args.config.stat().st_mode & 0o022:
        raise RuntimeError("Guest config must be protected by the controller")
    config = json.loads(args.config.read_text())
    os.umask(0o077)
    fd = os.open("/dev/ttyS0", os.O_RDWR | os.O_NOCTTY)
    original = termios.tcgetattr(fd)
    tty.setraw(fd)
    writer_lock = threading.Lock()
    def emit(value):
        data = encode_frame(value)
        with writer_lock:
            while data:
                data = data[os.write(fd, data):]
    guest = Guest(config, emit)
    emit({**guest.identity(), "version": 1})
    pending = bytearray()
    deadline = time.monotonic() + 1800
    def stop_controller(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop_controller)
    try:
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 1)[0]:
                continue
            pending.extend(os.read(fd, 65536))
            if len(pending) > MAX_FRAME:
                pending.clear()
                continue
            while b"\n" in pending:
                line, _, rest = pending.partition(b"\n")
                pending = bytearray(rest)
                try:
                    guest.handle(decode_frame(line))
                except (ValueError, UnicodeError):
                    continue
    finally:
        if guest.active:
            subprocess.run(["systemctl", "stop", "phone-lab-turn-" + guest.active], timeout=20, capture_output=True)
        if guest.thread:
            guest.thread.join(timeout=25)
        guest.files.close()
        termios.tcsetattr(fd, termios.TCSANOW, original)
        os.close(fd)
        subprocess.run(["shutdown", "-h", "now"], timeout=10, capture_output=True)


if __name__ == "__main__":
    main()
