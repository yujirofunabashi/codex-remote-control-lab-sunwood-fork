#!/usr/bin/env python3
"""Build a small offline installation medium, excluding host/phone credentials."""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import re

CONTROL = "/opt/agent-lab/control/phone-bridge"
UNIT = """[Unit]
Description=Owner-operated lab console, no automatic AI tasks
Requires=agent-lab-network-guard.service agent-lab-egress.service
After=cloud-config.service agent-lab-network-guard.service agent-lab-egress.service
[Service]
Type=simple
ExecCondition=/usr/bin/python3 -B /opt/agent-lab/control/phone-bridge/lab_guest.py --config /opt/agent-lab/control/phone-bridge/config.json --check-medium
ExecStart=/usr/bin/python3 -B /opt/agent-lab/control/phone-bridge/lab_guest.py --config /opt/agent-lab/control/phone-bridge/config.json
RuntimeMaxSec=1850
TimeoutStopSec=45
KillMode=control-group
UMask=0077
StandardOutput=null
StandardError=journal
[Install]
WantedBy=multi-user.target
"""


def guest_config(value):
    keys = {"workRoot", "user", "authDir", "stateDir", "codex", "model", "effort", "guardHelper", "guardSha256"}
    if set(value) != keys:
        raise ValueError("Guest configuration must contain only the explicit non-secret guest fields")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", value["user"]):
        raise ValueError("Invalid guest user")
    if value["workRoot"] != "/home/" + value["user"] + "/work" or value["authDir"] != "/home/" + value["user"] + "/.codex":
        raise ValueError("Unexpected guest work or authentication directory")
    if value["stateDir"] != "/var/lib/agent-lab/phone-bridge" or not value["codex"].startswith("/opt/agent-lab/tools/"):
        raise ValueError("Unexpected controller or executable path")
    if value["guardHelper"] != "/opt/agent-lab/control/prepare_owner_login.py" or not re.fullmatch(r"[a-f0-9]{64}", value["guardSha256"]):
        raise ValueError("The existing guest guard must be pinned")
    if not value["model"] or value["effort"] not in ("high", "xhigh", "max"):
        raise ValueError("Use an explicitly validated model and effort")
    return value


def build(output, instance, config, network):
    config = guest_config(config)
    if not re.fullmatch(r"agent-lab-phone-[a-z0-9-]{1,40}", instance):
        raise ValueError("A dedicated instance id is required")
    if set(network) != {"version", "ethernets"} or network["version"] != 2:
        raise ValueError("Reuse the verified guest network layout")
    source = Path(__file__).with_name("lab_guest.py")
    files = [
        {"path": CONTROL + "/lab_guest.py", "owner": "root:root", "permissions": "0644", "encoding": "b64", "content": base64.b64encode(source.read_bytes()).decode()},
        # Native execution stays off until the lab's current sandbox boundary
        # is independently verified and its owner authorizes the new workflow.
        {"path": CONTROL + "/config.json", "owner": "root:root", "permissions": "0600", "content": json.dumps(dict(config, instanceId=instance, aiExecutionVerified=False))},
        {"path": "/etc/systemd/system/phone-lab-bridge.service", "owner": "root:root", "permissions": "0644", "content": UNIT},
    ]
    cloud = {"users": [], "disable_root": True, "ssh_pwauth": False, "ssh_deletekeys": False, "ssh_genkeytypes": [],
             "package_update": False, "package_upgrade": False, "write_files": files,
             "runcmd": [["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "phone-lab-bridge.service"]],
             "final_message": "PHONE_LAB_INSTALLED: console availability is not an AI task or experiment completion."}
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    (output / "user-data").write_text("#cloud-config\n" + json.dumps(cloud, ensure_ascii=False, indent=2) + "\n")
    (output / "meta-data").write_text(json.dumps({"instance-id": instance, "local-hostname": "agent-lab"}) + "\n")
    (output / "network-config").write_text(json.dumps(network) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--guest-config", type=Path, required=True)
    parser.add_argument("--network-config", type=Path, required=True)
    args = parser.parse_args()
    build(args.output, args.instance_id, json.loads(args.guest_config.read_text()), json.loads(args.network_config.read_text()))
