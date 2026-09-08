import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock
import urllib.error
import urllib.request
import zipfile

from lab_connection_setup import build, handoff_server, private_ip
from lab_install_host import inspect_bundle, install


def plan(root):
    return {"instanceId": "agent-lab-phone-setup-test", "relay": {"id": "lab", "targetHost": "fixture",
            "host": "127.0.0.1", "port": 45245, "workRoot": "/home/agent-lab/work", "model": "gpt-6-astra", "effort": "xhigh", "allowedOrigins": []},
            "guest": {"workRoot": "/home/agent-lab/work", "user": "agent-lab", "authDir": "/home/agent-lab/.codex",
                      "stateDir": "/var/lib/agent-lab/phone-bridge", "codex": "/opt/agent-lab/tools/codex/bin/codex",
                      "model": "gpt-6-astra", "effort": "xhigh", "guardHelper": "/opt/agent-lab/control/prepare_owner_login.py", "guardSha256": "a" * 64},
            "network": {"version": 2, "ethernets": {"labnet": {"dhcp4": True}}},
            "windows": {"directory": str(root / "phone-bridge-test"), "guardHelper": str(root / "guard.py"), "guardSha256": "b" * 64,
                        "previousSeed": str(root / "prior.iso"), "previousSeedSha256": hashlib.sha256(b"prior").hexdigest()},
            "transfer": {"host": "127.0.0.1", "allowedHost": "127.0.0.1", "port": 18770}}


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phone-lab-setup-")
        self.root = Path(self.temp.name).resolve()
        self.output = self.root / "private" / "prepared"
        self.plan = plan(self.root)
        self.handoff = build(self.plan, self.output, make_iso=lambda source, target: target.write_bytes(b"fixture iso"))

    def tearDown(self):
        self.temp.cleanup()

    def test_bundle_omits_phone_credential_and_guest_is_read_only_first(self):
        relay = json.loads((self.output / "relay.json").read_text())
        with zipfile.ZipFile(self.output / "connection.zip") as bundle:
            host = inspect_bundle(bundle)
            self.assertNotEqual(host["workerToken"], relay["phoneToken"])
            self.assertEqual(host["workerToken"], relay["workerToken"])
            self.assertFalse(any(relay["phoneToken"].encode() in bundle.read(name) for name in bundle.namelist()))
        seed = (self.output / "seed" / "user-data").read_text()
        self.assertNotIn(relay["workerToken"], seed)
        self.assertNotIn(relay["phoneToken"], seed)
        config = json.loads(json.loads(seed.split("\n", 1)[1])["write_files"][1]["content"])
        self.assertIs(config["aiExecutionVerified"], False)
        self.assertNotIn(relay["workerToken"], self.handoff["command"])
        self.assertIn(self.handoff["bundleSha256"], self.handoff["command"])
        self.assertIn("ProxyHandler({})", self.handoff["command"])
        for name in ("relay.json", "connection.zip", "handoff.json"):
            self.assertEqual((self.output / name).stat().st_mode & 0o077, 0)
        with self.assertRaises(FileExistsError):
            build(self.plan, self.output)

    def test_install_preserves_old_medium_and_never_runs_vm_commands(self):
        (self.root / "prior.iso").write_bytes(b"prior")
        net = Mock(ROOT=self.root)
        net.inspect.return_value = {"State": "Off", "Switch": "", "Dvd": str(self.root / "prior.iso")}
        net.same_path.side_effect = lambda a, b: str(a) == str(b)
        protect = Mock()
        with zipfile.ZipFile(self.output / "connection.zip") as bundle:
            host = inspect_bundle(bundle)
            target = install(bundle, host, net, protect)
            self.assertEqual(set(path.name for path in target.iterdir()), {"host.json", "lab_host.py", "lab_guest.py", "seed.iso"})
            protect.assert_called_once_with(target)
            net.ps.assert_not_called()
            self.assertEqual((self.root / "prior.iso").read_bytes(), b"prior")
            with self.assertRaises(FileExistsError):
                install(bundle, host, net, protect)

    def test_active_changed_or_linked_experiment_is_not_installed(self):
        prior = self.root / "prior.iso"
        prior.write_bytes(b"prior")
        net = Mock(ROOT=self.root)
        net.same_path.side_effect = lambda a, b: str(a) == str(b)
        with zipfile.ZipFile(self.output / "connection.zip") as bundle:
            host = inspect_bundle(bundle)
            for state in ({"State": "Running", "Switch": "", "Dvd": str(prior)},
                          {"State": "Off", "Switch": "Default Switch", "Dvd": str(prior)},
                          {"State": "Off", "Switch": "", "Dvd": "another.iso"}):
                net.inspect.return_value = state
                with self.assertRaises(RuntimeError):
                    install(bundle, host, net, Mock())
                self.assertFalse((self.root / "phone-bridge-test").exists())
            net.inspect.return_value = {"State": "Off", "Switch": "", "Dvd": str(prior)}
            prior.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "content changed"):
                install(bundle, host, net, Mock())
            prior.write_bytes(b"prior")
            (self.root / "phone-bridge-test").symlink_to(self.output)
            with self.assertRaisesRegex(RuntimeError, "Linked"):
                install(bundle, host, net, Mock())
        net.ps.assert_not_called()

    def test_transfer_is_private_header_protected_and_one_use(self):
        with handoff_server(self.output / "connection.zip", "127.0.0.1", 0, "127.0.0.1") as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            url = "http://127.0.0.1:" + str(server.server_port) + "/connection.zip"
            try:
                for headers, path in (({}, url), ({"X-Lab-Setup": "1", "Origin": "https://outside.invalid"}, url), ({"X-Lab-Setup": "1"}, url + "?key=anything")):
                    with self.assertRaises(urllib.error.HTTPError) as result:
                        opener.open(urllib.request.Request(path, headers=headers))
                    self.assertEqual(result.exception.code, 404)
                    result.exception.close()
                with opener.open(urllib.request.Request(url, headers={"X-Lab-Setup": "1"})) as response:
                    self.assertEqual(hashlib.sha256(response.read()).hexdigest(), self.handoff["bundleSha256"])
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                with self.assertRaises(urllib.error.HTTPError) as repeated:
                    opener.open(urllib.request.Request(url, headers={"X-Lab-Setup": "1"}))
                repeated.exception.close()
            finally:
                server.shutdown()
                worker.join(2)
        for address in ("0.0.0.0", "192.168.1.1", "8.8.8.8"):
            with self.assertRaises(ValueError):
                private_ip(address)


if __name__ == "__main__":
    unittest.main()
