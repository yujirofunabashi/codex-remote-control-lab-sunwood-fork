const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeThreadListData, threadListTimestamp, threadRecordForBridge } = require("./start-phone");

test("mergeThreadListData includes live local Codex threads missing from remote list", () => {
  const remote = [{ id: "remote-1", name: "Remote thread", updatedAt: 1000, provider: "codex" }];
  const local = [{ id: "live-1", name: "Live prompt", preview: "Live prompt", updatedAt: 2000, provider: "codex" }];

  assert.deepEqual(
    mergeThreadListData(remote, local).map((thread) => thread.id),
    ["live-1", "remote-1"],
  );
});

test("mergeThreadListData dedupes live threads and preserves remote title when local title is only the id", () => {
  const merged = mergeThreadListData(
    [{ id: "thread-1", name: "Readable remote title", preview: "Readable preview", updatedAt: 1000, provider: "codex" }],
    [{ id: "thread-1", name: "thread-1", preview: "thread-1", updatedAt: 2000, localActivityAt: 2000, provider: "codex" }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "thread-1");
  assert.equal(merged[0].name, "Readable remote title");
  assert.equal(merged[0].preview, "Readable preview");
  assert.equal(merged[0].updatedAt, 2000);
});

test("mergeThreadListData keeps remote updatedAt when a local bridge was only reconnected", () => {
  const merged = mergeThreadListData(
    [{ id: "thread-1", name: "Readable remote title", preview: "Readable preview", updatedAt: 1000, provider: "codex" }],
    [{ id: "thread-1", name: "Local title", preview: "Local preview", updatedAt: 999999, localActivityAt: 0, provider: "codex" }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].updatedAt, 1000);
});

test("threadRecordForBridge gives ready payload and local list the same display title", () => {
  const bridge = {
    threadId: "thread-1",
    provider: "codex",
    createdAt: 1_700_000_000_000,
    listUpdatedAt: 1_700_000_001_000,
    runState: { state: "done", updatedAt: 1_700_000_000_500 },
    history: [
      { type: "user", text: "First prompt" },
      { type: "assistant", text: "Done" },
      { type: "user", text: "Current visible title\nwith detail" },
    ],
  };

  const record = threadRecordForBridge(bridge);

  assert.equal(record.id, "thread-1");
  assert.equal(record.name, "Current visible title");
  assert.equal(record.displayTitle, "Current visible title");
  assert.equal(record.preview, "Current visible title\nwith detail");
  assert.equal(record.updatedAt, 1_700_000_001_000);
});

test("threadListTimestamp accepts numeric and ISO timestamp fields", () => {
  assert.equal(threadListTimestamp({ updated_at_ms: 1234 }), 1234);
  assert.equal(threadListTimestamp({ updated_at: "2026-05-16T00:00:00.000Z" }), Date.parse("2026-05-16T00:00:00.000Z"));
  assert.equal(threadListTimestamp({}), 0);
});
