import base64
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from lab_guest import WorkFiles, Guest, encode_frame, decode_frame, service_command, medium_is_current, main
from build_lab_seed import build, guest_config


def config(root):
    return {"workRoot": str(root / "work"), "user": "agent-lab", "authDir": "/home/agent-lab/.codex",
            "stateDir": str(root / "control"), "codex": "/opt/agent-lab/tools/codex/bin/codex",
            "model": "gpt-6-astra", "effort": "xhigh", "guardHelper": "/opt/agent-lab/control/prepare_owner_login.py", "guardSha256": "a" * 64}


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phone-lab-files-")
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.work.mkdir()
        self.files = WorkFiles(self.work)

    def tearDown(self):
        self.files.close()
        self.temp.cleanup()

    def test_browse_read_unicode_and_snapshot(self):
        folder = self.work / "計画 & $内容"
        folder.mkdir()
        (folder / "report.md").write_text("# 検査結果\n下書きです")
        self.assertEqual(self.files.browse(str(self.work))["entries"][0]["path"], str(folder))
        self.assertEqual(self.files.read(str(folder / "report.md"))["kind"], "markdown")
        self.assertEqual(len(self.files.snapshot()["artifacts"]), 1)

    def test_outside_hidden_symlinks_hardlinks_devices_and_large_files_refused(self):
        secret = self.root / "secret.txt"
        secret.write_text("not a lab file")
        (self.work / "linked.txt").symlink_to(secret)
        (self.work / "linked-directory").symlink_to(self.root)
        (self.work / ".hidden").write_text("hidden")
        (self.work / "large.txt").write_bytes(b"a" * 80001)
        (self.work / "binary.txt").write_bytes(b"a\0b")
        os.link(secret, self.work / "hard.txt")
        os.mkfifo(self.work / "pipe.txt")
        for value in [str(secret), str(self.work) + "/../secret.txt", str(self.work / "linked.txt"), str(self.work / "linked-directory" / "secret.txt"), str(self.work / ".hidden"), str(self.work / "large.txt"), str(self.work / "binary.txt"), str(self.work / "hard.txt"), str(self.work / "pipe.txt")]:
            with self.subTest(value=value), self.assertRaises((ValueError, OSError)):
                self.files.read(value)

    def test_replaced_root_is_not_followed(self):
        self.work.rename(self.root / "old-work")
        self.work.mkdir()
        with self.assertRaises(ValueError):
            self.files.browse(str(self.work))

    def test_frames_are_data_not_commands(self):
        value = {"id": str(uuid.uuid4()), "op": "read", "args": {"path": "引用'\"\n日本語"}}
        self.assertEqual(decode_frame(encode_frame(value)), value)
        for data in [b"boot message", b"PHONE_LAB_V1 !!!", b"PHONE_LAB_V1 " + base64.b64encode(b"[]")]:
            with self.assertRaises((ValueError, UnicodeError)):
                decode_frame(data)
        with self.assertRaises(ValueError):
            encode_frame({"text": "a" * 400000})


class FakeProcess:
    def __init__(self, command, **kwargs):
        self.command = command
        self.stdin = io.StringIO()
        self.stdout = iter([
            json.dumps({"type": "thread.started", "thread_id": "12345678-1234-1234-1234-123456789abc"}),
            json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "検査が終わりました。"}}),
            json.dumps({"type": "turn.completed"}),
        ])

    def wait(self, timeout=None):
        return 0


class GuestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phone-lab-guest-")
        self.root = Path(self.temp.name)
        (self.root / "work").mkdir()
        self.config = config(self.root)
        self.config["aiExecutionVerified"] = True  # Only this test's fake launcher.
        self.messages, self.commands = [], []
        def launch(command, **kwargs):
            self.commands.append(command)
            return FakeProcess(command, **kwargs)
        self.guest = Guest(self.config, self.messages.append, guard=lambda: None, launch=launch)

    def tearDown(self):
        if self.guest.thread:
            self.guest.thread.join(3)
        self.guest.files.close()
        self.temp.cleanup()

    def request(self, task_id=None, thread_id=None):
        return {"id": task_id or str(uuid.uuid4()), "op": "run", "args": {"prompt": "検査して", "threadId": thread_id or "lab-" + str(uuid.uuid4()), "workdir": self.config["workRoot"]}}

    def test_reading_does_not_authorize_native_ai_execution(self):
        for value in (None, False, "true"):
            self.config["aiExecutionVerified"] = value
            self.assertTrue(self.guest.identity()["ready"])
            self.assertFalse(self.guest.identity()["aiReady"])
            self.guest.handle(self.request())
            self.assertFalse(self.messages[-1]["result"]["ok"])
        self.assertEqual(self.commands, [])
        self.assertEqual(self.guest.state["tasks"], {})

    def test_persistent_deduplication_and_native_resume(self):
        request = self.request()
        self.guest.handle(request)
        self.guest.thread.join(3)
        self.guest.handle(request)
        self.assertEqual(len(self.commands), 1)
        self.assertTrue(self.messages[-1]["result"]["ok"])
        next_request = self.request(thread_id=request["args"]["threadId"])
        self.guest.handle(next_request)
        self.guest.thread.join(3)
        self.assertIn("resume", self.commands[1])
        restored = Guest(self.config, self.messages.append, guard=lambda: None, launch=lambda *a, **kw: self.fail("must not reexecute"))
        try:
            restored.handle(request)
            self.assertTrue(self.messages[-1]["result"]["ok"])
        finally:
            restored.files.close()

    def test_uncertain_restart_is_not_reexecuted(self):
        request = self.request()
        self.guest.state["tasks"][request["id"]] = {"startedAt": 1}
        self.guest.save()
        restored = Guest(self.config, self.messages.append, guard=lambda: None, launch=lambda *a, **kw: self.fail("must not reexecute"))
        try:
            restored.handle(request)
            self.assertFalse(self.messages[-1]["result"]["ok"])
            self.assertTrue(self.messages[-1]["result"]["data"]["interrupted"])
        finally:
            restored.files.close()

    def test_explicit_owner_only_policy_and_system_boundary(self):
        command = service_command(self.config, str(uuid.uuid4()), self.config["workRoot"] + "/計画 $name")
        for item in ["--expand-environment=no", "--property=Type=exec", "--property=PrivateDevices=yes", "--property=NoNewPrivileges=yes", "--property=RuntimeMaxSec=600", "--property=ProtectSystem=strict", "--property=RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK", "--ignore-user-config", "workspace-write", 'forced_login_method="chatgpt"', "sandbox_workspace_write.network_access=false"]:
            self.assertIn(item, command)
        self.assertNotIn("--ephemeral", command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)
        with self.assertRaises(ValueError):
            service_command(self.config, "../other-unit", self.config["workRoot"])

    def test_bad_output_stops_only_its_owned_unit(self):
        def launch(*args, **kwargs):
            process = FakeProcess(*args, **kwargs)
            process.stdout = iter(["not json"])
            return process
        self.guest.launch = launch
        request = self.request()
        with patch("lab_guest.subprocess.run") as stop:
            self.guest.handle(request)
            self.guest.thread.join(3)
            self.assertEqual(stop.call_args.args[0], ["systemctl", "stop", "phone-lab-turn-" + request["id"]])
        self.assertFalse(self.messages[-1]["result"]["ok"])

    def test_shutdown_does_not_accept_a_new_turn_or_report_failed_shutdown_as_success(self):
        request = {"id": str(uuid.uuid4()), "op": "shutdown", "args": {}}
        with patch("lab_guest.subprocess.run", side_effect=OSError("shutdown failed")):
            self.guest.handle(request)
        self.assertFalse(self.messages[-1]["result"]["ok"])
        self.assertFalse(self.guest.stopping)
        with patch("lab_guest.subprocess.run"):
            self.guest.handle(request)
        self.assertTrue(self.guest.stopping)
        self.guest.handle(self.request())
        self.assertFalse(self.messages[-1]["result"]["ok"])
        self.assertEqual(self.commands, [])


