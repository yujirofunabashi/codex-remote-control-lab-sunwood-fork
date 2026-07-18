const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");

delete process.env.CODEX_APP_SERVER_URL;
delete process.env.CODEX_APP_SERVER_SOCK;
process.env.PHONE_UI_PORT = "45244";

const { bindBrowser } = require("./start-phone");
const { CAPACITY_PROTECTION_MESSAGE, StorageCapacityProtectionError } = require("./storage-capacity-gate");

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.messages = [];
    this.closeCalls = 0;
  }

  send(message) {
    this.messages.push(JSON.parse(message));
  }

  close() {
    this.closeCalls += 1;
  }
}

test("capacity rejection closes browser before app-server or bridge mutation", async () => {
  const browser = new FakeBrowser();
  const calls = [];

  await bindBrowser(browser, "private-token", "existing-thread", "codex", {}, {
    assertStorageCapacityIngress(port, ingress) {
      calls.push(["gate", port, ingress]);
      throw new StorageCapacityProtectionError();
    },
    async ensureCodexServerRunning() {
      calls.push(["ensure"]);
    },
    getBridge() {
      calls.push(["bridge"]);
      throw new Error("getBridge must not run after capacity rejection");
    },
  });

  assert.deepEqual(calls, [["gate", 45244, "prompt"]]);
  assert.deepEqual(browser.messages, [
    {
      type: "error",
      text: CAPACITY_PROTECTION_MESSAGE,
      code: "storage_capacity_protected",
      retryable: true,
    },
  ]);
  assert.equal(browser.closeCalls, 1);
  assert.equal(browser.listenerCount("message"), 0);
});
