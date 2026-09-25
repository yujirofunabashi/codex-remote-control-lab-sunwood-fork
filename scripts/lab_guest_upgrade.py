#!/usr/bin/env python3
"""Run once by cloud-init inside the guest: keep the installed lab settings, adopt the new medium and add Claude.

The existing controller configuration stays the source of truth for the user, work root, Codex path,
model and guard. Claude is added only when the verified release and its separate login directory are
already present; otherwise the lab keeps working with Codex alone.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import sys

CONTROL = Path("/opt/agent-lab/control/phone-bridge")
CONFIG = CONTROL / "config.json"
SETTINGS = {}  # Pinned by the trusted builder.
KEYS = {"workRoot", "user", "authDir", "stateDir", "codex", "model", "effort", "guardHelper", "guardSha256",
        "instanceId", "aiExecutionVerified"}
CLAUDE_KEYS = {"claude", "claudeSha256", "claudeHome", "claudeModel", "claudeEffort"}


def console(message):
    with open("/dev/console", "w") as output:
        output.write(message + "\n")


def claude_available(config):
    binary, home = Path(SETTINGS["claude"]), Path(SETTINGS["claudeHome"])
    try:
        owner = pwd.getpwnam(config["user"]).pw_uid
        info = os.stat(binary, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            return "binary is not a protected regular file"
        with binary.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != SETTINGS["claudeSha256"]:
                return "binary differs from the verified release"
        info = os.stat(home, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
            return "login directory missing, not owned by the lab user, or writable by others"
    except (OSError, KeyError) as error:
        return type(error).__name__
    return ""


def upgrade():
    info = os.stat(CONFIG, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError("installed lab configuration is not protected")
    config = json.loads(CONFIG.read_text())
    if not KEYS <= set(config) or set(config) - KEYS - CLAUDE_KEYS:
        raise RuntimeError("installed lab configuration has unexpected fields")
    if config["user"] != "agent-lab" or config["workRoot"] != "/home/agent-lab/work":
        raise RuntimeError("unexpected lab user")
    config = {key: value for key, value in config.items() if key not in CLAUDE_KEYS}
    reason = claude_available(config)
    if not reason:
        config.update({key: SETTINGS[key] for key in CLAUDE_KEYS})
    # Owner-approved on 2026-09-25. Each boot still re-checks confinement before any AI turn.
    config.update(instanceId=SETTINGS["instanceId"], aiExecutionVerified=True)
    temporary = CONFIG.with_name("config.json.upgrade")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(config, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, CONFIG)
    console("PHONE_LAB_UPGRADED: claude=" + ("added" if not reason else "unavailable (" + reason + ")"))


if __name__ == "__main__":
    try:
        upgrade()
    except Exception as error:
        console("PHONE_LAB_UPGRADE_FAILED: " + str(error)[:200])
        sys.exit(1)
