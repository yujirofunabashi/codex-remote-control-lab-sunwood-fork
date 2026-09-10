const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const startPhone = path.join(__dirname, "start-phone.js");

function compact(raw) {
  const script = `
    const { compactCodexError } = require(${JSON.stringify(startPhone)});
    process.stdout.write("RESULT" + JSON.stringify(compactCodexError(${JSON.stringify(raw)})) + "\\n");
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PHONE_UI_PORT: "45997",
      PHONE_TOKEN: "test-token",
      PHONE_WORKDIR: os.tmpdir(),
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:45997",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT"));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("RESULT".length));
}

test("an expired sign-in reads as a sign-in, not as a bearer token", () => {
  // The raw failure is a JSON envelope about tokens and request ids. It goes to
  // the phone, where the reader can act on exactly one thing: signing in again.
  const compacted = compact(
    '{"error":{"message":"Provided authentication token is expired.","code":"token_expired"},"status":401}',
  );
  assert.equal(compacted.retrying, false);
  assert.match(compacted.text, /認証が切れました/);
  assert.match(compacted.text, /codex login/);
  assert.doesNotMatch(compacted.text, /token_expired|401/);
});

test("an unrelated failure is passed through as it was", () => {
  const compacted = compact("sandbox denied write to /etc/hosts");
  assert.deepEqual(compacted, { text: "sandbox denied write to /etc/hosts", retrying: false });
});

test("writer contention describes the original conversation and a manual reconnect", () => {
  const error = compact("thread original already has an active writer");
  assert.equal(error.code, "thread_writer_conflict");
  assert.equal(error.retryable, false);
  assert.match(error.text, /同じ会話に再接続/);
  assert.match(error.text, /画面を閉じても/);
  assert.match(error.text, /使用権/);
  assert.match(error.text, /再接続を繰り返さず/);
  assert.doesNotMatch(error.text, /active writer/);
});

test("an oversized message is explained without claiming the conversation was lost", () => {
  const error = compact("Max payload size exceeded");
  assert.equal(error.code, "codex_payload_too_large");
  assert.equal(error.retryable, false);
  assert.match(error.text, /通信データ/);
});
