const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { GeminiBridge, GeminiSessionStore, GeminiStreamClient, geminiArgs, assertAccountBilling, DEFAULT_GEMINI_MODEL } = require("./gemini-bridge");
const { inspectGemini } = require("./gemini-runtime");

const sessionId = "11111111-1111-4111-8111-111111111111";
function fixture(t, { authError = false, hold = false, malformed = false, noResult = false, denied = false, resultStatus = "SUCCESS" } = {}) {
  const calls = [], children = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-gemini-test-"));
  const store = new GeminiSessionStore(path.join(directory, "sessions"));
  const spawnProcess = (bin, args, options) => {
    assert.ok(args.includes("--input-format"));
    assert.equal(args.includes("--acp"), false);
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(options.env.GEMINI_API_KEY, "");
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    const finish = (code = 0, signal = null) => {
      if (child.exitCode !== null || child.signalCode) return;
      child.exitCode = code; child.signalCode = signal; child.emit("close", code, signal);
    };
    child.kill = signal => finish(null, signal);
    children.push(child);
    const send = value => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin.on("data", chunk => calls.push({ bin, args, options, input: JSON.parse(String(chunk)) }));
    child.stdin.on("finish", () => queueMicrotask(() => {
      if (authError) { child.stderr.write(typeof authError === "string" ? authError : "Error: authentication required"); finish(1); return; }
      send({ event: "init", conversation_id: sessionId, init: { permission_mode: "request-review" } });
      if (malformed) { child.stdout.write("not JSON\n"); return; }
      const frame = Buffer.from(JSON.stringify({ event: "step_update", step_update: { conversation_id: sessionId, state: "ACTIVE", step_type: "agent_response", text_delta: "日本語の" } }) + "\n");
      const offset = frame.indexOf(Buffer.from("日")) + 1;
      child.stdout.write(frame.subarray(0, offset)); child.stdout.write(frame.subarray(offset));
      if (hold) return;
      if (denied) child.stderr.write("Tool run_command soft-denied: approval required");
      send({ event: "step_update", step_update: { conversation_id: sessionId, state: "DONE", step_type: "agent_response", text_delta: "回答" } });
      if (!noResult) send({ event: "result", result: { conversation_id: sessionId, status: resultStatus, response: "日本語の回答", ...(resultStatus !== "SUCCESS" ? { error: "Model quota exceeded" } : {}) } });
      finish();
    }));
    return child;
  };
  const dependencies = { store, streamOptions: { spawnProcess }, checkAccountBilling: () => {} };
  const bridge = new GeminiBridge(null, "new:test", { workdir: directory }, dependencies);
  const events = [];
  const client = new EventEmitter(); client.readyState = 1; client.send = body => events.push(JSON.parse(body));
  bridge.addClient(client);
  t.after(() => { bridge.dispose(); for (const child of children) child.kill("SIGTERM"); fs.rmSync(directory, { recursive: true, force: true }); });
  return { bridge, store, events, calls, directory, client, spawnProcess, dependencies };
}
async function until(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Expected bridge state was not reached");
}

test("stable phone id, exact UTF-8 stream, canonical result and explicit native resume", async t => {
  const f = fixture(t); const id = f.bridge.threadId;
  f.bridge.prompt("first", [], { model: DEFAULT_GEMINI_MODEL, effort: "high" }, "message-1");
  await until(() => !f.bridge.hasActiveWork());
  assert.equal(f.bridge.runState.state, "done");
  assert.equal(f.events.filter(item => item.type === "assistantDelta").map(item => item.text).join(""), "日本語の回答");
  assert.equal(f.store.read(id).history[1].text, "日本語の回答");
  const restored = new GeminiBridge(id, id, { workdir: os.tmpdir() }, f.dependencies);
  assert.equal(restored.workdir, f.directory);
  restored.prompt("second"); await until(() => !restored.hasActiveWork());
  assert.equal(restored.history.filter(item => item.type === "assistant").length, 2);
  assert.equal(restored.threadId, id);
  assert.equal(f.calls[1].args.at(-2), "--conversation");
  assert.equal(f.calls[1].args.at(-1), sessionId);
  assert.equal(f.calls[1].input.event, "user");
  assert.ok(f.calls[1].input.message.content.endsWith("[ユーザーの依頼]\nsecond"));
  assert.equal(f.calls.some(call => call.args.includes("--continue")), false);
  assert.equal(fs.statSync(f.store.file(id)).mode & 0o777, 0o600);
  restored.dispose();
});

