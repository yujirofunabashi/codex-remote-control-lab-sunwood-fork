// Real browser navigation and WebSockets, with isolated local bridge fixtures.
// No live account, session, credential or AI request is used.
// node scripts/bridge-navigation-smoke.js [--webkit]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { WebSocketServer } = require("ws");
const { requestTokenFromHeaders } = require("./start-phone");

const publicDir = path.resolve(__dirname, "../public");
const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function startFixture(machine, key) {
  const stats = { upgrades: 0, rejected: 0, prompts: 0, requests: [] };
  const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => "phone-bridge-v1" });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    stats.requests.push(req.url);
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-phone-token");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const json = (body, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname.startsWith("/api/")) {
      if (requestTokenFromHeaders(req.headers) !== key) return json({ error: "unauthorized" }, 401);
      const provider = url.searchParams.get("provider") || "claude";
      const cwd = `/fixture/${machine}`;
      if (["/api/info", "/api/bridge/info"].includes(url.pathname)) return json({
        provider: "claude", providers: ["codex", "claude"], model: "sonnet",
        workdir: cwd, cwd, machineLabel: machine === "air" ? "Air" : "mini",
      });
      if (url.pathname === "/api/threads") return json({ provider, activeProvider: provider, data: [{ id: `${machine}-${provider}`, provider, name: `${machine} saved chat`, cwd }], hiddenProjects: [] });
      if (url.pathname === "/api/thread") return json({ threadId: url.searchParams.get("thread"), provider, history: [{ type: "assistant", text: "saved fixture answer" }] });
      if (url.pathname === "/api/status") return json({ bridges: [] });
      // Keep the real UI's backup writes within this disposable fixture.
      if (url.pathname === "/api/bridge/registry") return json({ version: 1, revision: 1, bridges: [], tokens: {} });
      return json({ data: [] });
    }
    const file = path.resolve(publicDir, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${publicDir}${path.sep}`)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  server.on("upgrade", (req, socket, head) => {
    stats.upgrades++;
    if (requestTokenFromHeaders(req.headers) !== key) {
      stats.rejected++;
      return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const url = new URL(req.url, "http://localhost");
      const provider = url.searchParams.get("provider") || "codex";
      ws.send(JSON.stringify({ type: "ready", provider, threadId: url.searchParams.get("thread") || `${machine}-${provider}`, model: "gpt-6-astra", workdir: `/fixture/${machine}`, run: { state: "done" }, history: [{ type: "assistant", text: "saved fixture answer" }], clients: 1 }));
      ws.on("message", body => { if (JSON.parse(body).type === "prompt") stats.prompts++; });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, stats,
    disconnect: () => { for (const ws of sockets.clients) ws.close(); },
    close: async () => {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const mini = await startFixture("mini", "mini-fixture-key");
  const airKey = "air-fixture-key+/=\\n";
  const air = await startFixture("air", airKey);
  let browser;
  try {
    browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(({ miniOrigin, airOrigin, airKey }) => {
      if (location.origin !== miniOrigin || localStorage.getItem("fixture-seeded")) return;
      localStorage.setItem("fixture-seeded", "1");
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [{ id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true }] }));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: airKey }));
      localStorage.setItem("codexPhoneBridgeViewState:v1", JSON.stringify({ air: { provider: "codex", selectedThread: "air-codex" } }));
    }, { miniOrigin: mini.origin, airOrigin: air.origin, airKey });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${mini.origin}/?provider=codex#token=mini-fixture-key`);
    await page.waitForFunction(() => connectionReady);
    await page.locator("#prompt").fill("keep this unsent draft");
    await page.evaluate(() => openBridgeFleet());
    const popupPromise = context.waitForEvent("page");
    await page.locator(".bridge-sheet-card").filter({ hasText: air.origin }).getByRole("button", { name: "別タブ", exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await popup.waitForFunction(() => connectionReady && currentThreadProvider() === "codex", null, { timeout: 7000 });
    assert.equal(new URL(popup.url()).origin, air.origin);
    assert.equal(new URL(popup.url()).hash, "");
    assert.equal(new URL(popup.url()).searchParams.has("token"), false);
    assert.equal(await popup.evaluate(() => effectiveBridgeToken(activeBridge())), airKey);
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    assert.equal(await page.locator("#prompt").inputValue(), "keep this unsent draft");
    console.log("ok separate tab authenticates on the destination, removes the fragment, keeps Codex and preserves the source draft");

    // Same host, different port: the other slot can replace this cookie.
    await context.addCookies([{ name: "codex_phone_token", value: "stale-other-slot-key", url: air.origin }]);
    const before = air.stats.upgrades;
    air.disconnect();
    await popup.waitForFunction(() => connectionReady && ws?.readyState === WebSocket.OPEN);
    await popup.waitForTimeout(3500);
    assert.equal(air.stats.upgrades, before + 1, "exactly one recovery, not a reconnect loop");
    assert.equal(air.stats.rejected, 0, "explicit socket key must override the stale cookie");
    assert.equal(await popup.evaluate(() => connectionReady), true);
    await popup.reload();
    await popup.waitForFunction(() => connectionReady && currentThreadProvider() === "codex");
    assert.equal(await popup.evaluate(() => selectedThread), "air-codex");
    console.log("ok a stale cookie cannot reject the correct WebSocket key; reload retains authentication and conversation");

    await page.evaluate(() => setActiveBridge("air"));
    await page.waitForFunction(() => connectionReady && activeBridgeId === "air");
    const install = new URL(await page.evaluate(() => installEntryUrl()));
    assert.equal(install.origin, air.origin);
    assert.equal(install.pathname, "/install");
    assert.equal(install.searchParams.get("token"), airKey);
    assert.equal(install.searchParams.get("provider"), "codex");
    assert.ok(air.stats.requests.every(url => !url.includes("token=")), "ordinary requests never carry the navigation key in their URL");
    assert.equal(mini.stats.prompts + air.stats.prompts, 0);
    assert.deepEqual(errors, []);
    console.log("ok install link belongs to the selected destination; no prompts, leaked request URLs or browser errors");
  } finally {
    if (browser) await browser.close();
    await Promise.all([mini.close(), air.close()]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
