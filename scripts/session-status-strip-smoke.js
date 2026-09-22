// Frontend-only integration check. No real bridges, credentials or turns.
// node scripts/session-status-strip-smoke.js [--webkit] [--shots]
// SESSION_SMOKE_ORIGIN may point at a served UI; all API/socket traffic is
// still mocked, so this verifies delivered assets without opening real chats.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { idleRunStateFromHistory } = require("./question-state");
const { SessionNumberStore } = require("./session-number-store");
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
  const numberDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "session-strip-numbers-"));
  const numberStores = Object.fromEntries(["mini", "air"].map(machine => [machine, new SessionNumberStore(path.join(numberDirectory, machine))]));
  // These were assigned by another entry before this browser saw the runs.
  numberStores.mini.assign([{ provider: "codex", threadId: "finished" }, { provider: "codex", threadId: "shared" }]);
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript(({ origin, airOrigin, fixtures }) => {
      window.__runStates = JSON.parse(sessionStorage.getItem("session-smoke-fixtures") || "null") || fixtures;
      window.__socketUrls = [];
      window.__sentMessages = [];
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
            this.emit({ type: "ready", threadId, provider, model: provider === "claude" ? "sonnet" : "gpt-5", workdir: `/fixture/${machine}/project`, threadTitle: fixture?.title || "確認用チャット", run: fixture?.run || { state: "ready" }, history: fixture?.history || [], clients: 1 });
          }, 20);
        }
        emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
        send(data) { window.__sentMessages.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
      }
      MockWebSocket.OPEN = 1;
      window.WebSocket = MockWebSocket;
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [{ id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true }, { id: "mini", label: "mini", baseUrl: origin, rememberToken: true }] }));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: "fixture-token", mini: "fixture-token" }));
      localStorage.setItem("codexPhonePwaInstallHint:v1", "dismissed");
    }, { origin, airOrigin, fixtures: { mini: state.mini, air: state.air } });
    // A second page origin has genuinely independent browser storage; only
    // static assets and fixture API traffic are served here, never a real Mac.
    await context.route(`${airOrigin}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!file.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ path: file, contentType: ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream" });
    });
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": route.request().headers().origin || origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, authorization, x-phone-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const machine = url.origin === airOrigin ? "air" : "mini";
      const provider = url.searchParams.get("provider") || "codex";
      const reply = (json) => route.fulfill({ json, headers });
      if (url.pathname === "/api/session-numbers") return reply({ sessions: numberStores[machine].assign(route.request().postDataJSON().sessions) });
      if (url.pathname === "/api/bridge/info") {
        if (machine === "air" && state.airOffline) return route.abort();
        return reply({ id: machine === "air" ? "air" : "home", label: machine === "air" ? "Air" : "mini", machineLabel: machine === "air" ? "Air" : "mini", hostName: machine === "air" ? "MacBook-Air.local" : "Mac-mini.local", provider: "codex", providers: ["codex", "claude"], model: "gpt-5", workdir: `/fixture/${machine}/project`, build });
      }
      if (url.pathname === "/api/status") return reply({ provider, bridges: state[machine] });
      if (url.pathname === "/api/threads") return reply({ provider, activeProvider: "codex", providers: ["codex", "claude"], data: state[machine].filter((item) => item.provider === provider).map((item) => ({ id: item.threadId, provider, name: item.title, cwd: item.workdir })), hiddenProjects: [] });
      if (url.pathname === "/api/thread") return reply({ threadId: url.searchParams.get("thread"), history: state[machine].find(item => item.threadId === url.searchParams.get("thread") && item.provider === provider)?.history || [] });
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
    await page.waitForFunction(() => connectionReady);
    await page.evaluate(async () => {
      await setActiveBridge("air", { silent: true, reconnect: false });
      await refreshFleet({ force: true });
      await setActiveBridge(homeBridgeId, { silent: true, reconnect: false });
    });
    assert.equal(await page.evaluate(() => sessionActivityRecords.some(item => item.threadId === "idle")), false, "switching machines must not assign another conversation's running state to an idle chat");
    await page.evaluate(() => connect());
    await page.waitForFunction(() => connectionReady);
    assert.deepEqual(await summary(), ["返信待ち 1", "許可待ち 1", "エラー 1", "未確認完了 1", "処理中 1"]);
    assert.match(await page.locator("#sessionActivityCount").getAttribute("aria-label"), /完了・未確認 1件/);
    const byKey = (machine, provider, threadId) => page.locator(`.session-activity-chip[data-session-key='${JSON.stringify([machine.toLowerCase(), provider, threadId])}']`);
    await page.waitForFunction(() => sessionActivityRecords.length === 5 && sessionActivityRecords.every(item => item.ordinal));
    assert.equal(await byKey("mini", "codex", "shared").locator(".session-activity-name").textContent(), "Codex mini②");
    assert.equal(await byKey("mini", "codex", "finished").locator(".session-activity-name").textContent(), "Codex mini①");
    const expectedNumbers = await page.evaluate(() => Object.fromEntries(sessionActivityRecords.map(item => [item.key, item.ordinal])));
    // A different entry already holds conflicting legacy browser-local numbers.
    const otherEntry = await context.newPage();
    otherEntry.on("pageerror", error => errors.push(error.message));
    await otherEntry.addInitScript(records => {
      if (!localStorage.getItem("number-migration-seeded")) {
        localStorage.setItem("number-migration-seeded", "yes");
        localStorage.setItem("codexPhoneSessionActivity:v1", JSON.stringify(records.map((item, index) => {
          const { sessionNumber, ...legacy } = item;
          return { ...legacy, bridgeId: item.machineKey === "mini" ? "mini" : "air", ordinal: index + 41 };
        }).reverse()));
      }
    }, await page.evaluate(() => sessionActivityRecords));
    await otherEntry.goto(`${airOrigin}/?token=fixture-token&thread=idle&provider=codex`, { waitUntil: "domcontentloaded" });
    await otherEntry.waitForFunction(expected => sessionActivityRecords.length === 5 && sessionActivityRecords.every(item => item.ordinal === expected[item.key]), expectedNumbers);
    await otherEntry.reload({ waitUntil: "domcontentloaded" });
    await otherEntry.waitForFunction(expected => sessionActivityRecords.length === 5 && sessionActivityRecords.every(item => item.ordinal === expected[item.key]), expectedNumbers);
    assert.equal(await otherEntry.locator('.session-activity-chip[data-session-key=\'["mini","codex","shared"]\'] .session-activity-name').textContent(), "Codex mini②");
    assert.equal(await otherEntry.evaluate(() => window.__sentMessages.filter(item => item.type === "prompt").length), 0);
    await otherEntry.close();
    await page.bringToFront();
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
    assert.ok(await page.locator("#sessionActivityDialog p").evaluate((hint) => getComputedStyle(hint).whiteSpace === "normal" && hint.scrollWidth <= hint.clientWidth), "the dismiss instructions must not be truncated");
    if (process.argv.includes("--shots")) {
      fs.mkdirSync(path.join(root, "output/playwright"), { recursive: true });
      await page.locator("#sessionActivityDialog").screenshot({ path: path.join(root, "output/playwright/session-status-list.png") });
    }
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
    // Clear the exact stale completion/error scenario without opening either
    // conversation, changing the draft or sending anything to a bridge.
    const dismissFor = (machine, provider, threadId) => byKey(machine, provider, threadId).locator("..").locator(".session-activity-dismiss");
    await page.locator("#prompt").fill("片づけ前の下書き");
    const selectionBefore = await page.evaluate(() => ({ thread: selectedThread, provider: currentThreadProvider(), bridge: activeBridgeId, sockets: window.__socketUrls.length }));
    const recordsBefore = await page.evaluate(() => sessionActivityRecords.map(({ key, threadId, workdir, title, status }) => ({ key, threadId, workdir, title, status })));
    // A second open view must not overwrite a newer dismissal with its old
    // in-memory records when its next status poll renders the strip.
    const sibling = await context.newPage();
    await sibling.goto(`${origin}/?token=fixture-token&thread=sibling-idle&provider=codex`, { waitUntil: "domcontentloaded" });
    await sibling.waitForFunction(() => connectionReady && document.querySelectorAll(".session-activity-chip").length === 5);
    assert.equal(await page.locator("#sessionActivityItems .session-activity-dismiss:visible").count(), 2);
    const targetSize = await dismissFor("mini", "codex", "finished").boundingBox();
    assert.ok(targetSize.width >= 24 && targetSize.width <= 28 && targetSize.height >= 24, "dismiss must stay compact and tappable");
    const capsuleSize = await byKey("mini", "codex", "finished").locator(".session-activity-capsule").boundingBox();
    const nameSize = await byKey("mini", "codex", "finished").locator(".session-activity-name").boundingBox();
    assert.ok(targetSize.x >= nameSize.x + nameSize.width && targetSize.x + targetSize.width <= capsuleSize.x + capsuleSize.width, "dismiss must fit inside the capsule without covering its name");
    await dismissFor("mini", "codex", "finished").tap();
    assert.equal(await summaryCount("done").count(), 0);
    await sibling.evaluate(() => renderSessionActivity());
    assert.equal(await sibling.locator('.session-activity-chip[data-state="done"]').count(), 0, "another open view must respect the saved dismissal");
    await page.locator("#sessionActivityCount").click();
    const errorDismiss = page.locator('.session-activity-row[data-state="error"]').locator("..").locator(".session-activity-dismiss");
    await errorDismiss.focus();
    await errorDismiss.press("Enter");
    await sibling.waitForFunction(() => !document.querySelector('.session-activity-chip[data-state="error"]'), null, { timeout: 3000 });
    await sibling.close();
    assert.deepEqual(await listStates(), ["question", "approval", "running"]);
    assert.equal(await page.locator("#sessionActivityList .session-activity-dismiss:visible").count(), 0);
    assert.ok(await page.locator("#sessionActivityList").evaluate((list) => list.contains(document.activeElement)), "focus stays in the open list after dismissal");
    await page.locator("#closeSessionActivity").click();
    assert.deepEqual(await page.evaluate(() => ({ thread: selectedThread, provider: currentThreadProvider(), bridge: activeBridgeId, sockets: window.__socketUrls.length })), selectionBefore);
    assert.deepEqual(await page.evaluate(() => sessionActivityRecords.map(({ key, threadId, workdir, title, status }) => ({ key, threadId, workdir, title, status }))), recordsBefore);
    assert.equal(await page.locator("#prompt").inputValue(), "片づけ前の下書き");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => connectionReady && document.querySelectorAll(".session-activity-chip").length === 3);
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.deepEqual(await summary(), ["返信待ち 1", "許可待ち 1", "処理中 1"]);
    assert.equal(await page.locator("#prompt").inputValue(), "片づけ前の下書き");
    if (process.argv.includes("--shots")) {
      fs.mkdirSync(path.join(root, "output/playwright"), { recursive: true });
      await page.evaluate(() => setSidebarVisible(false));
      await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 1);
      await page.screenshot({ path: path.join(root, "output/playwright/session-status-cleared.png") });
    }
    state.mini[1].run.updatedAt = 110;
    state.air[1].run.updatedAt = 110;
    await page.evaluate((fixtures) => { window.__runStates = fixtures; }, { mini: state.mini, air: state.air });
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await summaryCount("done").textContent(), "未確認完了 1");
    assert.equal(await summaryCount("error").textContent(), "エラー 1");
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
      await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 1);
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
    // A stopped conversation remains stopped after reopening. Dismissing its
    // shortcut preserves the conversation, answer and draft, including reload.
    state.mini[1].run = { state: "interrupted", label: "中断しました", turnId: "stopped-one", updatedAt: 400 };
    state.mini[1].history = [{ type: "user", text: "中断表示の確認" }, { type: "assistant", text: "中断前の返答" }];
    await page.evaluate(fixtures => {
      window.__runStates = fixtures;
      sessionStorage.setItem("session-smoke-fixtures", JSON.stringify(fixtures));
      const stopped = fixtures.mini[1];
      window.__socket.emit({ type: "ready", provider: "codex", threadId: "finished", workdir: stopped.workdir, history: stopped.history, run: stopped.run });
    }, { mini: state.mini, air: state.air });
    assert.equal(await byKey("mini", "codex", "finished").getAttribute("data-state"), "interrupted");
    assert.equal(await page.locator("#runStateLabel").textContent(), "中断しました");
    assert.equal(await page.locator("#interruptRun").isVisible(), false);
    await page.locator("#prompt").fill("中断後の未送信メモ");
    if (process.argv.includes("--shots")) {
      await page.locator("#sessionActivityItems").evaluate(element => { element.scrollLeft = 0; });
      await page.screenshot({ path: path.join(root, "output/playwright/session-interrupted-mobile.png") });
    }
    await dismissFor("mini", "codex", "finished").click();
    assert.equal(await byKey("mini", "codex", "finished").count(), 0);
    await page.evaluate(() => {
      window.__socket.emit({ type: "status", text: "履歴同期中" });
      window.__socket.emit({ type: "status", text: "履歴同期を更新しました" });
      window.__socket.emit({ type: "status", text: "履歴同期に失敗" });
    });
    assert.equal(await byKey("mini", "codex", "finished").count(), 0, "history synchronization must not reopen a dismissed shortcut");
    assert.equal(await page.locator("#runStateLabel").textContent(), "中断しました", "history copying must not change the actual turn state");
    await page.evaluate(run => window.__socket.emit({ type: "runState", threadId: "finished", ...run }), state.mini[1].run);
    assert.equal(await byKey("mini", "codex", "finished").count(), 0);
    await page.evaluate(() => {
      const state = getBridgeState();
      state.connected = false;
      state.lastError = "fixture connection outage";
      renderSessionActivity();
    });
    assert.equal(await byKey("mini", "codex", "finished").count(), 0, "an outage must not recreate a dismissed interrupted conversation");
    assert.equal(await byKey("mini", "codex", "idle").count(), 0, "an outage must not invent a shortcut for an idle conversation");
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await byKey("mini", "codex", "finished").count(), 0);
    assert.equal(await page.locator("#prompt").inputValue(), "中断後の未送信メモ");
    assert.equal(await page.getByText("中断前の返答", { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), []);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => selectedThread === "finished" && connectionReady);
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#runStateLabel").textContent(), "中断しました");
    assert.equal(await page.locator("#interruptRun").isVisible(), false);
    assert.equal(await byKey("mini", "codex", "finished").count(), 0, "the same interruption stays dismissed after reopening");
    assert.equal(await page.locator("#prompt").inputValue(), "中断後の未送信メモ");
    assert.equal(await page.getByText("中断前の返答", { exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__sentMessages), []);
    state.mini[1].run = { ...state.mini[1].run, turnId: "stopped-two", updatedAt: 500 };
    await page.evaluate(run => window.__socket.emit({ type: "runState", threadId: "finished", ...run }), state.mini[1].run);
    assert.equal(await byKey("mini", "codex", "finished").getAttribute("data-state"), "interrupted", "another interrupted turn gets its own notice");
    await page.locator("#sessionActivityCount").click();
    await page.locator('.session-activity-item.expanded').filter({ has: page.locator('[data-state="interrupted"]') }).locator(".session-activity-dismiss").click();
    assert.equal(await summaryCount("interrupted").count(), 0);
    await page.locator("#closeSessionActivity").click();
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
    assert.equal(await summaryCount("offline").textContent(), "接続確認 2", JSON.stringify(await page.evaluate(() => uiUtils.visibleSessionActivity(sessionActivityRecords).map(({ key, status }) => ({ key, status })))));
    assert.equal(await summaryCount("error").count(), 0);
    const offlineSelection = await page.evaluate(() => ({ thread: selectedThread, provider: currentThreadProvider(), bridge: activeBridgeId }));
    await dismissFor("air", "codex", "shared").tap();
    assert.equal(await summaryCount("offline").textContent(), "接続確認 1");
    assert.deepEqual(await page.evaluate(() => ({ thread: selectedThread, provider: currentThreadProvider(), bridge: activeBridgeId })), offlineSelection);
    await dismissFor("air", "claude", "permission").tap();
    assert.equal(await summaryCount("offline").count(), 0, "the connection summary disappears after every outage is dismissed");
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await summaryCount("offline").count(), 0, "the same outages stay dismissed while polling");
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
    state.airOffline = true;
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false, "idle conversations do not return as connection warnings");
    state.airOffline = false;
    for (const item of state.air) item.run = { state: "running", turnId: `new-${item.threadId}`, updatedAt: 550 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await summaryCount("running").textContent(), "処理中 2");
    state.airOffline = true;
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await summaryCount("offline").textContent(), "接続確認 2", "an outage during genuinely new work must still appear");
    state.airOffline = false;
    for (const item of state.air) item.run = { state: "ready", updatedAt: 575 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false);
    state.mini[0].run = { state: "error", turnId: "failed-one", updatedAt: 600 };
    await page.evaluate(() => refreshFleet({ force: true }));
    await dismissFor("mini", "codex", "shared").click();
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false);
    state.mini[0].run = { state: "error", turnId: "failed-one", updatedAt: 700, label: "エラー" };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false, "the same failure stays dismissed despite a reconnect timestamp");
    state.mini[0].run = { state: "error", turnId: "failed-two", updatedAt: 800 };
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await summaryCount("error").textContent(), "エラー 1", "a new failed turn still appears");
    await page.evaluate(() => {
      window.__originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "codexPhoneSessionActivity:v1") throw new DOMException("fixture quota exceeded", "QuotaExceededError");
        return window.__originalSetItem.call(this, key, value);
      };
    });
    await dismissFor("mini", "codex", "shared").click();
    await page.evaluate(() => refreshFleet({ force: true }));
    assert.equal(await page.locator("#sessionActivityStrip").isVisible(), false, "unavailable storage must not undo the current view's dismissal");
    await page.evaluate(() => { Storage.prototype.setItem = window.__originalSetItem; });
    await page.evaluate(() => {
      const records = JSON.parse(localStorage.getItem("codexPhoneSessionActivity:v1"));
      const item = records.find(record => record.machineKey === "mini" && record.provider === "codex" && record.threadId === "shared");
      item.ordinal = 87;
      delete item.sessionNumber;
      // A legacy view writes after this conversation's live watcher expired.
      const state = getBridgeState(item.bridgeId);
      state.sessionRuns.delete("codex:shared");
      state.status.bridges = state.status.bridges.filter(run => run.threadId !== "shared" || run.provider !== "codex");
      localStorage.setItem("codexPhoneSessionActivity:v1", JSON.stringify(records));
      renderSessionActivity();
    });
    assert.equal(await page.evaluate(() => sessionActivityRecords.find(item => item.machineKey === "mini" && item.provider === "codex" && item.threadId === "shared").ordinal), 2, "late legacy storage cannot replace a confirmed number");
    assert.ok(await page.locator("#prompt").evaluate((input) => input === document.activeElement));
    assert.deepEqual(errors, []);
    console.log("Session strip verified: shared conversation numbers across separate entry origins, legacy-number migration and reload; dismissal across polling, reload, history sync, connection outages, same-turn timestamp changes and simultaneous views; in-memory dismissal when storage is unavailable; stopped state, retained conversations/answers/drafts without sending prompts, genuinely new events, touch/keyboard targets, 320–1024px layout, attention-first list, identity, orbit, reduced motion, stable scroll, full titles, question classification/correction, acknowledgement, provider/Mac navigation and empty state.");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(numberDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
