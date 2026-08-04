const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stub-"));
const stubBin = path.join(stubRoot, "claude-stub.js");
const argsLog = path.join(stubRoot, "args.log");

// Stands in for the Claude Code CLI: speaks stream-json over stdio, stays alive
// between turns, and records the flags it was launched with.
fs.writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.STUB_ARGS_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "system", subtype: "init", session_id: "stub-session" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const text = msg.message.content[0].text;
    const reply = () => {
      emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "echo:" + text } }, session_id: "stub-session" });
      emit({ type: "result", subtype: "success", is_error: false, result: "echo:" + text, session_id: "stub-session" });
    };
    if (text.startsWith("SLOW")) setTimeout(reply, 400);
    else reply();
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

process.env.PHONE_AGENT_PROVIDER = "claude";
process.env.CLAUDE_BIN = stubBin;
process.env.STUB_ARGS_LOG = argsLog;

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
    messagesOfType(type) {
      return sent.filter((msg) => msg.type === type);
    },
  };
}

function spawnedRuns() {
  if (!fs.existsSync(argsLog)) return [];
  return fs
    .readFileSync(argsLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function turnCompleted(client, count) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const done = client.sent.filter((msg) => msg.type === "turn" && msg.status === "completed");
      if (done.length >= count) {
        clearInterval(timer);
        resolve(done);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${count} completed turns`));
      }
    }, 20);
  });
}

test("a follow-up turn reuses the running process instead of paying startup again", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "reuse");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("first", [], fullAccess);
    await turnCompleted(client, 1);
    const pidAfterFirst = bridge.activeProcess.pid;

    bridge.prompt("second", [], fullAccess);
    await turnCompleted(client, 2);

    assert.equal(bridge.activeProcess.pid, pidAfterFirst);
    assert.equal(spawnedRuns().length, 1, "only one process should have been spawned");
  } finally {
    bridge.dispose();
  }
});

test("streaming input flags are passed so the process can accept later turns", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "flags");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("hello", [], fullAccess);
    await turnCompleted(client, 1);

    const { args } = spawnedRuns()[0];
    assert.ok(args.includes("--input-format"), "missing --input-format");
    assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
    assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  } finally {
    bridge.dispose();
  }
});

test("changing the model respawns instead of silently using the old one", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "model-swap");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("first", [], { ...fullAccess, model: "sonnet" });
    await turnCompleted(client, 1);

    bridge.prompt("second", [], { ...fullAccess, model: "opus" });
    await turnCompleted(client, 2);

    const runs = spawnedRuns();
    assert.equal(runs.length, 2, "model change should start a fresh process");
    assert.equal(runs[0].args[runs[0].args.indexOf("--model") + 1], "sonnet");
    assert.equal(runs[1].args[runs[1].args.indexOf("--model") + 1], "opus");
  } finally {
    bridge.dispose();
  }
});

test("changing the access mode respawns so permissions cannot leak across turns", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "mode-swap");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("first", [], fullAccess);
    await turnCompleted(client, 1);

    bridge.prompt("second", [], { approvalPolicy: "on-request", sandboxMode: "read-only" });
    await turnCompleted(client, 2);

    const runs = spawnedRuns();
    assert.equal(runs.length, 2);
    assert.equal(runs[0].args[runs[0].args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(runs[1].args[runs[1].args.indexOf("--permission-mode") + 1], "plan");
  } finally {
    bridge.dispose();
  }
});

test("a prompt sent mid-turn queues and runs afterwards", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "queue");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("SLOW first", [], fullAccess);
    bridge.prompt("second", [], fullAccess);

    assert.equal(bridge.turnQueue.length, 1, "second prompt should queue while a turn is active");
    await turnCompleted(client, 2);
    assert.equal(bridge.turnQueue.length, 0);

    const replies = client.messagesOfType("assistantDelta").map((msg) => msg.text);
    assert.ok(replies.some((text) => text.includes("SLOW first")));
    assert.ok(replies.some((text) => text.includes("second")));
  } finally {
    bridge.dispose();
  }
});

test("interrupt stops the process, drops the queue, and closes the turn", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "interrupt");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("SLOW first", [], fullAccess);
    bridge.prompt("queued", [], fullAccess);
    assert.equal(bridge.turnQueue.length, 1);

    bridge.interrupt();

    assert.equal(bridge.turnQueue.length, 0, "queued turns should be discarded");
    assert.equal(bridge.activeTurnId, null);
    assert.equal(bridge.activeProcess, null);
    const statuses = client.messagesOfType("status").map((msg) => msg.text);
    assert.ok(statuses.some((text) => text.includes("中断しました")));
  } finally {
    bridge.dispose();
  }
});

test("interrupt with nothing running says so instead of throwing", () => {
  const bridge = new ClaudeBridge(null, "interrupt-idle");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.interrupt();
    const statuses = client.messagesOfType("status").map((msg) => msg.text);
    assert.ok(statuses.some((text) => text.includes("中断できる処理がありません")));
  } finally {
    bridge.dispose();
  }
});

test("disposing the bridge stops the held process", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "dispose");
  const client = fakeClient();
  bridge.clients.add(client);

  bridge.prompt("hello", [], fullAccess);
  await turnCompleted(client, 1);
  const child = bridge.activeProcess;
  assert.ok(child);

  bridge.dispose();

  assert.equal(bridge.activeProcess, null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(child.killed || child.exitCode !== null, "child process should be stopped");
});

test("a resumed session passes --resume so the transcript continues", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge("session-abc", "resume");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("hello", [], fullAccess);
    await turnCompleted(client, 1);

    const { args } = spawnedRuns()[0];
    assert.equal(args[args.indexOf("--resume") + 1], "session-abc");
  } finally {
    bridge.dispose();
  }
});
