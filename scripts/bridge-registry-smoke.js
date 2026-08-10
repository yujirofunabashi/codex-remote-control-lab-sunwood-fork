// End-to-end check for bridge registry backup and recovery.
//
// The unit tests cover the store; what they cannot show is the part that
// matters to the owner: that a phone which has forgotten everything gets its
// machines back. This boots the real `public/` bundle against a real
// `/api/bridge/registry` backed by the real store, syncs a registry from one
// browser context, then opens a second context with empty storage - the state
// a reinstalled Home Screen app starts from - and checks what comes back.
//
// Run with `node scripts/bridge-registry-smoke.js`.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const { readRegistry, registryKeyPath, registryPathForPort } = require("./bridge-registry-store");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const token = "registry-smoke-token";
const remoteBridgeId = "air-45214";
const remoteBridgeUrl = "http://100.64.0.2:45214";
const remoteBridgeToken = "air-secret-token";

const mime = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

const checks = [];

// The service worker fetches each shell file separately and falls back to its
// cache per file, so a phone can run this release's main.js beside a cached
// phone-ui-utils.js from before the registry sync existed. Serving the helper
// bundle with those exports removed reproduces that pairing.
let serveLegacyHelpers = false;

function legacyHelperBundle(source) {
  return source.replace(/^\s*(bridgeRegistrySyncVersion|mergeBridgeRegistries|mergeBridgeTokens),\n/gm, "");
}

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
}

function isInsideDir(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requestToken(req, url) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token") || "";
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// The store is the real module; only the surrounding bridge is stubbed, so a
// mistake in the file format or the conflict rules still fails this check.
function startServer(store) {
  const { RegistryConflictError, RegistryUnreadableError, writeRegistry } = require("./bridge-registry-store");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const sendJson = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/bridge/registry") {
      if (requestToken(req, url) !== token) return sendJson(401, { error: "invalid token" });
      if (req.method === "GET") {
        try {
          return sendJson(200, { ok: true, ...readRegistry(store) });
        } catch (error) {
          const code = error instanceof RegistryUnreadableError ? error.code : "registry-error";
          return sendJson(409, { error: error.message, code });
        }
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        try {
          return sendJson(200, {
            ok: true,
            ...writeRegistry({ ...store, bridges: body.bridges, deleted: body.deleted, tokens: body.tokens, expectedRevision: body.revision }),
          });
        } catch (error) {
          if (error instanceof RegistryConflictError) {
            return sendJson(409, { error: error.message, code: error.code, current: error.current || null });
          }
          return sendJson(400, { error: error.message });
        }
      }
      return sendJson(405, { error: "method not allowed" });
    }

    if (url.pathname.startsWith("/api/")) {
      if (requestToken(req, url) !== token) return sendJson(401, { error: "invalid token" });
      if (url.pathname === "/api/bridge/info") return sendJson(200, { label: "smoke bridge", hostName: "smoke", uiPort: 45214, cwd: root });
      if (url.pathname === "/api/threads") return sendJson(200, { data: [] });
      if (url.pathname === "/api/status") return sendJson(200, { uiPort: 45214, workdir: root, bridges: [] });
      return sendJson(200, { data: [] });
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.resolve(publicDir, `.${pathname}`);
    if (!isInsideDir(publicDir, file)) return res.writeHead(403).end("Forbidden");
    return fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end("Not found");
      const body = serveLegacyHelpers && pathname === "/phone-ui-utils.js" ? legacyHelperBundle(data.toString("utf8")) : data;
      res.writeHead(200, { "content-type": mime.get(path.extname(file)) || "application/octet-stream" });
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

// The page opens a socket on load; a stub keeps the run from turning into a
// reconnect loop while the registry work it is here to test happens.
async function stubWebSocket(page) {
  await page.addInitScript(() => {
    class QuietWebSocket extends EventTarget {
      constructor() {
        super();
        this.readyState = 0;
      }

      send() {}

      close() {
        this.readyState = 3;
      }
    }
    QuietWebSocket.OPEN = 1;
    window.WebSocket = QuietWebSocket;
  });
}

async function readClientRegistry(page) {
  return page.evaluate(() => ({
    registry: JSON.parse(localStorage.getItem("codexPhoneBridgeRegistry:v1") || "null"),
    tokens: JSON.parse(localStorage.getItem("codexPhoneBridgeTokens:v1") || "null"),
  }));
}

// `seed` is the localStorage a phone would already be carrying; omit it for the
// blank slate a reinstalled Home Screen app starts from.
async function openContext(browser, origin, seed = null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubWebSocket(page);
  if (seed) {
    await page.addInitScript((payload) => {
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify(payload.registry));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify(payload.tokens || {}));
      localStorage.setItem("codexPhoneBridgeTokenTimes:v1", JSON.stringify(payload.tokenTimes || {}));
    }, seed);
  }
  // The registry re-read is five minutes apart in normal use; the check would
  // otherwise have to run for that long to see a device converge.
  await page.goto(`${origin}/?token=${token}&registryRefreshMs=4000`, { waitUntil: "domcontentloaded" });
  return { context, page };
}

