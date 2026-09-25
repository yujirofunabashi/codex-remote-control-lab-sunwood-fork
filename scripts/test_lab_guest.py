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

from lab_guest import (WorkFiles, Guest, encode_frame, decode_frame, service_command, medium_is_current, main,
                       boundary_probe, probe_passed, probe_command, CLAUDE_PROXY_UNIT)
from build_lab_seed import build, build_upgrade, guest_config
import importlib.util


def config(root):
    return {"workRoot": str(root / "work"), "user": "agent-lab", "authDir": "/home/agent-lab/.codex",
            "stateDir": str(root / "control"), "codex": "/opt/agent-lab/tools/codex/bin/codex",
            "model": "gpt-6-astra", "effort": "xhigh", "guardHelper": "/opt/agent-lab/control/prepare_owner_login.py", "guardSha256": "a" * 64}


def with_claude(values):
    return dict(values, claude="/opt/agent-lab/tools/claude-2.1.267/claude", claudeSha256="b" * 64,
                claudeHome="/home/agent-lab/.claude-lab", claudeModel="claude-opus-5-5", claudeEffort="xhigh")


PASSED = {"work_write": True, "direct_network": False, "write:/etc": False, "read:/var/lib/agent-lab/phone-bridge": False}


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
        if "--safe-mode" in command:
            session = "22345678-1234-1234-1234-123456789abc"
            self.stdout = iter([
                json.dumps({"type": "system", "subtype": "init", "session_id": session}),
                json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "途中"}]}}),
                json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "Claudeで検査しました。", "session_id": session}),
            ])
            return
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
        self.config = with_claude(config(self.root))
        self.config["aiExecutionVerified"] = True  # Only this test's fake launcher.
        self.messages, self.commands = [], []
        def launch(command, **kwargs):
            self.commands.append(command)
            return FakeProcess(command, **kwargs)
        self.launch = launch
        self.guest = Guest(self.config, self.messages.append, guard=lambda: None, launch=launch, probe=lambda provider: PASSED)

    def tearDown(self):
        if self.guest.thread:
            self.guest.thread.join(3)
        self.guest.files.close()
        self.temp.cleanup()

    def request(self, task_id=None, thread_id=None, provider=None):
        args = {"prompt": "検査して", "threadId": thread_id or "lab-" + str(uuid.uuid4()), "workdir": self.config["workRoot"]}
        if provider:
            args["provider"] = provider
        return {"id": task_id or str(uuid.uuid4()), "op": "run", "args": args}

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
        restored = Guest(self.config, self.messages.append, guard=lambda: None, launch=lambda *a, **kw: self.fail("must not reexecute"), probe=lambda provider: PASSED)
        try:
            restored.handle(request)
            self.assertTrue(self.messages[-1]["result"]["ok"])
        finally:
            restored.files.close()

    def test_uncertain_restart_is_not_reexecuted(self):
        request = self.request()
        self.guest.state["tasks"][request["id"]] = {"startedAt": 1}
        self.guest.save()
        restored = Guest(self.config, self.messages.append, guard=lambda: None, launch=lambda *a, **kw: self.fail("must not reexecute"), probe=lambda provider: PASSED)
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

    def test_claude_turn_uses_its_own_login_proxy_and_resume(self):
        request = self.request(provider="claude")
        with patch("lab_guest.subprocess.run") as units:
            self.guest.handle(request)
            self.guest.thread.join(3)
        self.assertTrue(self.messages[-1]["result"]["ok"])
        self.assertEqual(self.messages[-1]["result"]["data"]["text"], "Claudeで検査しました。")
        self.assertEqual([call.args[0] for call in units.call_args_list],
                         [["systemctl", "start", CLAUDE_PROXY_UNIT], ["systemctl", "stop", CLAUDE_PROXY_UNIT]])
        command = self.commands[0]
        for item in ["--safe-mode", "--restricted", "--strict-mcp-config", "--no-chrome", "claude-opus-5-5",
                     "--setenv=HTTPS_PROXY=http://127.0.0.1:3129", "--setenv=CLAUDE_CONFIG_DIR=/home/agent-lab/.claude-lab",
                     "--property=ReadWritePaths=" + self.config["workRoot"] + " /home/agent-lab/.claude-lab"]:
            self.assertIn(item, command)
        self.assertIn("--property=InaccessiblePaths=-/home/agent-lab/.codex -" + self.config["stateDir"], command)
        self.assertEqual(command[command.index("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash")
        self.assertNotIn("bypassPermissions", command)
        self.assertFalse(any("3128" in item for item in command))
        with patch("lab_guest.subprocess.run"):
            self.guest.handle(self.request(thread_id=request["args"]["threadId"], provider="claude"))
            self.guest.thread.join(3)
        self.assertEqual(self.commands[1][self.commands[1].index("--resume") + 1], "22345678-1234-1234-1234-123456789abc")
        # A conversation keeps its AI; switching providers needs a new session.
        self.guest.handle(self.request(thread_id=request["args"]["threadId"], provider="codex"))
        self.assertFalse(self.messages[-1]["result"]["ok"])
        self.assertEqual(len(self.commands), 2)

    def test_codex_turn_hides_the_claude_login(self):
        command = service_command(self.config, str(uuid.uuid4()), self.config["workRoot"])
        self.assertIn("--property=InaccessiblePaths=-/home/agent-lab/.claude-lab -" + self.config["stateDir"], command)
        self.assertIn("--property=ReadWritePaths=" + self.config["workRoot"] + " /home/agent-lab/.codex", command)

    def test_failed_or_missing_boundary_probe_blocks_that_ai(self):
        results = {"codex": PASSED, "claude": dict(PASSED, **{"read:/home/agent-lab/.codex": True})}
        guest = Guest(self.config, self.messages.append, guard=lambda: None, launch=self.launch, probe=results.get)
        try:
            self.assertEqual(guest.identity()["providers"], ["codex"])
            self.assertTrue(guest.identity()["aiReady"])
            guest.handle(self.request(provider="claude"))
            self.assertFalse(self.messages[-1]["result"]["ok"])
            guest.handle(self.request(provider="other"))
            self.assertFalse(self.messages[-1]["result"]["ok"])
        finally:
            guest.files.close()
        def broken(provider):
            raise RuntimeError("probe could not run")
        guest = Guest(self.config, self.messages.append, guard=lambda: None, launch=self.launch, probe=broken)
        try:
            self.assertFalse(guest.identity()["aiReady"])
            self.assertEqual(guest.identity()["providers"], [])
        finally:
            guest.files.close()
        self.assertEqual(self.commands, [])

    def test_boundary_probe_reports_escapes(self):
        allowed, denied = self.root / "work", self.root / "denied"
        denied.mkdir()
        secret = self.root / "secret.json"
        secret.write_text("{}")
        spec = {"id": "c" * 32, "workRoot": str(allowed), "denyWrite": [str(denied)], "denyRead": [str(secret)]}
        with patch("socket.create_connection", side_effect=OSError("blocked")):
            result = boundary_probe(spec)
        # This test runs unconfined, so the "denied" paths are reachable and must fail the check.
        self.assertTrue(result["work_write"])
        self.assertTrue(result["write:" + str(denied)] and result["read:" + str(secret)])
        self.assertFalse(probe_passed(result))
        self.assertEqual(list(denied.iterdir()), [])
        self.assertTrue(probe_passed(PASSED))
        self.assertFalse(probe_passed({"work_write": True}))
        command = probe_command(self.config, "claude", "d" * 32)
        self.assertIn("--probe", command)
        self.assertIn("--property=InaccessiblePaths=-/home/agent-lab/.codex -" + self.config["stateDir"], command)
        with self.assertRaises(ValueError):
            probe_command(self.config, "claude", "../x")

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


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phone-lab-upgrade-")
        self.root = Path(self.temp.name)
        target = self.root / "seed"
        build_upgrade(target, "agent-lab-phone-claude-test", "claude-opus-5-5", "xhigh")
        self.cloud = json.loads((target / "user-data").read_text().split("\n", 1)[1])
        self.network = json.loads((target / "network-config").read_text())
        source = self.root / "upgrade.py"
        source.write_text(next(item["content"] for item in self.cloud["write_files"] if item["path"].endswith("/upgrade.py")))
        spec = importlib.util.spec_from_file_location("lab_upgrade_under_test", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.config_file = self.root / "config.json"
        self.installed = dict(config(Path("/")), workRoot="/home/agent-lab/work", stateDir="/var/lib/agent-lab/phone-bridge",
                              instanceId="agent-lab-phone-old", aiExecutionVerified=False)
        self.config_file.write_text(json.dumps(self.installed))
        self.console = []
        real_stat = os.stat
        def owned_by_root(path, **kwargs):
            info = real_stat(path, **kwargs)
            return SimpleNamespace(st_mode=(info.st_mode & ~0o077) if Path(path) == self.config_file else info.st_mode, st_uid=0)
        self.patches = [patch.object(self.module, "CONFIG", self.config_file), patch.object(self.module, "console", self.console.append),
                        patch.object(self.module.os, "stat", side_effect=owned_by_root)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def test_medium_replaces_code_only_and_uses_the_fixed_address(self):
        paths = [item["path"] for item in self.cloud["write_files"]]
        self.assertNotIn("/opt/agent-lab/control/phone-bridge/config.json", paths)
        self.assertFalse(any("/home/" in path for path in paths))
        self.assertEqual(self.cloud["users"], [])
        self.assertEqual(self.cloud["runcmd"][0], ["python3", "-B", "/opt/agent-lab/control/phone-bridge/upgrade.py"])
        labnet = self.network["ethernets"]["labnet"]
        self.assertEqual((labnet["addresses"], labnet["dhcp4"]), (["192.168.240.2/20"], False))
        self.assertEqual(labnet["routes"], [{"to": "default", "via": "192.168.240.1"}])
        with self.assertRaises(ValueError):
            build_upgrade(self.root / "other", "agent-lab-phone-x", "gpt-6", "xhigh")

    def test_settings_are_kept_and_claude_added_only_when_verified(self):
        with patch.object(self.module, "claude_available", return_value="binary differs from the verified release"):
            self.module.upgrade()
        upgraded = json.loads(self.config_file.read_text())
        self.assertEqual({key: upgraded[key] for key in ("user", "codex", "model", "effort", "guardSha256")},
                         {key: self.installed[key] for key in ("user", "codex", "model", "effort", "guardSha256")})
        self.assertEqual((upgraded["instanceId"], upgraded["aiExecutionVerified"]), ("agent-lab-phone-claude-test", True))
        self.assertNotIn("claude", upgraded)
        self.assertIn("unavailable", self.console[-1])
        with patch.object(self.module, "claude_available", return_value=""):
            self.module.upgrade()
        upgraded = json.loads(self.config_file.read_text())
        self.assertEqual(upgraded["claudeModel"], "claude-opus-5-5")
        self.assertEqual(upgraded["claudeHome"], "/home/agent-lab/.claude-lab")
        self.assertEqual(self.console[-1], "PHONE_LAB_UPGRADED: claude=added")

    def test_unexpected_installed_settings_are_not_rewritten(self):
        for change in ({"workerToken": "x"}, {"user": "other"}):
            self.config_file.write_text(json.dumps(dict(self.installed, **change)))
            before = self.config_file.read_text()
            with self.assertRaises(RuntimeError):
                self.module.upgrade()
            self.assertEqual(self.config_file.read_text(), before)


if __name__ == "__main__":
    unittest.main()
