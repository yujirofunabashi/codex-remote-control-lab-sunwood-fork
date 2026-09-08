// The phone remembers a cwd per thread. When that folder does not exist on this
// machine — a thread opened on one Mac and reopened on another, or a worktree
// since deleted — validating it as a hard requirement killed the socket, and
// the phone reconnected straight into the same failure.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

process.env.PHONE_UI_PORT = "45245";
process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";

const { bindBrowser } = require("./start-phone");

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

function fakeBridge(seen) {
  return {
    workdir: "/home/somewhere",
    addClient() {},
    emitTo(client, type, payload) {
      seen.push({ type, ...payload });
    },
  };
}

async function bind(browser, workdir, seen, requested = []) {
  return bindBrowser(browser, "private-token", "some-thread", "claude", { workdir }, {
    async ensureCodexServerRunning() {},
    getBridge(threadId, provider, connectionId, options) {
      requested.push(options.workdir);
      return fakeBridge(seen);
    },
  });
}

test("a remembered folder that is gone does not take the connection down with it", async () => {
  const browser = new FakeBrowser();
  const seen = [];
  const requested = [];

  await bind(browser, path.join(os.homedir(), "gone-with-the-worktree"), seen, requested);

  assert.equal(browser.closeCalls, 0, "the socket must stay open");
  assert.deepEqual(browser.messages, [], "closing here is what produced a reconnect loop");
  assert.equal(requested[0], "", "the unusable hint is dropped rather than passed on");
});

test("dropping the folder is reported rather than silently working elsewhere", async () => {
  const seen = [];
  await bind(new FakeBrowser(), "/etc", seen);

  const status = seen.find((entry) => entry.type === "status");
  assert.ok(status, "the browser must be told which folder it actually got");
  assert.match(status.text, /作業場所/);
  assert.match(status.text, /\/home\/somewhere/);
});

test("a folder that exists is still passed through untouched", async () => {
  const real = os.homedir();
  const seen = [];
  const requested = [];
  await bind(new FakeBrowser(), real, seen, requested);
  assert.equal(requested[0], real);
  assert.equal(seen.filter((entry) => entry.type === "status").length, 0, "nothing to report when the folder is usable");
});

test("no folder asked for is not a problem to report", async () => {
  const seen = [];
  const requested = [];
  await bind(new FakeBrowser(), "", seen, requested);
  assert.equal(requested[0], "");
  assert.equal(seen.filter((entry) => entry.type === "status").length, 0);
});

for (const provider of ["codex", "claude"]) {
  test(`a missing new ${provider} folder never falls back to the default project`, async () => {
    const browser = new FakeBrowser();
    let resolved = false;
    await bindBrowser(browser, "fixture-token", null, provider, { fresh: true, workdir: "/not-an-allowed-project" }, {
      async ensureCodexServerRunning() {},
      getBridge() { resolved = true; return fakeBridge([]); },
    });
    assert.equal(resolved, false, "no conversation may be created in another folder");
    assert.equal(browser.messages[0]?.type, "error");
    assert.equal(browser.messages[0]?.code, "invalid_new_session_workdir");
    assert.equal(browser.messages[0]?.retryable, false);
    assert.equal(browser.closeCalls, 1);
  });
}
