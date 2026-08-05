const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-effort-"));
const stubBin = path.join(stubRoot, "claude-stub.js");
const argsLog = path.join(stubRoot, "args.log");

fs.writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.STUB_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "system", subtype: "init", session_id: "stub" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "stub" });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
// This test asserts on the no-fallback case, so an inherited value must not leak in.
delete process.env.CLAUDE_EFFORT;
process.env.CLAUDE_BIN = stubBin;
process.env.STUB_ARGS_LOG = argsLog;

const { ClaudeBridge, claudeEffortLevel } = require("./start-phone");

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

function spawnedArgs() {
  return fs
    .readFileSync(argsLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    // The bridge asks the CLI once whether it accepts `--name`; that probe is
    // not a turn, so it must not be mistaken for one.
    .filter((args) => args[0] !== "--help");
}

function turnCompleted(client) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (client.sent.some((msg) => msg.type === "turn" && msg.status === "completed")) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("turn did not complete"));
      }
    }, 20);
  });
}

test("every documented effort level is accepted", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(claudeEffortLevel({ effort: level }), level);
  }
});

test("an unknown level is dropped rather than passed through", () => {
  // `claude --effort bogus` exits 0 and ignores it, so passing it through would
  // look like the setting applied.
  assert.equal(claudeEffortLevel({ effort: "bogus" }), "");
  assert.equal(claudeEffortLevel({ effort: "" }), "");
  assert.equal(claudeEffortLevel({}), "");
});

test("levels are matched case-insensitively", () => {
  assert.equal(claudeEffortLevel({ effort: "XHigh" }), "xhigh");
});

test("CLAUDE_EFFORT is the fallback, and a request still wins", () => {
  const previous = process.env.CLAUDE_EFFORT;
  process.env.CLAUDE_EFFORT = "high";
  try {
    assert.equal(claudeEffortLevel({}), "high");
    assert.equal(claudeEffortLevel({ effort: "low" }), "low");
    process.env.CLAUDE_EFFORT = "nonsense";
    assert.equal(claudeEffortLevel({}), "");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_EFFORT;
    else process.env.CLAUDE_EFFORT = previous;
  }
});

test("a requested effort reaches the CLI", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "effort-on");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("hi", [], { ...fullAccess, effort: "xhigh" });
    await turnCompleted(client);

    const args = spawnedArgs()[0];
    assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("no effort means no flag, leaving the CLI on its own default", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "effort-off");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("hi", [], fullAccess);
    await turnCompleted(client);

    assert.ok(!spawnedArgs()[0].includes("--effort"));
  } finally {
    bridge.closeApprovalServer();
  }
});

test("the model list offers aliases that track the current generation", () => {
  const source = fs.readFileSync(path.join(__dirname, "start-phone.js"), "utf8");
  const list = source.match(/const claudeModelOptions = (\[[^\]]*\])/)[1];
  const options = JSON.parse(list.replace(/'/g, '"'));

  assert.deepEqual(options, ["sonnet", "opus", "haiku", "fable"]);
  // Pinned full names from an older generation used to sit here and went stale.
  assert.ok(!options.some((item) => /^claude-.*-\d/.test(item)), "pinned model names rot; aliases do not");
});
