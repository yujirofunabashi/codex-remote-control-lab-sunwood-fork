// `/clear` answers with nothing at all. The CLI forks a clean session and the
// bridge adopts the new id, so without help the phone keeps showing a
// conversation the model can no longer see - and says nothing about it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-clear-"));
const stubBin = path.join(stubRoot, "claude-stub.js");

// Stands in for the real CLI: it answers a `/clear` the way that one does, with
// a fresh session id and an empty result, and answers anything else in the
// session it was resumed in.
fs.writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "session-first";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "system", subtype: "init", session_id: resumed, slash_commands: ["clear", "context"], skills: [] });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const cleared = JSON.stringify(JSON.parse(line)).includes("/clear");
    const session = cleared ? "session-cleared" : resumed;
    emit({ type: "result", subtype: "success", is_error: false, result: cleared ? "" : "ok", session_id: session });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.CLAUDE_BIN = stubBin;

const { ClaudeBridge } = require("./start-phone");

const fullAccess = { approvalPolicy: "never", sandboxMode: "danger-full-access" };

function fakeClient() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(body) {
      sent.push(JSON.parse(body));
    },
    on() {},
  };
}

function turnCompleted(client, count = 1) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const completed = client.sent.filter((msg) => msg.type === "turn" && msg.status === "completed").length;
      if (completed >= count) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`expected ${count} completed turns, saw ${completed}`));
      }
    }, 20);
  });
}

test("a cleared conversation is dropped from the phone, and said out loud", async () => {
  const bridge = new ClaudeBridge(null, "clear-said");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("覚えておいて", [], fullAccess);
    await turnCompleted(client);
    assert.ok(bridge.history.length, "the first turn should leave something to forget");

    bridge.prompt("/clear", [], fullAccess);
    await turnCompleted(client, 2);

    assert.deepEqual(
      bridge.history.filter((entry) => entry.type !== "status"),
      [],
      "the transcript outlived the memory it described",
    );
    assert.equal(bridge.claudeSessionId, "session-cleared");
    const said = client.sent.filter((msg) => msg.type === "status").map((msg) => msg.text);
    assert.ok(
      said.some((text) => text.includes("リセット")),
      `nothing told the operator the memory was gone: ${JSON.stringify(said)}`,
    );
    // Saying it once to whoever was watching is not saying it: coming back to
    // the chat redraws from the history, and an empty chat with no line
    // explaining it reads as the conversation having been lost.
    assert.ok(
      bridge.history.some((entry) => entry.type === "status" && entry.text.includes("リセット")),
      `the notice was not left where the chat is rebuilt from: ${JSON.stringify(bridge.history)}`,
    );
    // The list the phone rebuilds from must agree with what it was just told.
    const ready = client.sent.filter((msg) => msg.type === "ready").at(-1);
    assert.deepEqual(
      (ready?.history || []).filter((entry) => entry.type !== "status"),
      [],
    );
  } finally {
    // The bridge follows the session file it was left pointing at, and a poll
    // on a session that only ever existed in this test would outlive it.
    bridge.unwatchSession();
    bridge.closeApprovalServer();
  }
});

test("an ordinary turn keeps the conversation it is part of", async () => {
  const bridge = new ClaudeBridge(null, "clear-untouched");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("こんにちは", [], fullAccess);
    await turnCompleted(client);
    bridge.prompt("/context", [], fullAccess);
    await turnCompleted(client, 2);

    assert.ok(bridge.history.length >= 2, "a command that is not /clear must not empty the chat");
    assert.equal(bridge.clearRequested, false);
  } finally {
    // The bridge follows the session file it was left pointing at, and a poll
    // on a session that only ever existed in this test would outlive it.
    bridge.unwatchSession();
    bridge.closeApprovalServer();
  }
});
