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
