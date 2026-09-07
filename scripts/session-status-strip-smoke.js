// Frontend-only integration check. No real bridges, credentials or turns.
// node scripts/session-status-strip-smoke.js [--webkit] [--shots]
// SESSION_SMOKE_ORIGIN may point at a served UI; all API/socket traffic is
// still mocked, so this verifies delivered assets without opening real chats.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { idleRunStateFromHistory } = require("./question-state");
const root = path.resolve(__dirname, "..");
const airOrigin = process.env.SESSION_SMOKE_ORIGIN?.startsWith("https:") ? "https://air.fixture.invalid:45999" : "http://127.0.0.1:45999";
const build = { available: true, fingerprint: "test", clientFingerprint: "test", serverFingerprint: "test", head: "a".repeat(40), dirty: false, restartRequired: false, upstream: { name: "origin/develop", ahead: 0, behind: 0 } };
const run = (threadId, provider, state, title, machine = "mini") => ({ threadId, provider, workdir: `/fixture/${machine}/project`, run: { state, updatedAt: 100 }, title });
const state = {
  airOffline: false,
  mini: [run("shared", "codex", "running", "mini の処理中"), run("finished", "codex", "done", "mini の未確認完了"), run("shared", "claude", "question", "mini の質問")],
  air: [run("permission", "claude", "approval", "Air の許可待ち", "air"), run("shared", "codex", "error", "Air のエラー", "air")],
};

