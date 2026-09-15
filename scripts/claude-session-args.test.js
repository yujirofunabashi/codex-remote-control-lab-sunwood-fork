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
const inputLog = path.join(stubRoot, "input.log");

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
    fs.appendFileSync(process.env.STUB_INPUT_LOG, line + "\\n");
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
process.env.STUB_INPUT_LOG = inputLog;
process.env.PHONE_SESSION_NAME_PREFIX = "📱";
process.env.PHONE_NOTIFY_EVENTS = "0";
for (const key of Object.keys(process.env)) {
  if (/^PHONE_(NTFY|PUSHOVER|DISCORD)_/.test(key)) process.env[key] = "";
}
globalThis.fetch = async () => ({ ok: true, status: 204, text: async () => "" });

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

test("fixed instructions stay identical while each resumed Claude turn gets its own operator data", async () => {
  fs.writeFileSync(argsLog, "");
  fs.writeFileSync(inputLog, "");
  const { selectPreset } = require("../public/operation-context");
  const bridge = new ClaudeBridge(null, "operation-context");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("first", [], fullAccess, "first", selectPreset("air-mini"));
    await turnCompleted(client, 1);
    bridge.prompt("second", [], fullAccess, "second", selectPreset("mini"));
    await turnCompleted(client, 2);
    const [first, second] = turns();
    const fixed = first[first.indexOf("--append-system-prompt") + 1];
    assert.equal(second[second.indexOf("--append-system-prompt") + 1], fixed);
    assert.doesNotMatch(fixed, /受信=|選択=|手元:|実行先:/);
    const messages = fs.readFileSync(inputLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(messages[0].message.content[0].text, "first");
    assert.match(messages[0].message.content[1].text, /手元: Air.*画面共有/);
    assert.equal(messages[1].message.content[0].text, "second");
    assert.match(messages[1].message.content[1].text, /手元: mini.*経路: 直接/);
    assert.equal(second[second.indexOf("--resume") + 1], "stub-session");
    assert.deepEqual(bridge.history.filter(entry => entry.type === "user").map(entry => entry.text), ["first", "second"]);
  } finally {
    bridge.closeApprovalServer();
  }
});

test("slash commands keep their exact input and receive no extra arguments", async () => {
  fs.writeFileSync(inputLog, "");
  const bridge = new ClaudeBridge(null, "context-command");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    bridge.prompt("/clear", [], fullAccess);
    await turnCompleted(client);
    const input = JSON.parse(fs.readFileSync(inputLog, "utf8").trim());
    assert.deepEqual(input.message.content, [{ type: "text", text: "/clear" }]);
    bridge.prompt("next", [], fullAccess);
    await turnCompleted(client, 2);
    const next = fs.readFileSync(inputLog, "utf8").trim().split("\n").map(JSON.parse)[1];
    assert.match(next.message.content.at(-1).text, /当回データ.*手元: 未確認/);
  } finally { bridge.closeApprovalServer(); }
});

test("an image stays inline beside the original text when operator data is added", async () => {
  fs.writeFileSync(inputLog, "");
  const bridge = new ClaudeBridge(null, "context-image");
  const client = fakeClient();
  bridge.clients.add(client);
  let saved;
  const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
  try {
    bridge.prompt("この画像", [{ name: "context-fixture.png", dataUrl: `data:image/png;base64,${encoded}` }], fullAccess);
    await turnCompleted(client);
    saved = bridge.history.find(entry => entry.type === "user").attachments[0];
    const content = JSON.parse(fs.readFileSync(inputLog, "utf8").trim()).message.content;
    assert.equal(content[0].text, "この画像");
    assert.equal(content[1].type, "image");
    assert.equal(content[1].source.data, encoded);
    assert.match(content[2].text, /操作環境 当回データ/);
    assert.doesNotMatch(bridge.history[0].text, /当回データ/);
  } finally {
    bridge.closeApprovalServer();
    if (saved?.absolutePath) fs.unlinkSync(saved.absolutePath);
  }
});
