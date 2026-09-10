const CACHE_NAME = "codex-phone-shell-v5";
const APP_SHELL = [
  "./",
  "./style.css",
  "./main.js",
  "./phone-ui-utils.js",
  "./operation-context.js",
  "./site.webmanifest",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

function isSafeShellRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.searchParams.has("token") || url.searchParams.has("key")) return false;
  const appPath = url.pathname.replace(/^\/(?:abs)?proxy\/\d+(?=\/|$)/, "") || "/";
  if (appPath.startsWith("/api/") || appPath === "/bridge") return false;
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME && key.startsWith("codex-phone-shell-")).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The shell used to be answered from the cache whenever it was there at all, so
// a phone kept running the JS it had installed no matter how many times the
// bridge was updated and restarted: fixes shipped, the phone never saw them, and
// nothing about it looked like caching. The bridge is a machine on the same LAN,
// so the network is the fast path. Ask it first, keep the cache fresh from what
// comes back, and fall back to the cache only when it cannot be reached - which
// is the case the cache was added for.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const copy = response.clone();
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(request, copy))
        .catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  if (!isSafeShellRequest(event.request)) return;
  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request).catch(() => caches.match("./")));
    return;
  }
  event.respondWith(networkFirst(event.request));
});