function currentBackup(store) {
  if (!fs.existsSync(store.filePath)) return { bridges: [], deleted: [], tokens: {} };
  return readRegistry(store);
}

async function waitForBackup(page, store, predicate) {
  let backup = currentBackup(store);
  for (let attempt = 0; attempt < 40 && !predicate(backup); attempt += 1) {
    await page.waitForTimeout(250);
    backup = currentBackup(store);
  }
  return backup;
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-registry-smoke-"));
  const store = { filePath: registryPathForPort(tempDir, 45214), keyPath: registryKeyPath(tempDir) };
  const { server, origin } = await startServer(store);
  let browser;

  try {
    browser = await chromium.launch();

    // A phone that already knows about a second machine, syncing it upward.
    // Timestamps are current, not 1970: a bridge whose dates are older than
    // every tombstone would pass the deletion checks below for the wrong
    // reason.
    const registeredAt = Date.now();
    const knownBridge = {
      id: remoteBridgeId,
      label: "Air",
      baseUrl: remoteBridgeUrl,
      kind: "mesh",
      rememberToken: true,
      createdAt: registeredAt,
      updatedAt: registeredAt,
    };
    const seeded = await openContext(browser, origin, {
      registry: { version: 1, bridges: [knownBridge] },
      tokens: { [remoteBridgeId]: remoteBridgeToken },
      tokenTimes: { [remoteBridgeId]: 10 },
    });
    const backup = await waitForBackup(seeded.page, store, (current) => current.bridges.length >= 2);
    await seeded.context.close();

    check("a synced registry reaches the bridge", backup.bridges.length === 2, `${backup.bridges.length} bridges`);
    check("the remembered token is backed up", backup.tokens?.[remoteBridgeId]?.token === remoteBridgeToken);

    const raw = fs.readFileSync(store.filePath, "utf8");
    check("the backup file holds no plaintext token", !raw.includes(remoteBridgeToken) && !raw.includes(token));
    check("the backup file stays owner-only", (fs.statSync(store.filePath).mode & 0o777) === 0o600);
    check("the registry key stays owner-only", (fs.statSync(store.keyPath).mode & 0o777) === 0o600);

    const unauthorized = await fetch(`${origin}/api/bridge/registry`);
    check("an unauthenticated read is refused", unauthorized.status === 401, `status ${unauthorized.status}`);

    // The reinstall: a context with nothing in storage, exactly like a Home
    // Screen app added back from the install URL.
    const restored = await openContext(browser, origin);
    await restored.page
      .waitForFunction(
        (bridgeId) => {
          const parsed = JSON.parse(localStorage.getItem("codexPhoneBridgeRegistry:v1") || "null");
          return Boolean(parsed?.bridges?.some((bridge) => bridge.id === bridgeId));
        },
        remoteBridgeId,
        { timeout: 15_000 },
      )
      .catch(() => null);
    const client = await readClientRegistry(restored.page);
    await restored.context.close();

    const restoredIds = (client.registry?.bridges || []).map((bridge) => bridge.id);
    check("an empty install recovers both bridges", restoredIds.length === 2, restoredIds.join(", ") || "none");
    check("the recovered bridge is the one that was lost", restoredIds.includes(remoteBridgeId));
    check("its token comes back with it", client.tokens?.[remoteBridgeId] === remoteBridgeToken);

    const afterRestore = readRegistry(store);
    check("the empty install did not overwrite the backup", afterRestore.bridges.length === 2, `${afterRestore.bridges.length} bridges`);

    const homeBridge = afterRestore.bridges.find((bridge) => bridge.id !== remoteBridgeId);

    // The phone that is simply left on screen. It is opened BEFORE the
    // deletion and kept open across it, because that ordering is the whole
    // problem: its fleet poll re-reads the Air every few seconds, and if that
    // counts as registering the bridge again, the deletion never survives.
    const openDevice = await openContext(browser, origin, {
      // Carrying the home bridge's token too, so this really is a device with
      // nothing new to say: anything it writes is something it should not.
      registry: { version: 1, bridges: [homeBridge, knownBridge] },
      tokens: { [remoteBridgeId]: remoteBridgeToken, [homeBridge.id]: token },
      tokenTimes: { [remoteBridgeId]: registeredAt, [homeBridge.id]: backup.tokens[homeBridge.id]?.updatedAt || registeredAt },
    });
    await openDevice.page.waitForTimeout(9000);

    // A second device deletes the Air while the first one is still watching it.
    const deleter = await openContext(browser, origin, {
      registry: { version: 1, bridges: [homeBridge], deleted: [{ id: remoteBridgeId, deletedAt: Date.now() }] },
    });
    const afterDelete = await waitForBackup(deleter.page, store, (current) => current.bridges.length === 1);
    await deleter.context.close();

    check("a deletion reaches the backup", afterDelete.bridges.length === 1, afterDelete.bridges.map((bridge) => bridge.id).join(", "));
    check("the removal is recorded, not just absent", afterDelete.deleted.some((record) => record.id === remoteBridgeId));
    check("the deleted bridge's token is dropped", !afterDelete.tokens?.[remoteBridgeId]);

    // Two more poll cycles with the first device still open.
    await openDevice.page.waitForTimeout(18_000);
    const staleClient = await readClientRegistry(openDevice.page);
    await openDevice.context.close();

    const staleIds = (staleClient.registry?.bridges || []).map((bridge) => bridge.id);
    check("an open device drops the bridge deleted under it", !staleIds.includes(remoteBridgeId), staleIds.join(", "));
    const afterStale = readRegistry(store);
    check(
      "an open device does not resurrect it in the backup",
      !afterStale.bridges.some((bridge) => bridge.id === remoteBridgeId),
      afterStale.bridges.map((bridge) => bridge.id).join(", "),
    );
    check("its token stays dropped", !afterStale.tokens?.[remoteBridgeId]);
    check(
      "the removal record survives the open device",
      afterStale.deleted.some((record) => record.id === remoteBridgeId),
      afterStale.deleted.map((record) => record.id).join(", ") || "none",
    );
    // Polling is not editing, so an app sitting on screen rewrites nothing.
    check(
      "an idle device does not rewrite the backup",
      afterStale.revision === afterDelete.revision,
      `revision ${afterDelete.revision} -> ${afterStale.revision}`,
    );

    // A phone whose cached helper bundle predates the sync. It cannot merge,
    // so it must not sync: pushing its own list would put the deleted bridge
    // back and drop whatever the backup knows that it does not.
    serveLegacyHelpers = true;
    const beforeMixed = readRegistry(store);
    const mixed = await openContext(browser, origin, {
      registry: { version: 1, bridges: [homeBridge, knownBridge] },
      tokens: { [remoteBridgeId]: remoteBridgeToken },
      tokenTimes: { [remoteBridgeId]: 10 },
    });
    const capability = await mixed.page.evaluate(() => Number(window.CodexPhoneUiUtils?.bridgeRegistrySyncVersion || 0));
    await mixed.page.waitForTimeout(4000);
    await mixed.context.close();
    serveLegacyHelpers = false;

    const afterMixed = readRegistry(store);
    check("the old helper bundle really lacks the sync capability", capability === 0, `version ${capability}`);
    check("a shell that cannot merge does not write to the backup", afterMixed.revision === beforeMixed.revision, `revision ${afterMixed.revision}`);
    check(
      "it does not resurrect the deleted bridge",
      !afterMixed.bridges.some((bridge) => bridge.id === remoteBridgeId),
      afterMixed.bridges.map((bridge) => bridge.id).join(", "),
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const result of checks) {
    const tag = result.ok ? "PASS" : "FAIL";
    if (!result.ok) failed += 1;
    console.log(`${tag}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
