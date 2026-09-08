const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { emptyCodexThreadWorkdir, isUnavailableHistoryError } = require("./codex-empty-thread");
const { readThreadSnapshot } = require("./thread-read");

function fixture(t, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout.jsonl");
  const row = { type: "session_meta", payload: { id: "empty-thread", cwd: directory, source: "vscode", history_mode: "paginated" } };
  fs.writeFileSync(file, [row, ...extra].map(item => JSON.stringify(item)).join("\n") + "\n");
  return { directory, row, thread: { id: "empty-thread", path: file, preview: "", ephemeral: false, status: { type: "idle" } } };
}

test("only a verified empty transcript supplies a recovery folder", t => {
  const f = fixture(t);
  assert.equal(emptyCodexThreadWorkdir({ ...f.thread, cwd: "/wrong/ui/folder" }), f.directory);
  for (const changes of [{ id: "other" }, { preview: "real work" }, { ephemeral: true }, { status: { type: "active" } }, { path: "/missing" }]) {
    assert.equal(emptyCodexThreadWorkdir({ ...f.thread, ...changes }), "");
  }
});

test("user messages, unknown records, forks and truncated data cannot be discarded", t => {
  const f = fixture(t, [{ type: "response_item", payload: { type: "message", role: "user", content: [] } }]);
  assert.equal(emptyCodexThreadWorkdir(f.thread), "");
  for (const text of [JSON.stringify(f.row) + '\n{"type":', JSON.stringify({ ...f.row, payload: { ...f.row.payload, forked_from_id: "parent" } }), JSON.stringify(f.row) + '\n{}']) {
    fs.writeFileSync(f.thread.path, text);
    assert.equal(emptyCodexThreadWorkdir(f.thread), "");
  }
});

test("only known history failures are eligible for empty-session inspection", () => {
  for (const message of ["list_turns is not supported yet", "no rollout found for thread id example", "thread is not materialized yet"]) assert.equal(isUnavailableHistoryError(new Error(message)), true);
  assert.equal(isUnavailableHistoryError(new Error("authentication failed")), false);
});

test("history inspection handles a verified empty session without a resume or file change", async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.thread.path, "utf8");
  const calls = [];
  const snapshot = await readThreadSnapshot({ threadId: f.thread.id, historyFromThread: () => [], request: async (method, params) => {
    calls.push({ method, params });
    if (params.includeTurns) throw new Error("list_turns is not supported yet");
    return { thread: f.thread };
  } });
  assert.equal(snapshot.empty, true);
  assert.deepEqual(snapshot.history, []);
  assert.deepEqual(calls.map(call => call.method), ["thread/read", "thread/read"]);
  assert.equal(fs.readFileSync(f.thread.path, "utf8"), before);
});