test("busy and attachment submissions remain unacknowledged; interrupt stops only this process", async t => {
  const f = fixture(t, { hold: true });
  f.bridge.prompt("first");
  await until(() => f.bridge.activeProcess);
  f.bridge.prompt("keep draft", [], {}, "busy-message");
  f.bridge.prompt("keep picture", [{}], {}, "image-message");
  f.bridge.interrupt();
  await until(() => !f.bridge.hasActiveWork());
  assert.equal(f.bridge.runState.state, "interrupted");
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.filter(e => e.type === "user").length, 1);
  assert.equal(f.events.some(e => e.type === "promptAccepted"), false);
  assert.ok(f.events.some(e => e.type === "error" && e.clientMessageId === "busy-message"));
  assert.ok(f.events.some(e => e.type === "error" && e.clientMessageId === "image-message"));
});

test("authentication failure keeps the submitted input without retry or alternate billing", async t => {
  const f = fixture(t, { authError: true });
  f.bridge.prompt("keep this input");
  await until(() => !f.bridge.hasActiveWork());
  assert.equal(f.bridge.runState.state, "error");
  assert.equal(f.store.read(f.bridge.threadId).history[0].text, "keep this input");
  assert.ok(f.events.some(item => item.type === "error" && item.text.includes("初回ログイン")));
  assert.equal(f.calls.length, 1);
  assert.equal(f.bridge.sessionId, null);
  assert.equal(f.events.at(-1).status, "completed");
  assert.equal(f.events.at(-1).run.state, "error");
});

test("operator context is separate from saved user text and refreshed for each submission", async t => {
  const f = fixture(t);
  const operationContext = require("../public/operation-context");
  f.bridge.dependencies.modelContext = context => operationContext.modelContext(context, "mini");
  f.bridge.prompt("original input", [], {}, "context-message", { ...operationContext.selectPreset("air-mini"), injected: "do not trust this field" });
  await until(() => !f.bridge.hasActiveWork());
  const input = f.calls[0].input.message.content;
  assert.match(input, /手元: Air/); assert.match(input, /実行先: mini/);
  assert.ok(input.endsWith("[ユーザーの入力]\noriginal input"));
  assert.doesNotMatch(input, /do not trust this field/);
  assert.equal(f.store.read(f.bridge.threadId).history[0].text, "original input");
});

test("native CLI's observed auth-failure wording includes the login action and original cause", async t => {
  const f = fixture(t, { authError: "authentication failed or timed out" });
  f.bridge.prompt("test"); await until(() => !f.bridge.hasActiveWork());
  const error = f.events.find(e => e.type === "error").text;
  assert.match(error, /初回ログイン/); assert.match(error, /authentication failed or timed out/);
  assert.equal(f.bridge.runState.state, "error");
});

for (const [name, options] of [["malformed", { malformed: true }], ["no final result", { noResult: true }], ["failure result with exit zero", { resultStatus: "ERROR" }]]) {
  test(name + " never reports success", async t => {
    const f = fixture(t, options);
    f.bridge.prompt("test"); await until(() => !f.bridge.hasActiveWork());
    assert.equal(f.bridge.runState.state, "error");
    assert.equal(f.calls.length, 1);
  });
}

test("soft-denied tools are reported even when a text answer succeeds", async t => {
  const f = fixture(t, { denied: true });
  f.bridge.prompt("test"); await until(() => !f.bridge.hasActiveWork());
  assert.equal(f.bridge.runState.state, "done");
  assert.ok(f.bridge.runState.label.includes("未実行"));
  assert.equal(f.bridge.pendingApproval, null);
  assert.equal(f.bridge.readyPayload().capabilities.approvals, false);
});

