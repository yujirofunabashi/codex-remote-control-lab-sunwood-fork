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
            ...writeRegistry({ ...store, bridges: body.bridges, tokens: body.tokens, expectedRevision: body.revision }),
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
      res.writeHead(200, { "content-type": mime.get(path.extname(file)) || "application/octet-stream" });
      res.end(data);
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

async function run() {
  const tempDir = fs.mkdtempSync(path.join(root, ".tmp-registry-smoke-"));
  const store = { filePath: registryPathForPort(tempDir, 45214), keyPath: registryKeyPath(tempDir) };
  const { server, origin } = await startServer(store);
  let browser;

  try {
    browser = await chromium.launch();

    // A phone that already knows about a second machine, syncing it upward.
    const seeded = await browser.newContext();
    const seedPage = await seeded.newPage();
    await stubWebSocket(seedPage);
    await seedPage.addInitScript(
      ([bridgeId, baseUrl, bridgeToken]) => {
        localStorage.setItem(
          "codexPhoneBridgeRegistry:v1",
          JSON.stringify({ version: 1, bridges: [{ id: bridgeId, label: "Air", baseUrl, kind: "mesh", rememberToken: true, updatedAt: 10 }] }),
        );
        localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ [bridgeId]: bridgeToken }));
      },
      [remoteBridgeId, remoteBridgeUrl, remoteBridgeToken],
    );
    await seedPage.goto(`${origin}/?token=${token}`, { waitUntil: "domcontentloaded" });

    let backup = { bridges: [] };
    for (let attempt = 0; attempt < 40 && backup.bridges.length < 2; attempt += 1) {
      await seedPage.waitForTimeout(250);
      backup = fs.existsSync(store.filePath) ? readRegistry(store) : { bridges: [], tokens: {} };
    }
    await seeded.close();

    check("a synced registry reaches the bridge", backup.bridges.length === 2, `${backup.bridges.length} bridges`);
    check("the remembered token is backed up", backup.tokens?.[remoteBridgeId] === remoteBridgeToken);

    const raw = fs.readFileSync(store.filePath, "utf8");
    check("the backup file holds no plaintext token", !raw.includes(remoteBridgeToken) && !raw.includes(token));
    check("the backup file stays owner-only", (fs.statSync(store.filePath).mode & 0o777) === 0o600);
    check("the registry key stays owner-only", (fs.statSync(store.keyPath).mode & 0o777) === 0o600);

    const unauthorized = await fetch(`${origin}/api/bridge/registry`);
    check("an unauthenticated read is refused", unauthorized.status === 401, `status ${unauthorized.status}`);

    // The reinstall: a context with nothing in storage, exactly like a Home
    // Screen app added back from the install URL.
    const restored = await browser.newContext();
    const restorePage = await restored.newPage();
    await stubWebSocket(restorePage);
    await restorePage.goto(`${origin}/?token=${token}`, { waitUntil: "domcontentloaded" });
    await restorePage
      .waitForFunction(
        (bridgeId) => {
          const parsed = JSON.parse(localStorage.getItem("codexPhoneBridgeRegistry:v1") || "null");
          return Boolean(parsed?.bridges?.some((bridge) => bridge.id === bridgeId));
        },
        remoteBridgeId,
        { timeout: 15_000 },
      )
      .catch(() => null);
    const client = await readClientRegistry(restorePage);
    await restored.close();

    const restoredIds = (client.registry?.bridges || []).map((bridge) => bridge.id);
    check("an empty install recovers both bridges", restoredIds.length === 2, restoredIds.join(", ") || "none");
    check("the recovered bridge is the one that was lost", restoredIds.includes(remoteBridgeId));
    check("its token comes back with it", client.tokens?.[remoteBridgeId] === remoteBridgeToken);

    const afterRestore = readRegistry(store);
    check("the empty install did not overwrite the backup", afterRestore.bridges.length === 2, `${afterRestore.bridges.length} bridges`);
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
