"""One owner-operated install of a hash-pinned bundle; never boots the VM."""
import ctypes
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

FILES = {"install.py", "lab_host.py", "lab_guest.py", "host.json", "seed.iso"}


def require(value, message):
    if not value:
        raise RuntimeError(message)


def unlinked(path):
    for item in (path, *path.parents):
        require(not item.is_symlink() and not getattr(item, "is_junction", lambda: False)(),
                "Linked installation paths are not allowed")


def inspect_bundle(bundle):
    require(len(bundle.infolist()) == len(FILES) and set(bundle.namelist()) == FILES, "Unexpected package files")
    require(all(item.file_size <= 4 * 1024 * 1024 for item in bundle.infolist()), "Package file is too large")
    config = json.loads(bundle.read("host.json"))
    for field, name in (("guestSha256", "lab_guest.py"), ("seedSha256", "seed.iso")):
        require(hashlib.sha256(bundle.read(name)).hexdigest() == config[field], "Package content mismatch")
    return config


def install(bundle, config, net, protect):
    current = net.inspect()
    net.validate_acl(current)
    require(current["State"] == "Off" and not current["Switch"], "Pause the other task: VM must be Off and disconnected")
    require(net.same_path(current["Dvd"], config["previousSeed"]), "Previous experiment medium changed")
    previous = Path(config["previousSeed"])
    unlinked(previous)
    require(hashlib.sha256(previous.read_bytes()).hexdigest() == config["previousSeedSha256"], "Previous medium content changed")
    target = Path(config["seed"]).parent
    unlinked(target)
    require(net.same_path(target.parent, net.ROOT) and re.fullmatch(r"phone-bridge-[a-z0-9-]{1,40}", target.name), "Unexpected installation directory")
    require(net.same_path(config["seed"], target / "seed.iso") and net.same_path(config["stateFile"], target / "host-state.json"), "Unexpected installation paths")
    # A previous attempt is evidence, never overwrite or clean it automatically.
    target.mkdir(exist_ok=False)
    protect(target)
    for name in ("lab_host.py", "lab_guest.py", "host.json", "seed.iso"):
        with (target / name).open("xb") as output:
            output.write(bundle.read(name))
    after = net.inspect()
    net.validate_acl(after)
    require(after["State"] == "Off" and not after["Switch"] and net.same_path(after["Dvd"], current["Dvd"]), "Experiment changed during preparation; connection was not started")
    return target


def protect_directory(target):
    # New directory only. Existing Windows/lab permissions are never changed.
    subprocess.run(["icacls.exe", str(target), "/inheritance:r", "/grant:r",
                    "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
                   check=True, capture_output=True, timeout=20)
    escaped = str(target).replace("'", "''")
    query = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath '" + escaped + "'; " + r"""
$rules=@($a.Access)
$ok=$a.AreAccessRulesProtected -and $rules.Count -eq 2
$ids=@()
foreach($r in $rules) {
  $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $ids+=$sid
  $ok=$ok -and $r.AccessControlType -eq 'Allow' -and -not $r.IsInherited -and $r.FileSystemRights -eq 'FullControl'
}
$ok=$ok -and $ids.Contains('S-1-5-18') -and $ids.Contains('S-1-5-32-544')
[Console]::WriteLine($ok)
"""
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query],
                            check=True, capture_output=True, text=True, timeout=20)
    require(result.stdout.strip() == "True", "Private connection directory permissions could not be verified")


def bootstrap(bundle):
    require(sys.platform == "win32" and ctypes.windll.shell32.IsUserAnAdmin(), "Use the existing administrator Windows PowerShell")
    config = inspect_bundle(bundle)
    helper = Path(config["guardHelper"])
    unlinked(helper)
    require(hashlib.sha256(helper.read_bytes()).hexdigest() == config["guardSha256"], "Original Windows guard changed")
    spec = importlib.util.spec_from_file_location("lab_install_guard", helper)
    net = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(net)
    target = install(bundle, config, net, protect_directory)
    print("Connection files prepared. Previous experiment and VM state preserved.", flush=True)
    print("Keep this window open. No VM boot or AI task is requested by this command.", flush=True)
    return subprocess.call([sys.executable, "-B", str(target / "lab_host.py"), "--config", str(target / "host.json")])


if "lab_bundle" in globals():
    raise SystemExit(bootstrap(lab_bundle))