class SeedTest(unittest.TestCase):
    def test_wrong_medium_exits_before_any_console_or_shutdown_operation(self):
        with tempfile.TemporaryDirectory(prefix="phone-lab-start-") as temp:
            settings = Path(temp) / "config.json"
            settings.write_text("{}")
            with patch("lab_guest.sys.argv", ["lab_guest.py", "--config", str(settings)]), \
                 patch("lab_guest.Path.stat", return_value=SimpleNamespace(st_uid=0, st_mode=0o100600)), \
                 patch("lab_guest.medium_is_current", return_value=False), \
                 patch("lab_guest.subprocess.run") as commands, patch("lab_guest.os.open") as opened:
                with self.assertRaisesRegex(RuntimeError, "別の実験"):
                    main()
                commands.assert_not_called()
                opened.assert_not_called()

    def test_other_experiment_medium_never_starts_receiver(self):
        with tempfile.TemporaryDirectory(prefix="phone-lab-medium-") as temp:
            source = Path(temp) / "instance-id"
            values = {"instanceId": "agent-lab-phone-test"}
            source.write_text("agent-lab-phone-test\n")
            # Ownership is checked in production; emulate the root-owned cloud
            # record without making tests write anywhere outside their fixture.
            info = source.stat()
            protected = SimpleNamespace(st_mode=info.st_mode & ~0o022, st_uid=0, st_size=info.st_size)
            with patch("lab_guest.os.fstat", return_value=protected), patch("lab_guest.read_medium_instance", return_value="agent-lab-phone-test") as medium:
                self.assertTrue(medium_is_current(values, source))
                medium.return_value = "agent-lab-internal-report-10"
                self.assertFalse(medium_is_current(values, source))
                medium.side_effect = OSError("no CD")
                self.assertFalse(medium_is_current(values, source))
                medium.side_effect = None
                medium.return_value = "agent-lab-phone-test"
                source.write_text("agent-lab-internal-report-10\n")
                self.assertFalse(medium_is_current(values, source))
                self.assertFalse(medium_is_current({}, source))
                alias = Path(temp) / "alias"
                alias.symlink_to(source)
                self.assertFalse(medium_is_current(values, alias))
            with patch("lab_guest.os.fstat", return_value=SimpleNamespace(st_mode=info.st_mode, st_uid=501, st_size=info.st_size)):
                self.assertFalse(medium_is_current(values, source))
            self.assertFalse(medium_is_current(values, Path(temp) / "missing"))

    def test_no_credentials_bootstrapping_or_ai_turns_in_new_medium(self):
        with tempfile.TemporaryDirectory(prefix="phone-lab-seed-") as temp:
            values = config(Path(temp))
            values.update(workRoot="/home/agent-lab/work", stateDir="/var/lib/agent-lab/phone-bridge")
            target = Path(temp) / "seed"
            network = {"version": 2, "ethernets": {"labnet": {"dhcp4": True}}}
            build(target, "agent-lab-phone-test", values, network)
            cloud = json.loads((target / "user-data").read_text().split("\n", 1)[1])
            self.assertEqual(cloud["users"], [])
            self.assertFalse(cloud["ssh_deletekeys"])
            self.assertEqual(len(cloud["write_files"]), 3)
            installed = json.loads(cloud["write_files"][1]["content"])
            self.assertEqual(installed["instanceId"], "agent-lab-phone-test")
            self.assertIs(installed["aiExecutionVerified"], False)
            unit = cloud["write_files"][2]["content"]
            self.assertIn("After=cloud-config.service ", unit)
            self.assertIn("ExecCondition=", unit)
            self.assertIn("--check-medium", unit)
            self.assertNotIn("Conflicts=", unit)
            self.assertFalse(any("/home/" in entry["path"] for entry in cloud["write_files"]))
            self.assertEqual(cloud["runcmd"], [["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "phone-lab-bridge.service"]])
            with self.assertRaises(FileExistsError):
                build(target, "agent-lab-phone-test", values, network)
            with self.assertRaises(ValueError):
                guest_config(dict(values, workerToken="do-not-copy"))


if __name__ == "__main__":
    unittest.main()