async function main() {
  const publicDir = path.join(root, "public");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${publicDir}${path.sep}`)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" })[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = process.env.SESSION_SMOKE_ORIGIN || `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ airOrigin, fixtures }) => {
      window.__runStates = fixtures;
      window.__socketUrls = [];
      class MockWebSocket extends EventTarget {
        constructor(address) {
          super();
          this.url = String(address);
          this.readyState = 0;
          window.__socketUrls.push(this.url);
          window.__socket = this;
          setTimeout(() => {
            if (this.readyState === 3) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
            const url = new URL(this.url);
            const machine = url.port === "45999" ? "air" : "mini";
            const provider = url.searchParams.get("provider") || "codex";
            const threadId = url.searchParams.get("thread") || "idle";
            const fixture = window.__runStates[machine].find((item) => item.threadId === threadId && item.provider === provider);
            this.emit({ type: "ready", threadId, provider, model: provider === "claude" ? "sonnet" : "gpt-5", workdir: `/fixture/${machine}/project`, threadTitle: fixture?.title || "確認用チャット", run: fixture?.run || { state: "ready" }, history: [], clients: 1 });
          }, 20);
        }
        emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
        send() {}
        close() { this.readyState = 3; }
      }
      MockWebSocket.OPEN = 1;
      window.WebSocket = MockWebSocket;
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [{ id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true }] }));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: "fixture-token" }));
    }, { airOrigin, fixtures: { mini: state.mini, air: state.air } });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, authorization, x-phone-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const machine = url.origin === airOrigin ? "air" : "mini";
      const provider = url.searchParams.get("provider") || "codex";
      const reply = (json) => route.fulfill({ json, headers });
      if (url.pathname === "/api/bridge/info") {
        if (machine === "air" && state.airOffline) return route.abort();
        return reply({ id: machine === "air" ? "air" : "home", label: machine === "air" ? "Air" : "mini", machineLabel: machine === "air" ? "Air" : "mini", hostName: machine === "air" ? "MacBook-Air.local" : "Mac-mini.local", provider: "codex", providers: ["codex", "claude"], model: "gpt-5", workdir: `/fixture/${machine}/project`, build });
      }
      if (url.pathname === "/api/status") return reply({ provider, bridges: state[machine] });
      if (url.pathname === "/api/threads") return reply({ provider, activeProvider: "codex", providers: ["codex", "claude"], data: state[machine].filter((item) => item.provider === provider).map((item) => ({ id: item.threadId, provider, name: item.title, cwd: item.workdir })), hiddenProjects: [] });
      if (url.pathname === "/api/thread") return reply({ threadId: url.searchParams.get("thread"), history: [] });
      if (url.pathname === "/api/info") return reply({ provider, providers: ["codex", "claude"], model: "gpt-5", workdir: `/fixture/${machine}/project` });
      return reply({ data: [] });
    });
    await page.goto(`${origin}/?token=fixture-token&thread=idle&provider=codex`, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => document.querySelectorAll(".session-activity-chip").length === 5, null, { timeout: 15000 });
    } catch (error) {
      console.error(JSON.stringify({ pageErrors: errors, strip: await page.locator("#sessionActivityStrip").count(), chips: await page.locator(".session-activity-chip").count() }));
      throw error;
    }
    const summary = () => page.locator(".session-activity-total").allTextContents();
    const summaryCount = (status) => page.locator(`.session-activity-total[data-state="${status}"]`);
    assert.deepEqual(await summary(), ["返信待ち 1", "許可待ち 1", "エラー 1", "未確認完了 1", "処理中 1"]);
    assert.match(await page.locator("#sessionActivityCount").getAttribute("aria-label"), /完了・未確認 1件/);
    const byKey = (machine, provider, threadId) => page.locator(`.session-activity-chip[data-session-key='${JSON.stringify([machine.toLowerCase(), provider, threadId])}']`);
    const metrics = await page.evaluate(() => {
      const strip = document.querySelector("#sessionActivityStrip").getBoundingClientRect();
      const content = document.querySelector(".content-grid").getBoundingClientRect();
      const rect = document.querySelector('.session-activity-chip[data-state="running"] rect');
      const items = document.querySelector("#sessionActivityItems");
      window.__runningButton = rect.closest("button");
      items.scrollLeft = 35;
      return { height: strip.height, bottom: strip.bottom, contentTop: content.top, overflowing: items.scrollWidth > items.clientWidth, svgWidth: rect.getBBox().width, animation: getComputedStyle(rect).animationName, tapHeight: rect.closest("button").getBoundingClientRect().height };
    });
    assert.ok(metrics.height >= 92 && metrics.height <= 140);
    assert.equal(metrics.bottom, metrics.contentTop);
    assert.ok(metrics.overflowing && metrics.svgWidth > 40 && metrics.tapHeight >= 44);
    assert.equal(metrics.animation, "session-border-orbit");
    const offset = () => page.locator('.session-activity-chip[data-state="running"] rect').evaluate((rect) => getComputedStyle(rect).strokeDashoffset);
    const before = await offset();
    await page.waitForTimeout(180);
    assert.notEqual(await offset(), before);
    await page.evaluate(() => renderSessionActivity());
    assert.ok(await page.evaluate(() => window.__runningButton === document.querySelector('.session-activity-chip[data-state="running"]') && document.querySelector("#sessionActivityItems").scrollLeft > 0));
    await page.locator("#sessionActivityCount").click();
    await page.waitForFunction(() => document.querySelector("#sessionActivityList").textContent.includes("mini の質問"));
    assert.match(await page.locator("#sessionActivityList").textContent(), /許可待ち/);
    const listStates = () => page.locator(".session-activity-row").evaluateAll((rows) => rows.map((row) => row.dataset.state));
    assert.deepEqual(await listStates(), ["question", "approval", "error", "done", "running"]);
    // Reorder existing rows when a task needs attention while the list is open.
    state.mini[0].run = { state: "error", updatedAt: 150 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.deepEqual(await listStates(), ["question", "approval", "error", "error", "done"]);
    assert.equal(await summaryCount("error").textContent(), "エラー 2");
    assert.equal(await summaryCount("running").count(), 0);
    state.mini[0].run = { state: "running", updatedAt: 175 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.deepEqual(await listStates(), ["question", "approval", "error", "done", "running"]);
    await page.locator("#closeSessionActivity").click();
    // Every status total stays inside the viewport even when conversations
    // overflow horizontally. This is the original missed-attention scenario.
    for (const width of [320, 390, 520, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator("#sessionActivityItems").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      assert.ok(await page.locator(".session-activity-total").evaluateAll((totals) => totals.every((total) => {
        const rect = total.getBoundingClientRect();
        const content = document.querySelector(".content-grid").getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= content.top;
      })), `all state totals visible at ${width}px`);
      assert.ok(await page.locator("#sessionActivityCount").evaluate((button) => button.getBoundingClientRect().height >= 44));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => setSidebarVisible(false));
    if (process.argv.includes("--shots")) {
      fs.mkdirSync(path.join(root, "output/playwright"), { recursive: true });
      await page.locator("#sessionActivityItems").evaluate((element) => { element.scrollLeft = 0; });
      await page.screenshot({ path: path.join(root, "output/playwright/session-status-strip-mobile.png") });
      await page.locator("#sessionActivityStrip").screenshot({ path: path.join(root, "output/playwright/session-status-summary.png") });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator('.session-activity-chip[data-state="running"] rect').evaluate((rect) => getComputedStyle(rect).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await byKey("mini", "codex", "finished").click();
    await page.waitForFunction(() => selectedThread === "finished" && connectionReady && !document.querySelector('.session-activity-chip[data-state="done"]'));
    assert.equal(await summaryCount("running").textContent(), "処理中 1");
    assert.equal(await summaryCount("done").count(), 0);
    await page.waitForFunction(() => !threadSwitchBusy);
    state.mini[1].run = { state: "running", updatedAt: 200 };
    await page.evaluate((run) => window.__socket.emit({ type: "runState", threadId: "finished", ...run }), state.mini[1].run);
    assert.equal(await summaryCount("running").textContent(), "処理中 2");
    // Exercise classifier output, not only hand-written UI states. An old
    // erroneous question must clear from both the strip and the composer.
    state.mini[1].run = { ...idleRunStateFromHistory([{ type: "assistant", text: "続行しますか？", outputGroup: "reply-turn" }]), updatedAt: 250 };
    await page.evaluate((run) => window.__socket.emit({ type: "runState", threadId: "finished", ...run }), state.mini[1].run);
    assert.equal(await byKey("mini", "codex", "finished").getAttribute("data-state"), "question");
    assert.equal(await summaryCount("question").textContent(), "返信待ち 2");
    assert.equal(await page.locator("#runStateLabel").textContent(), "返信待ち");
    state.mini[1].run = { ...idleRunStateFromHistory([{ type: "assistant", text: "実装が完了しました。質問・許可待ちは?、エラーは!で表示します。", outputGroup: "reply-turn" }]), updatedAt: 300 };
    await page.evaluate((run) => window.__socket.emit({ type: "runState", threadId: "finished", ...run }), state.mini[1].run);
    assert.equal(await byKey("mini", "codex", "finished").getAttribute("data-state"), "done");
    assert.equal(await summaryCount("done").textContent(), "未確認完了 1");
    assert.equal(await summaryCount("question").textContent(), "返信待ち 1");
    assert.equal(await page.locator("#runStateLabel").textContent(), "前回完了・送信できます");
    await page.evaluate((run) => window.__socket.emit({ type: "ready", provider: "codex", threadId: "finished", workdir: "/fixture/mini/project", history: [], run }), state.mini[1].run);
    assert.equal(await byKey("mini", "codex", "finished").getAttribute("data-state"), "done", "background reconnect must not acknowledge completion");
    const socketCount = await page.evaluate(() => window.__socketUrls.length);
    await byKey("mini", "codex", "finished").click();
    assert.equal(await byKey("mini", "codex", "finished").count(), 0);
    assert.equal(await page.evaluate(() => window.__socketUrls.length), socketCount);
    await byKey("mini", "claude", "shared").click();
    await page.waitForFunction(() => currentThreadProvider() === "claude" && selectedThread === "shared" && connectionReady);
    assert.equal(await byKey("mini", "claude", "shared").getAttribute("data-state"), "question");
    await page.waitForFunction(() => !threadSwitchBusy);
    await byKey("air", "codex", "shared").click();
    await page.waitForFunction(() => activeBridgeId === "air" && currentThreadProvider() === "codex" && selectedThread === "shared" && connectionReady);
    const opened = new URL(await page.evaluate(() => window.__socketUrls.at(-1)));
    assert.equal(opened.port, "45999");
    assert.equal(opened.searchParams.get("provider"), "codex");
    assert.equal(opened.searchParams.get("thread"), "shared");
    assert.equal(await byKey("air", "codex", "shared").getAttribute("data-state"), "error");
    state.airOffline = true;
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await byKey("air", "codex", "shared").getAttribute("data-state"), "offline");
    assert.equal(await summaryCount("running").textContent(), "処理中 1");
    assert.equal(await summaryCount("offline").textContent(), "接続確認 2");
    assert.equal(await summaryCount("error").count(), 0);
    await page.evaluate(() => applyTheme("cyberpunk"));
    assert.ok(await page.locator(".content-grid").evaluate((element) => element.getBoundingClientRect().height > 250));
    for (const width of [320, 520, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await page.evaluate(() => {
        const strip = document.querySelector("#sessionActivityStrip").getBoundingClientRect();
        const content = document.querySelector(".content-grid").getBoundingClientRect();
        return { rowHeight: strip.height, fits: strip.left >= 0 && strip.right <= innerWidth, aligned: strip.bottom === content.top };
      });
      assert.ok(layout.rowHeight >= 92 && layout.rowHeight <= 140 && layout.fits && layout.aligned, `layout at ${width}px`);
    }
    state.airOffline = false;
    for (const machine of ["mini", "air"]) for (const item of state[machine]) item.run = { state: "ready", updatedAt: 500 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("Session strip verified: visible mixed-state counts at 320–1024px, attention-first list updates, identity, orbit, reduced motion, stable scroll, full titles, question classification/correction, completion acknowledgement, provider/Mac navigation, offline safety and empty state.");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
