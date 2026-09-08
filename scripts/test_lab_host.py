from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import uuid
from lab_host import HostAgent, RelayClient, WindowsVM


class FakeDriver:
    def __init__(self, config, emit):
        self.ready, self.closed = True, False
        self.sent, self.network_calls = [], []

    def network(self, enabled):
        self.network_calls.append(enabled)

    def send(self, command):
        self.sent.append(command)

    def target(self):
        return {"vmState": "running", "guestReady": True}


class FakeClient:
    def __init__(self):
        self.posts, self.fail = [], False

    def post(self, operation, body):
        if self.fail:
            raise OSError("connection lost")
        self.posts.append((operation, body))
        return {}


class HostTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phone-lab-host-")
        self.config = {"stateFile": str(Path(self.temp.name) / "state.json")}
        self.client = FakeClient()
        self.host = HostAgent(self.config, driver_factory=FakeDriver, client=self.client)

    def tearDown(self):
        for timer in self.host.watchdogs.values():
            timer.cancel()
        self.temp.cleanup()

    def job(self):
        command = {"id": str(uuid.uuid4()), "op": "run", "args": {"prompt": "test"}}
        self.host.state["jobs"][command["id"]] = {"command": command}
        self.host.execute(command)
        return command

    def test_disconnect_before_durable_completion_and_retry_without_reexecution(self):
        job = self.job()
        self.host.messages.put({"id": job["id"], "result": {"ok": True, "data": {"text": "done"}}})
        self.client.fail = True
        with self.assertRaises(OSError):
            self.host.drain()
        self.assertEqual(self.host.driver.network_calls, [False, True, False])
        self.assertFalse(self.host.state["jobs"][job["id"]]["delivered"])
        self.client.fail = False
        restored = HostAgent(self.config, driver_factory=FakeDriver, client=self.client)
        restored.dispatch(job)
        restored.drain()
        self.assertEqual(restored.driver.sent, [])
        self.assertTrue(restored.state["jobs"][job["id"]]["delivered"])

    def test_no_response_watchdog_disconnects_and_requests_only_its_task_interruption(self):
        job = self.job()
        self.host.expire_run(job["id"])
        self.host.drain()
        self.assertFalse(self.host.driver.network_calls[-1])
        self.assertEqual(self.host.driver.sent[-1]["args"]["taskId"], job["id"])
        self.assertFalse(self.host.state["jobs"][job["id"]]["result"]["ok"])
        count = len(self.host.driver.network_calls)
        self.host.expire_run(job["id"])
        self.assertEqual(len(self.host.driver.network_calls), count)

    def test_completed_delivery_cannot_disconnect_a_later_task(self):
        first = self.job()
        result = {"id": first["id"], "result": {"ok": True}}
        self.host.messages.put(result)
        self.host.drain()
        second = self.job()
        count = len(self.host.driver.network_calls)
        self.host.messages.put(result)
        self.host.drain()
        self.assertEqual(self.host.network_task, second["id"])
        self.assertEqual(len(self.host.driver.network_calls), count)

    def test_untrusted_plain_http_and_redirect_targets_rejected(self):
        for url in ["http://example.com", "http://192.168.1.1:1234", "http://100.80.0.1/path", "http://user:secret@100.80.0.1", "file:///tmp/other"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                RelayClient(url, "worker-only")
        self.assertEqual(RelayClient("http://100.80.0.1:1234", "worker-only").base_url, "http://100.80.0.1:1234")

    def test_another_experiments_running_vm_is_never_claimed(self):
        class Guard:
            @staticmethod
            def require(value, message):
                if not value:
                    raise RuntimeError(message)
            @staticmethod
            def same_path(left, right):
                return left == right
        vm = WindowsVM.__new__(WindowsVM)
        vm.net = Guard()
        vm.config = {"seed": "lab-phone.iso", "previousSeed": "prior-experiment.iso"}
        with self.assertRaises(RuntimeError):
            vm.check_attachment({"State": "Running", "Dvd": "prior-experiment.iso"})
        with self.assertRaises(RuntimeError):
            vm.check_attachment({"State": "Off", "Dvd": "different-experiment.iso"})
        vm.check_attachment({"State": "Off", "Dvd": "prior-experiment.iso"})
        vm.check_attachment({"State": "Running", "Dvd": "lab-phone.iso"})

    def test_a_vm_start_interrupted_by_relay_restart_is_not_replayed(self):
        command = {"id": str(uuid.uuid4()), "op": "start", "args": {}}
        self.host.state["jobs"][command["id"]] = {"command": command}
        self.host.save()
        restored = HostAgent(self.config, driver_factory=FakeDriver, client=self.client)
        restored.dispatch(command)
        restored.drain()
        self.assertFalse(restored.state["jobs"][command["id"]]["result"]["ok"])
        self.assertEqual(restored.driver.sent, [])

    def test_read_only_guest_cannot_get_a_model_connection(self):
        vm = WindowsVM.__new__(WindowsVM)
        vm.ready, vm.ai_ready = True, False
        vm.net = Mock()
        vm.net.inspect.return_value = {"State": "Running"}
        def require(value, message):
            if not value:
                raise RuntimeError(message)
        vm.net.require.side_effect = require
        vm.check_attachment = Mock()
        with self.assertRaisesRegex(RuntimeError, "承認・実機検証"):
            vm.network(True)
        vm.net.ps.assert_not_called()
        vm.net.gateway_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
