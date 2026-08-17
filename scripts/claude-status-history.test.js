// 作業ログ used to live in the open page and nowhere else, so leaving the chat
// and coming back rebuilt the log from a history that never carried it: the
// account of what had happened started again at the moment of return.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-status-"));
const stubBin = path.join(stubRoot, "claude-stub.js");

// Answers a turn the way the CLI does, and reports one API retry on the way -
// the status line the operator most needs to still be there when they return.
fs.writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "session-status";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "system", subtype: "init", session_id: resumed, slash_commands: [], skills: [] });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10 });
    emit({ type: "result", subtype: "success", is_error: false, result: "できました", session_id: resumed });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.CLAUDE_BIN = stubBin;

const { ClaudeBridge, capHistoryWithStatus } = require("./start-phone");

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

test("what happened during a turn is still there after leaving the chat", async () => {
  const bridge = new ClaudeBridge(null, "status-kept");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("やって", [], fullAccess);
    await turnCompleted(client);

    const live = client.sent.filter((msg) => msg.type === "status").map((msg) => msg.text);
    assert.ok(
      live.some((text) => text.includes("retry")),
      `the turn should have reported its retry: ${JSON.stringify(live)}`,
    );

    // The history is what the phone redraws from when it returns to the chat,
    // so the same line has to be in there, not only on the wire.
    const kept = bridge.history.filter((entry) => entry.type === "status").map((entry) => entry.text);
    assert.deepEqual(kept, live, "the log the page was shown and the log it can rebuild disagree");
    // And it sits with the conversation rather than replacing it.
    assert.ok(bridge.history.some((entry) => entry.type === "user"));
    assert.ok(bridge.history.some((entry) => entry.type === "assistant"));
  } finally {
    bridge.unwatchSession();
    bridge.closeApprovalServer();
  }
});

test("a blank status is not a log line", async () => {
  const bridge = new ClaudeBridge(null, "status-blank");
  try {
    bridge.emit("status", { text: "   " });
    bridge.emit("status", {});
    assert.equal(bridge.history.length, 0);
  } finally {
    bridge.unwatchSession();
    bridge.closeApprovalServer();
  }
});

test("a retry storm is trimmed before the messages it is about", () => {
  const history = [
    { type: "user", text: "1" },
    ...Array.from({ length: 5 }, (_, index) => ({ type: "status", text: `retry ${index}` })),
    { type: "assistant", text: "2" },
  ];
  const capped = capHistoryWithStatus(history, 4);

  assert.equal(capped.length, 4);
  // Both messages survive; the oldest status lines are what gave way.
  assert.deepEqual(
    capped.filter((entry) => entry.type !== "status").map((entry) => entry.text),
    ["1", "2"],
  );
  assert.deepEqual(
    capped.filter((entry) => entry.type === "status").map((entry) => entry.text),
    ["retry 3", "retry 4"],
  );

  // Under the limit nothing is touched.
  assert.deepEqual(capHistoryWithStatus(history, 10), history);
});

test("a history of nothing but messages still cannot grow past the limit", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({ type: "user", text: String(index) }));
  assert.deepEqual(
    capHistoryWithStatus(history, 3).map((entry) => entry.text),
    ["3", "4", "5"],
  );
});
