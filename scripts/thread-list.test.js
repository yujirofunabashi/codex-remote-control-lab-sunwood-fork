const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeThreadListData, threadListTimestamp, threadRecordForBridge } = require("./start-phone");

test("mergeThreadListData includes live local Codex threads missing from remote list", () => {
  const remote = [{ id: "remote-1", name: "Remote thread", updatedAt: 1000, provider: "codex" }];
  const local = [{ id: "live-1", name: "Live prompt", preview: "Live prompt", updatedAt: 2000, localActivityAt: 2000, provider: "codex" }];

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

test("mergeThreadListData preserves remote cwd when reconnect metadata is stale", () => {
  const merged = mergeThreadListData(
    [
      {
        id: "thread-1",
        name: "Trading work",
        cwd: "/Users/minijiro/WORK_LOCAL/00_WORKSPACE/personal/trading-lab",
        repoName: "trading-lab",
        updatedAt: 2000,
        provider: "codex",
      },
    ],
    [
      {
        id: "thread-1",
        name: "Trading work",
        cwd: "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab",
        repoName: "codex-remote-control-lab",
        updatedAt: 999999,
        localActivityAt: 0,
        provider: "codex",
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].cwd, "/Users/minijiro/WORK_LOCAL/00_WORKSPACE/personal/trading-lab");
  assert.equal(merged[0].repoName, "trading-lab");
});

test("mergeThreadListData keeps remote cwd as canonical even when a live bridge is newer", () => {
  const merged = mergeThreadListData(
    [
      {
        id: "thread-1",
        name: "Trading work",
        cwd: "/Users/minijiro/WORK_LOCAL/00_WORKSPACE/personal/trading-lab",
        repoName: "trading-lab",
        updatedAt: 2000,
        provider: "codex",
      },
    ],
    [
      {
        id: "thread-1",
        name: "Trading work",
        cwd: "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab",
        repoName: "codex-remote-control-lab",
        lastExecutionCwd: "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab",
        updatedAt: 999999,
        localActivityAt: 999999,
        contextSource: "live-bridge",
        provider: "codex",
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].cwd, "/Users/minijiro/WORK_LOCAL/00_WORKSPACE/personal/trading-lab");
  assert.equal(merged[0].repoName, "trading-lab");
  assert.equal(merged[0].lastExecutionCwd, "/Users/minijiro/WORK_LOCAL/00_MINI_WORKSPACE/codex-remote-control-lab");
  assert.equal(merged[0].updatedAt, 999999);
});

test("threadRecordForBridge gives ready payload and local list the same display title", () => {
  const bridge = {
    threadId: "thread-1",
    provider: "codex",
    workdir: "/tmp/other-repo",
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
  assert.equal(record.cwd, "/tmp/other-repo");
  assert.equal(record.bridgeWorkdir, "/tmp/other-repo");
  assert.equal(record.lastExecutionCwd, "/tmp/other-repo");
  assert.equal(record.updatedAt, 1_700_000_001_000);
});

test("threadRecordForBridge does not make a reconnect look like recent thread activity", () => {
  const record = threadRecordForBridge({
    threadId: "thread-1",
    provider: "codex",
    workdir: "/tmp/other-repo",
    createdAt: 1_700_000_000_000,
    listUpdatedAt: 0,
    runState: { state: "done", updatedAt: 1_700_000_099_999 },
    history: [{ type: "user", text: "Existing thread" }],
  });

  assert.equal(record.updatedAt, 0);
  assert.equal(record.createdAt, 0);
  assert.equal(record.localActivityAt, 0);
});

test("threadListTimestamp accepts numeric and ISO timestamp fields", () => {
  assert.equal(threadListTimestamp({ updated_at_ms: 1234 }), 1234);
  assert.equal(threadListTimestamp({ updated_at: "2026-05-16T00:00:00.000Z" }), Date.parse("2026-05-16T00:00:00.000Z"));
  assert.equal(threadListTimestamp({}), 0);
});
