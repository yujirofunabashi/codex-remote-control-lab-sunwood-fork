const test = require("node:test");
const assert = require("node:assert/strict");

const { findLiveBridge, liveBridgeSnapshot, readThreadSnapshot } = require("./thread-read");

test("liveBridgeSnapshot returns ready in-memory bridge history", () => {
  assert.deepEqual(
    liveBridgeSnapshot(
      {
        ready: true,
        threadId: "thread-123",
        history: [{ type: "status", text: "ready" }],
      },
      "thread-123",
    ),
    {
      threadId: "thread-123",
      ready: true,
      history: [{ type: "status", text: "ready" }],
      source: "live-bridge",
    },
  );
});

test("findLiveBridge finds bridges by promoted thread id", () => {
  const bridge = { threadId: "thread-123", requestedThreadId: null };
  const bridges = new Map([["thread-123", bridge]]);

  assert.equal(findLiveBridge(bridges, "thread-123"), bridge);
});

test("findLiveBridge finds starting bridges by requested thread id", () => {
  const bridge = { threadId: null, requestedThreadId: "thread-123" };
  const bridges = new Map([["connection-temp-key", bridge]]);

  assert.equal(findLiveBridge(bridges, "thread-123"), bridge);
});

test("findLiveBridge filters by requested workdir when provided", () => {
  const wrong = { threadId: "thread-123", requestedThreadId: null, workdir: "/tmp/app" };
  const right = { threadId: "thread-123", requestedThreadId: null, workdir: "/tmp/other" };
  const bridges = new Map([
    ["thread-123::/tmp/app", wrong],
    ["thread-123::/tmp/other", right],
  ]);

  assert.equal(findLiveBridge(bridges, "thread-123", { workdir: "/tmp/other/" }), right);
  assert.equal(findLiveBridge(bridges, "thread-123", { workdir: "/tmp/missing" }), null);
});

test("findLiveBridge never supplies the other provider's history for a matching id", () => {
  const claude = { provider: "claude", threadId: "shared-id", ready: true, history: [{ type: "assistant", text: "Claude only" }] };
  const codex = { provider: "codex", requestedThreadId: "shared-id", ready: false };
  const bridges = new Map([["shared-id", claude]]);
  assert.equal(findLiveBridge(bridges, "shared-id", { provider: "codex" }), null);
  bridges.set("codex:shared-id", codex);
  assert.equal(findLiveBridge(bridges, "shared-id", { provider: "codex" }), codex);
  assert.equal(findLiveBridge(bridges, "shared-id", { provider: "claude" }), claude);
});

test("readThreadSnapshot does not call app-server for a live bridge thread", async () => {
  let calls = 0;
  const snapshot = await readThreadSnapshot({
    threadId: "thread-123",
    liveBridge: {
      ready: true,
      threadId: "thread-123",
      history: [{ type: "assistant", text: "hello" }],
    },
    request: async () => {
      calls += 1;
      throw new Error("should not call app-server");
    },
    model: "gpt-5.4",
    workdir: "/tmp/user-project",
    historyFromThread: () => [],
  });

  assert.equal(calls, 0);
  assert.equal(snapshot.source, "live-bridge");
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.history, [{ type: "assistant", text: "hello" }]);
});

test("readThreadSnapshot does not call app-server while an existing bridge is still starting", async () => {
  let calls = 0;
  const snapshot = await readThreadSnapshot({
    threadId: "thread-123",
    liveBridge: {
      ready: false,
      requestedThreadId: "thread-123",
      threadId: null,
      history: [],
    },
    request: async () => {
      calls += 1;
      throw new Error("should not call app-server while bridge is starting");
    },
    model: "gpt-5.4",
    workdir: "/tmp/user-project",
    historyFromThread: () => [],
  });

  assert.equal(calls, 0);
  assert.equal(snapshot.source, "live-bridge");
  assert.equal(snapshot.ready, false);
  assert.deepEqual(snapshot.history, []);
});

test("readThreadSnapshot reports read failure without mutating a failed live thread", async () => {
  const calls = [];
  await assert.rejects(readThreadSnapshot({
    threadId: "thread-123",
    liveBridge: {
      ready: false,
      startupFailed: true,
      requestedThreadId: "thread-123",
      threadId: null,
      history: [],
    },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") throw new Error("stale cache");
      return { thread: { id: "thread-123", turns: [] } };
    },
    model: "gpt-5.4",
    workdir: "/tmp/user-project",
    historyFromThread: () => [{ type: "status", text: "resumed" }],
  }), /stale cache/);
  assert.deepEqual(calls.map((call) => call.method), ["thread/read"]);
});

test("readThreadSnapshot never resumes or changes settings for a missing non-live thread", async () => {
  const calls = [];
  await assert.rejects(readThreadSnapshot({
    threadId: "thread-456",
    liveBridge: null,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") throw new Error("no rollout found");
      return { thread: { id: "thread-456", items: [] } };
    },
    model: "gpt-5.4",
    workdir: "/tmp/user-project",
    historyFromThread: () => [{ type: "status", text: "loaded" }],
  }), /no rollout found/);
  assert.deepEqual(calls.map((call) => call.method), ["thread/read"]);
});

test("readThreadSnapshot remains read-only after the upstream disconnects", async () => {
  // bridge is still starting (ready:false) but socket dropped before thread/start RPC returned
  // startupFailed should be true (set by upstream close/error handler while !ready)
  const calls = [];
  await assert.rejects(readThreadSnapshot({
    threadId: "thread-123",
    liveBridge: {
      ready: false,
      startupFailed: true,
      requestedThreadId: "thread-123",
      threadId: null,
      history: [],
    },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") throw new Error("not found");
      return { thread: { id: "thread-123", turns: [] } };
    },
    model: "gpt-5.4",
    workdir: "/tmp/user-project",
    historyFromThread: () => [{ type: "status", text: "reconnected" }],
  }), /not found/);
  assert.deepEqual(calls.map((c) => c.method), ["thread/read"]);
});
