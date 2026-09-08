#!/usr/bin/env python3
"""Prepare a private, read-only-first connection and a one-use Tailscale handoff."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import re
import zipfile
from urllib.parse import urlsplit


def private_ip(value):
    address = ipaddress.ip_address(value)
    if address.version != 4 or not (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")):
        raise ValueError("Use a private Tailscale or loopback address")
    return value


def owner_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)


def build(plan, output, *, make_iso=None):
    from build_lab_seed import build as build_seed, guest_config
    guest = guest_config(plan["guest"])
    required_windows = {"directory", "guardHelper", "guardSha256", "previousSeed", "previousSeedSha256"}
    if set(plan["windows"]) != required_windows or any(not re.fullmatch(r"[a-f0-9]{64}", plan["windows"][field]) for field in ("guardSha256", "previousSeedSha256")):
        raise ValueError("Use only the explicit Windows paths and pinned guard/previous-medium hashes")
    relay = dict(plan["relay"])
    private_ip(relay["host"])
    transfer = plan["transfer"]
    private_ip(transfer["host"])
    private_ip(transfer["allowedHost"])
    for port in (relay["port"], transfer["port"]):
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError("Invalid private listener port")
    if (relay["host"] != transfer["host"] and not ipaddress.ip_address(relay["host"]).is_loopback) or relay["port"] == transfer["port"]:
        raise ValueError("Use the same relay machine and distinct ports")
    relay_url = plan.get("relayOrigin", f"http://{relay['host']}:{relay['port']}")
    parsed = urlsplit(relay_url)
    if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("Use an exact relay origin without embedded credentials")
    if parsed.scheme == "http":
        private_ip(parsed.hostname)
    elif parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".ts.net"):
        raise ValueError("Use the private Tailscale HTTPS origin")
    for key in ("workRoot", "model", "effort"):
        if relay[key] != guest[key]:
            raise ValueError("Relay and guest settings differ")
    if "phoneToken" in relay or "workerToken" in relay:
        raise ValueError("Generate new private credentials locally, never put them in a plan")
    if output.is_symlink() or output.parent.is_symlink():
        raise ValueError("Private output must not be linked")
    output.parent.mkdir(mode=0o700, exist_ok=True)
    output.mkdir(mode=0o700, exist_ok=False)
    relay.update(phoneToken=secrets.token_urlsafe(32), workerToken=secrets.token_urlsafe(32), stateFile=str(output / "relay-state.json"))
    owner_file(output / "relay.json", relay)
    build_seed(output / "seed", plan["instanceId"], guest, plan["network"])
    iso = output / "seed.iso"
    if make_iso:
        make_iso(output / "seed", iso)
    else:
        subprocess.run(["/usr/bin/hdiutil", "makehybrid", "-iso", "-joliet", "-default-volume-name", "CIDATA",
                        "-o", str(iso), str(output / "seed")], check=True, capture_output=True, timeout=60)
    scripts = Path(__file__).parent
    host = dict(plan["windows"])
    directory = host.pop("directory").rstrip("/\\")
    host.update(relayUrl=relay_url, workerToken=relay["workerToken"],
                seed=directory + "/seed.iso", stateFile=directory + "/host-state.json",
                seedSha256=hashlib.sha256(iso.read_bytes()).hexdigest(),
                guestSha256=hashlib.sha256((scripts / "lab_guest.py").read_bytes()).hexdigest())
    package = output / "connection.zip"
    with package.open("xb") as stream, zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as bundle:
        for entry, source in (("install.py", "lab_install_host.py"), ("lab_host.py", "lab_host.py"), ("lab_guest.py", "lab_guest.py")):
            bundle.writestr(entry, (scripts / source).read_bytes())
        bundle.writestr("host.json", json.dumps(host))
        bundle.writestr("seed.iso", iso.read_bytes())
    os.chmod(package, 0o600)
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    url = f"http://{transfer['host']}:{transfer['port']}/connection.zip"
    code = ("import hashlib,io,sys,urllib.request,zipfile; "
            "op=urllib.request.build_opener(urllib.request.ProxyHandler({})); "
            f"data=op.open(urllib.request.Request('{url}',headers={{'X-Lab-Setup':'1'}}),timeout=30).read(8388609); "
            f"hashlib.sha256(data).hexdigest()=='{digest}' or sys.exit('Package verification failed'); "
            "lab_bundle=zipfile.ZipFile(io.BytesIO(data)); exec(compile(lab_bundle.read('install.py'),'install.py','exec'))")
    handoff = {"command": 'py -3 -B -c "' + code + '"', "bundleSha256": digest,
               "seedSha256": host["seedSha256"], "guestSha256": host["guestSha256"],
               "relayConfig": str(output / "relay.json"), "transfer": transfer}
    owner_file(output / "handoff.json", handoff)
    return handoff


def handoff_server(package, host, port, allowed_host):
    private_ip(host)
    private_ip(allowed_host)
    if package.is_symlink() or not package.is_file() or package.stat().st_mode & 0o077:
        raise ValueError("Handoff bundle must be an owner-only regular file")
    content = package.read_bytes()
    if len(content) > 8 * 1024 * 1024:
        raise ValueError("Handoff bundle is too large")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(5)
            super().setup()

        def log_message(self, *args):
            pass  # Never log tokens, headers, URLs or request data.

        def do_GET(self):
            if self.server.delivered or self.path != "/connection.zip" or self.client_address[0] != allowed_host or self.headers.get("Origin") or self.headers.get("X-Lab-Setup") != "1":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            self.wfile.flush()
            self.server.delivered = True
            print("One-time package delivered to the configured Windows host.", flush=True)

    server = HTTPServer((host, port), Handler)
    server.timeout = 1
    server.delivered = False
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--plan", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--directory", type=Path, required=True)
    serve.add_argument("--seconds", type=int, default=1800)
    args = parser.parse_args()
    os.umask(0o077)
    if args.operation == "prepare":
        handoff = build(json.loads(args.plan.read_text()), args.output.resolve())
        print(json.dumps(handoff, ensure_ascii=False, indent=2))  # No credentials in this output.
    else:
        if not 1 <= args.seconds <= 1800:
            raise ValueError("Use a finite handoff of at most 30 minutes")
        transfer = json.loads((args.directory / "handoff.json").read_text())["transfer"]
        with handoff_server(args.directory / "connection.zip", transfer["host"], transfer["port"], transfer["allowedHost"]) as server:
            print("One-use Windows handoff ready; private source only; expires automatically.", flush=True)
            deadline = time.monotonic() + args.seconds
            while not server.delivered and time.monotonic() < deadline:
                server.handle_request()
            print("Handoff listener closed.", flush=True)


if __name__ == "__main__":
    main()
