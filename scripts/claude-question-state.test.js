const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const childProcess = require("node:child_process");
const os = require("node:os");
const { idleRunStateFromHistory } = require("./question-state");
const { sessionActivityStatus } = require("../public/phone-ui-utils");

// Exercise the real stream/exit handlers, never a real AI process or notifier.
globalThis.fetch = async () => ({ ok: true, status: 204, text: async () => "" });
process.env.PHONE_NOTIFY_EVENTS = "0";
let child;
const spawnMock = test.mock.method(childProcess, "spawn", () => {
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
});
const { ClaudeBridge } = require("./start-phone");
spawnMock.mock.restore();
for (const key of Object.keys(process.env)) {
  if (/^PHONE_(NOTIFY|NTFY|PUSHOVER|DISCORD)_/.test(key)) process.env[key] = "";
}

for (const [text, expected] of [
  ["実装を反映しました。完了は✓、質問・許可待ちは?、エラーは!で表示します。", "done"],
  ["実装が完了しました。画面で確認してください。", "done"],
  ["対象の端末名を返信してください。", "question"],
  ["この方針で進めてよいですか？", "question"],
  ["", "done"],
]) {
  test(`Claude stream completion delivers ${expected} for: ${text || "an empty reply"}`, () => {
    const bridge = new ClaudeBridge(null, "question-state-test");
    bridge.workdir = os.tmpdir();
    bridge.claudeSessionId = "question-state-fixture"; // Skip the real CLI capability probe.
    bridge.history = [{ type: "assistant", text: "前の作業を続けますか？", outputGroup: "previous-turn" }];
    const events = [];
    bridge.emit = (type, payload) => events.push({ type, ...payload });
    bridge.startNextQueuedTurn = () => {};
    bridge.scheduleIdleDispose = () => {};
    bridge.spawnTurn("検査用の依頼");
    const turnId = bridge.activeTurnId;
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }) + "\n");
    child.emit("exit", 0, null);
    const completed = events.find((event) => event.type === "turn" && event.status === "completed");
    assert.equal(completed.turnId, turnId);
    assert.equal(completed.run.state, expected);
    assert.equal(sessionActivityStatus(completed.run), expected);
    assert.equal(bridge.activeProcess, null);
    assert.equal(bridge.activeTurnId, null);
    if (text) assert.equal(idleRunStateFromHistory(bridge.history).state, expected);
  });
}