test("a native conversation mismatch stops instead of attaching to another conversation", async t => {
  const f = fixture(t);
  f.bridge.sessionId = "22222222-2222-4222-8222-222222222222";
  f.bridge.prompt("test"); await until(() => !f.bridge.hasActiveWork());
  assert.equal(f.bridge.runState.state, "error");
  assert.ok(f.events.some(e => e.type === "error" && e.text.includes("会話番号")));
  assert.equal(f.bridge.sessionId, "22222222-2222-4222-8222-222222222222");
});

test("malformed and missing phone ids fail without creating another conversation", t => {
  const f = fixture(t);
  assert.throws(() => f.store.read("gemini:../../token"), /Invalid/);
  assert.throws(() => new GeminiBridge("gemini:" + sessionId, "missing", {}, f.dependencies), /見つかりません/);
  assert.equal(f.store.list().length, 1);
});

test("model and effort are explicit and no permission-escalation flags can leak from other providers", () => {
  const args = geminiArgs({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
  assert.equal(args.includes("--mode"), false, "native plan mode is disabled by --disable-slash-commands");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--model") + 1], DEFAULT_GEMINI_MODEL);
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.throws(() => geminiArgs({ model: "claude-sonnet" }), /他のAI/);
  assert.throws(() => geminiArgs({ effort: "max" }), /low/);
});

test("each turn carries an advisory instruction without claiming native plan mode", async t => {
  const f = fixture(t);
  f.bridge.prompt("/model keep this as text");
  await until(() => !f.bridge.hasActiveWork());
  f.bridge.prompt("second question");
  await until(() => !f.bridge.hasActiveWork());
  for (const call of f.calls) {
    assert.match(call.input.message.content, /^\[リモコンの文章相談\]/);
    assert.match(call.input.message.content, /ファイルの読み書き/);
    assert.match(call.input.message.content, /行わないでください/);
    assert.ok(call.args.includes("--disable-slash-commands"));
    assert.equal(call.args.includes("--mode"), false);
  }
  assert.ok(f.calls[0].input.message.content.endsWith("[ユーザーの依頼]\n/model keep this as text"));
  assert.equal(f.bridge.history[0].text, "/model keep this as text");
  assert.equal(f.bridge.readyPayload().capabilities.mode, "advisory");
});

test("credit or API settings block execution without changing settings or reading credentials", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-settings-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  for (const settings of [{ useG1Credits: true }, { modelProvider: "gemini" }, { toolPermission: "always-proceed" }]) {
    const body = JSON.stringify(settings); fs.writeFileSync(config, body);
    assert.throws(() => assertAccountBilling({ home: directory }), /起動しません/);
    assert.equal(fs.readFileSync(config, "utf8"), body);
  }
  fs.writeFileSync(config, '{"useG1Credits":false}');
  assert.doesNotThrow(() => assertAccountBilling({ home: directory }));
  fs.writeFileSync(config, '{"broken":');
  assert.throws(() => assertAccountBilling({ home: directory }), /設定を確認/);
});

test("a process timeout terminates the process and reports failure", async t => {
  const f = fixture(t, { hold: true });
  const client = new GeminiStreamClient({ cwd: f.directory, prompt: "test", spawnProcess: f.spawnProcess, timeoutMs: 10 });
  await assert.rejects(client.finished, /時間切れ/);
  assert.equal(client.closed, true);
});

test("legacy Google auth migration keeps unrelated settings and an exact backup", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-settings-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, ".gemini"));
  const file = path.join(directory, ".gemini", "settings.json");
  const original = { selectedAuthType: "oauth-personal", theme: "Original", security: { other: true } };
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(inspectGemini({ home: directory }).authType, null);
  assert.equal(inspectGemini({ home: directory, migrate: true }).migrated, true);
  const settings = JSON.parse(fs.readFileSync(file));
  assert.equal(settings.theme, "Original"); assert.equal(settings.security.other, true);
  const backup = fs.readdirSync(path.dirname(file)).find(name => name.includes(".bak-"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(file), backup))), original);
  assert.equal(inspectGemini({ home: directory, migrate: true }).migrated, false);
});
