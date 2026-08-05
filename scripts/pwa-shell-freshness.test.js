// The phone installs the UI once and then keeps it. If the service worker
// answers shell requests from its cache whenever it has one, a fix can ship,
// the bridge can be restarted, and the phone still runs last week's JS - with
// nothing on screen to suggest caching is why. The bridge is on the same LAN,
// so the network is the fast path and the cache is the offline fallback.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "service-worker.js"), "utf8");

function loadServiceWorker({ online = true, cached = null } = {}) {
  const listeners = new Map();
  const store = new Map();
  if (cached) store.set(cached.url, cached.body);
  const keyFor = (request) => new URL(typeof request === "string" ? request : request.url, "http://bridge.local/").pathname;
  const cache = {
    async put(request, response) {
      store.set(keyFor(request), await response.text());
    },
    async match(request) {
      const body = store.get(keyFor(request));
      return body === undefined ? undefined : new Response(body);
    },
    async addAll() {},
  };
  const context = {
    self: {
      addEventListener: (type, handler) => listeners.set(type, handler),
      location: new URL("http://bridge.local/service-worker.js"),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cache,
      match: (request) => cache.match(request),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => {
      if (!online) throw new Error("the bridge is not reachable");
      return new Response("fresh build");
    },
    URL,
    Request,
    Response,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { listeners, store };
}

async function requestShellAsset(worker, url = "http://bridge.local/main.js") {
  const handler = worker.listeners.get("fetch");
  assert.ok(handler, "the worker registers a fetch handler");
  let responded;
  handler({ request: new Request(url), respondWith: (value) => (responded = value) });
  assert.ok(responded, "a shell request is answered by the worker");
  return await responded;
}

test("a running bridge serves the build it has now, not the one the phone installed", async () => {
  const worker = loadServiceWorker({ online: true, cached: { url: "/main.js", body: "stale build" } });
  const response = await requestShellAsset(worker);
  assert.equal(await response.text(), "fresh build");
});

test("an unreachable bridge still opens the app from the cache", async () => {
  const worker = loadServiceWorker({ online: false, cached: { url: "/main.js", body: "stale build" } });
  const response = await requestShellAsset(worker);
  assert.equal(await response.text(), "stale build");
});

test("what came back from the bridge becomes the offline copy", async () => {
  const worker = loadServiceWorker({ online: true, cached: { url: "/main.js", body: "stale build" } });
  await requestShellAsset(worker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.store.get("/main.js"), "fresh build", "the next flight without a bridge should not fall back a build");
});

test("token-bearing and API requests are left alone", async () => {
  const worker = loadServiceWorker({ online: true });
  const handler = worker.listeners.get("fetch");
  for (const url of ["http://bridge.local/api/thread?thread=abc", "http://bridge.local/main.js?token=secret"]) {
    let responded;
    handler({ request: new Request(url), respondWith: (value) => (responded = value) });
    assert.equal(responded, undefined, `${url} must not be served or stored by the worker`);
  }
});
