const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const startPhone = path.join(__dirname, "start-phone.js");
const wsModule = path.join(__dirname, "..", "node_modules", "ws");

// The upstream URL is fixed when the module loads, so each case runs in its own
// process against a stub app-server. `fetch` is replaced before the module is
// required: the bridge reads real notification targets out of `.env`, and a
// test must never post to the channel the owner actually reads.
function notificationsFor(mode) {
  const script = `
    const { WebSocketServer } = require(${JSON.stringify(wsModule)});
    const sent = [];
    globalThis.fetch = async (url, options = {}) => {
      sent.push(String(options.body || ""));
      return { ok: true, status: 204, text: async () => "" };
    };
    const mode = ${JSON.stringify(mode)};
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("listening", () => {
      const port = wss.address().port;
      // A refused connection needs a port with nothing behind it, so the stub
      // server hands its port over and steps aside.
      const connect = () => {
        process.env.CODEX_APP_SERVER_URL = "ws://127.0.0.1:" + port;
        const { SharedBridge } = require(${JSON.stringify(startPhone)});
        wss.on("connection", (socket) => {
          if (mode === "dispose") bridge.dispose();
          else socket.close();
        });
        const bridge = new SharedBridge(null, "teardown-test", {});
        setTimeout(() => {
          process.stdout.write("RESULT" + JSON.stringify(sent) + "\\n");
          process.exit(0);
        }, 1500);
      };
      if (mode === "refused") wss.close(connect);
      else connect();
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PHONE_UI_PORT: "45998",
      PHONE_TOKEN: "test-token",
      PHONE_WORKDIR: os.tmpdir(),
      PHONE_NOTIFY_EVENTS: "1",
      PHONE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/test-fixture",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT"));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("RESULT".length));
}

test("a bridge we tear down ourselves does not announce a lost connection", () => {
  // Swapping folders, cleaning up an idle bridge and restarting all end in
  // dispose(), and dispose() closes the socket. Reported as 接続が切れました it
  // is a warning about a failure that did not happen, and it arrives while the
  // work it names keeps running on another bridge.
  assert.deepEqual(notificationsFor("dispose"), []);
});

test("a close nobody asked for is still announced once", () => {
  const sent = notificationsFor("close");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /接続が切れました/);
});

test("a connection that never opens is one message, not an error and a close", () => {
  // ws reports `error` and then `close` for a socket that was refused. They are
  // the same moment, and the reader was told about it twice.
  const sent = notificationsFor("refused");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /接続が切れました/);
});
