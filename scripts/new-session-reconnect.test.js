const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { bridgeKeyForRequest, bridgeMatchesWorkdir, shouldReplaceBridgeForWorkdir } = require("./bridge-state");

// Exercise the real resolver with in-memory bridges. No servers, credentials,
// session files or notification channels participate.
const source = fs.readFileSync(require.resolve("./start-phone"), "utf8");
const resolver = source.slice(source.indexOf("function getBridge("), source.indexOf("\n// The phone remembers a cwd", source.indexOf("function getBridge(")));

function fixture() {
  const bridges = new Map();
  function create(provider) {
    return class {
      constructor(threadId, key, options) {
        Object.assign(this, { provider, requestedThreadId: threadId, threadId: threadId || key, workdir: options.workdir, options });
      }
      isReusable() { return !this.disposed; }
      hasActiveWork() { return false; }
      dispose() { this.disposed = true; }
    };
  }
  const context = vm.createContext({
    bridges, bridgeKeyForRequest, bridgeMatchesWorkdir, shouldReplaceBridgeForWorkdir,
    workdir: "/fixture/default", agentProvider: "codex", validateWorkdir: value => value,
    normalizeProvider: value => value, normalizeServiceTier: value => value,
    bridgeMapKey: (provider, key) => `${provider}:${key}`,
    SharedBridge: create("codex"), ClaudeBridge: create("claude"),
  });
  vm.runInContext(resolver, context);
  return { bridges, getBridge: context.getBridge };
}

for (const provider of ["codex", "claude"]) {
  test(`${provider}: a lost ready retries only its own creation, even after promotion`, () => {
    const { bridges, getBridge } = fixture();
    const options = { fresh: true, newSessionId: "request-a", workdir: "/fixture/article" };
    const previous = getBridge(null, provider, "old", { workdir: options.workdir });
    const pending = getBridge(null, provider, "first", options);
    assert.notEqual(pending, previous);
    assert.equal(getBridge(null, provider, "retry-before-ready", options), pending);
    // The server promotes the key as soon as it has an id, before the phone
    // necessarily receives ready. Request ownership must survive that rename.
    for (const [key, bridge] of bridges) if (bridge === pending) bridges.delete(key);
    pending.threadId = "created-thread";
    bridges.set(`${provider}:created-thread`, pending);
    assert.equal(getBridge(null, provider, "retry-after-ready", options), pending);
    assert.notEqual(getBridge(null, provider, "second", { ...options, newSessionId: "request-b" }), pending);
    assert.throws(() => getBridge(null, provider, "wrong-folder", { ...options, workdir: "/fixture/other" }), /workdir|folder/i);
    assert.notEqual(getBridge(null, provider === "codex" ? "claude" : "codex", "other-provider", options), pending);
  });
}

function tryError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

// A bridge created from the sidebar "+" keeps requestedThreadId null even after
// it owns a real thread. A no-thread reconnect (a provider tab, a Mac switch, a
// plain reload with nothing selected) must not join that live conversation, nor
// - in another folder - dispose the bridge whose phone is watching it.
for (const provider of ["codex", "claude"]) {
  test(`${provider}: a promoted new-chat bridge is neither hijacked nor evicted by a no-thread reconnect`, () => {
    const { bridges, getBridge } = fixture();
    const created = getBridge(null, provider, "plus", { fresh: true, newSessionId: "r1", workdir: "/fixture/article" });
    // Promote it the way the server does: key becomes the thread id, a phone is
    // connected, and requestedThreadId is still null.
    for (const [key, bridge] of bridges) if (bridge === created) bridges.delete(key);
    created.threadId = "real-thread";
    created.requestedThreadId = null;
    created.clients = new Set([{}]);
    bridges.set(`${provider}:real-thread`, created);

    const sameFolder = getBridge(null, provider, "reopen-same", { workdir: "/fixture/article" });
    assert.notEqual(sameFolder, created, "a no-thread reconnect must not join a live '+' conversation");

    const otherFolder = getBridge(null, provider, "reopen-other", { workdir: "/fixture/other" });
    assert.notEqual(otherFolder, created);
    assert.equal(created.disposed, undefined, "a client-attached bridge is never evicted for a folder mismatch");
    assert.equal(bridges.get(`${provider}:real-thread`), created, "the live bridge stays registered");

    assert.equal(getBridge("real-thread", provider, "by-id", {}), created, "and is still reachable by its real id");
  });
}

// A bridge a phone is connected to is not a stale hint to clean up, even before
// it has started a conversation: evicting it would drop that phone.
test("a client-attached bridge survives a folder-mismatch reconnect", () => {
  const { bridges, getBridge } = fixture();
  const live = getBridge(null, "codex", "live", { workdir: "/fixture/aaa" });
  live.threadId = null;
  live.requestedThreadId = null;
  live.clients = new Set([{}]);
  getBridge(null, "codex", "other", { workdir: "/fixture/bbb" });
  assert.equal(live.disposed, undefined, "the connected phone's bridge is not disposed");
  assert.equal(bridges.get("codex:new:shared"), live, "it stays under its key");
});

// A Claude session names itself only after its first turn. Until then the phone
// dials back with the provisional `claude:<uuid>` from `ready`; that must find
// the live bridge, not build an empty second one under a `claude:claude:` key.
test("a provisional Claude id resolves to its live bridge, not an empty second one", () => {
  const { getBridge } = fixture();
  const fresh = getBridge(null, "claude", "c1", { fresh: true, newSessionId: "r9", workdir: "/fixture/article" });
  fresh.provisionalThreadId = "claude:abcd";
  fresh.threadId = "claude:abcd";
  assert.equal(getBridge("claude:abcd", "claude", "c2", { workdir: "/fixture/article" }), fresh, "reconnect by provisional id reuses the bridge");
  // Survives promotion: threadId moves onto the real id, provisionalThreadId stays.
  fresh.threadId = "real-session-id";
  assert.equal(getBridge("claude:abcd", "claude", "c3", {}), fresh, "a stale provisional id still resolves after promotion");
  assert.notEqual(getBridge("some-real-id", "claude", "c4", {}), fresh, "a real session id is unaffected by this path");
});

// An unfulfillable new-session request is final; it must be flagged so the phone
// drops the held request instead of dialling back with it once a second.
test("an unfulfillable new-session request throws a non-retryable, coded error", () => {
  const { getBridge } = fixture();
  const options = { fresh: true, newSessionId: "r", workdir: "/fixture/article" };
  const pending = getBridge(null, "codex", "c1", options);

  const changed = tryError(() => getBridge(null, "codex", "c2", { ...options, workdir: "/fixture/other" }));
  assert.equal(changed.retryable, false);
  assert.equal(changed.code, "new_session_workdir_changed");

  const bad = tryError(() => getBridge(null, "codex", "c3", { fresh: true, newSessionId: "bad id!", workdir: "/fixture/article" }));
  assert.equal(bad.retryable, false);
  assert.equal(bad.code, "invalid_new_session_id");

  pending.disposed = true; // isReusable() -> false
  const unusable = tryError(() => getBridge(null, "codex", "c4", options));
  assert.equal(unusable.retryable, false);
  assert.equal(unusable.code, "new_session_unavailable");
});
