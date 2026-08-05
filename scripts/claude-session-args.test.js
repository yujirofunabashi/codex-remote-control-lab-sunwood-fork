// Covers the command line the bridge builds, which is the only place `--name`
// can take effect: it labels the session in the `/resume` picker, so getting it
// wrong is what leaves phone work looking like a bare uuid on the desktop.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-session-args-"));
const stubBin = path.join(stubRoot, "claude-stub.js");
const argsLog = path.join(stubRoot, "args.log");

// Answers `--help` the way a CLI that supports the flag does, so the bridge's
// capability probe sees what it would see against a real install.
fs.writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_ARGS_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "--help") {
  process.stdout.write("  -n, --name <name>    Set a display name for this session\\n");
  process.exit(0);
}
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
    emit({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "stub-session" });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.CLAUDE_BIN = stubBin;
process.env.STUB_ARGS_LOG = argsLog;
process.env.PHONE_SESSION_NAME_PREFIX = "📱";

const { ClaudeBridge } = require("./start-phone");

const fullAccess = { approvalPolicy: "never", sandboxMode: "danger-full-access" };

test.after(() => {
  fs.rmSync(stubRoot, { recursive: true, force: true });
});

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

function turns() {
  return fs
    .readFileSync(argsLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((args) => args[0] !== "--help");
}

function turnCount(client) {
  return client.sent.filter((msg) => msg.type === "turn" && msg.status === "completed").length;
}

function turnCompleted(client, count = 1) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (turnCount(client) >= count) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("turn did not complete"));
      }
    }, 20);
  });
}

test("the opening prompt names the session so the picker can show it", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "name-on-create");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("レートリミットの表示を直して", [], fullAccess);
    await turnCompleted(client);

    const args = turns()[0];
    assert.equal(args[args.indexOf("--name") + 1], "📱 レートリミットの表示を直して");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("resuming does not rename, so a title set on the desktop survives", async () => {
  fs.writeFileSync(argsLog, "");
  const bridge = new ClaudeBridge(null, "name-once");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("first", [], fullAccess);
    await turnCompleted(client, 1);
    bridge.prompt("second", [], fullAccess);
    await turnCompleted(client, 2);

    const [first, second] = turns();
    assert.ok(first.includes("--name"));
    assert.equal(second[second.indexOf("--resume") + 1], "stub-session");
    assert.ok(!second.includes("--name"), "a resumed turn must not overwrite the session title");
  } finally {
    bridge.closeApprovalServer();
  }
});
