const test = require("node:test");
const assert = require("node:assert/strict");

const { bridgeKeyForRequest, bridgeMatchesWorkdir, shouldDisposeIdleBridge, shouldPromoteBridgeKey, shouldReplaceBridgeForWorkdir } = require("./bridge-state");

test("new thread bridge requests share the startup URL bridge", () => {
  assert.equal(bridgeKeyForRequest("", "a"), "new:shared");
  assert.equal(bridgeKeyForRequest(null, "b"), "new:shared");
  assert.equal(bridgeKeyForRequest("", "a"), bridgeKeyForRequest("", "b"));
});

test("explicit fresh new thread requests get their own bridge key", () => {
  assert.equal(bridgeKeyForRequest("", "a", { fresh: true }), "new:a");
  assert.equal(bridgeKeyForRequest("", "a", { fresh: true }), bridgeKeyForRequest("", "a", { fresh: true }));
  assert.notEqual(bridgeKeyForRequest("", "a", { fresh: true }), bridgeKeyForRequest("", "b", { fresh: true }));
});

test("existing thread bridge requests keep the thread id as the shared key", () => {
  assert.equal(bridgeKeyForRequest("thread-123", "ignored"), "thread-123");
});

test("any idle bridge can be disposed when its last browser client leaves", () => {
  assert.equal(shouldDisposeIdleBridge({ clientCount: 0, ready: true }), true);
  assert.equal(shouldDisposeIdleBridge({ clientCount: 1, ready: true }), false);
  assert.equal(shouldDisposeIdleBridge({ clientCount: 0, ready: false }), true);
  assert.equal(shouldDisposeIdleBridge({ clientCount: 0, ready: true, active: true }), false);
});

test("new bridge keys promote to the real thread id once ready", () => {
  assert.equal(shouldPromoteBridgeKey({ bridgeKey: "new:a", threadId: "thread-123" }), true);
  assert.equal(shouldPromoteBridgeKey({ bridgeKey: "thread-123", threadId: "thread-123" }), false);
  assert.equal(shouldPromoteBridgeKey({ bridgeKey: "new:a", threadId: "" }), false);
});

test("workdir-aware bridge reuse rejects stale idle bridges", () => {
  assert.equal(bridgeMatchesWorkdir({ bridgeWorkdir: "/tmp/app/", targetWorkdir: "/tmp/app" }), true);
  assert.equal(bridgeMatchesWorkdir({ bridgeWorkdir: "/tmp/app", targetWorkdir: "/tmp/other" }), false);
  assert.equal(shouldReplaceBridgeForWorkdir({ bridgeWorkdir: "/tmp/app", targetWorkdir: "/tmp/other", active: false }), true);
  assert.equal(shouldReplaceBridgeForWorkdir({ bridgeWorkdir: "/tmp/app", targetWorkdir: "/tmp/other", active: true }), false);
});
