// Real mobile UI with mocked API/socket traffic: no credentials or AI turns.
// node scripts/new-session-smoke.js [--webkit] [--shots]
// NEW_SESSION_SMOKE_ORIGIN optionally checks assets served by an actual bridge.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { startServer } = require("./mobile-smoke");

async function run() {
  const { server, origin: localOrigin } = await startServer();
  const origin = process.env.NEW_SESSION_SMOKE_ORIGIN || localOrigin;
  const airOrigin = origin.startsWith("https:") ? "https://air.fixture.invalid:45999" : "http://127.0.0.1:45999";
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  page.setDefaultTimeout(8000);
  const errors = [];
  const requests = [];
  const posts = [];
  let blockBrowse = null;
  let blockPost = null;
  let rejectPost = false;
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(({ airOrigin }) => {
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [{ id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true }] }));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: "fixture-token" }));
      localStorage.setItem("codexPhoneReasoning", "high");
      window.__sessionSockets = [];
      class MockWebSocket extends EventTarget {
        constructor(address) {
          super();
          this.readyState = 0;
          const url = new URL(address);
          window.__sessionSockets.push(String(address));
          setTimeout(() => {
            if (this.readyState === 3) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
            const fresh = url.searchParams.get("fresh") === "1";
            const provider = url.searchParams.get("provider");
            const cwd = url.searchParams.get("workdir") || `/Users/${url.port === "45999" ? "air" : "mini"}/project`;
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
              type: "ready", provider, threadId: fresh ? `fresh-${window.__sessionSockets.length}` : url.searchParams.get("thread") || "original",
              model: provider === "claude" ? "sonnet" : "gpt-5", workdir: cwd, workspaceLocation: cwd,
              threadTitle: fresh ? "新しいチャット" : "前のチャット", clients: 1, run: { state: "ready" },
              history: fresh ? [] : [{ type: "user", text: "保存しておく会話" }, { type: "assistant", text: "前の返答" }],
            }) }));
          }, 20);
        }
        send() {}
        close() { this.readyState = 3; }
      }
      MockWebSocket.OPEN = 1;
      window.WebSocket = MockWebSocket;
    }, { airOrigin });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      const machine = url.origin === airOrigin ? "air" : "mini";
      const home = `/Users/${machine}`;
      const provider = url.searchParams.get("provider") || (machine === "air" ? "claude" : "codex");
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, authorization, x-phone-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
      const reply = (json, status = 200) => route.fulfill({ json, status, headers });
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/api/workspaces/browse") {
        const folder = url.searchParams.get("path") || home;
        requests.push({ machine, folder });
        if (blockBrowse) { const wait = blockBrowse; blockBrowse = null; await wait; }
        if (folder.endsWith("/missing")) return reply({ error: "フォルダが見つかりません。" }, 404);
        if (folder.endsWith("/offline")) return route.abort();
        const entries = folder === home ? [{ name: "WORK_LOCAL", path: `${home}/WORK_LOCAL` }]
          : folder.endsWith("/WORK_LOCAL") ? [{ name: "履歴のない フォルダ & 計画", path: `${folder}/履歴のない フォルダ & 計画` }] : [];
        return reply({ path: folder, home, displayPath: folder.replace(home, "~"), parent: folder === home ? null : path.dirname(folder), entries, machineLabel: machine === "air" ? "Air" : "mini" });
      }
      if (url.pathname === "/api/workspaces" && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        posts.push({ machine, ...body });
        if (blockPost) { const wait = blockPost; blockPost = null; await wait; }
        return rejectPost ? reply({ error: "フォルダが見つかりません。" }, 400) : reply({ ok: true, workspace: { path: body.path }, options: [] });
      }
      if (url.pathname === "/api/bridge/info") return reply({
        id: machine === "air" ? "air" : "home", machineLabel: machine === "air" ? "Air" : "mini", hostName: machine === "air" ? "MacBook-Air.local" : "Mac-mini.local",
        provider: machine === "air" ? "claude" : "codex", providers: ["codex", "claude"], model: "gpt-5", workdir: `${home}/project`,
        build: { available: true, head: "a".repeat(40), fingerprint: "fixture", dirty: false, restartRequired: false, upstream: { ahead: 0, behind: 0 } },
      });
      if (url.pathname === "/api/info") return reply({ provider: machine === "air" ? "claude" : "codex", providers: ["codex", "claude"], workdir: `${home}/project` });
      if (url.pathname === "/api/threads") return reply({ provider, data: [{ id: "original", provider, name: "前のチャット", cwd: `${home}/project`, updatedAt: Date.now() }] });
      if (url.pathname === "/api/thread") return reply({ provider, thread: { id: "original", cwd: `${home}/project` } });
      if (url.pathname === "/api/status") return reply({ provider, bridges: [] });
      if (url.pathname === "/api/bridge/registry") return reply({ version: 2, bridges: [], tokens: {}, deleted: [] });
      return reply({ data: [] });
    });
    await page.goto(`${origin}/?token=fixture-token&thread=original&provider=codex`);
    await page.waitForFunction(() => connectionReady && getBridgeState("air").info?.machineLabel === "Air");
    await page.waitForTimeout(750); // Let the initial pageshow recovery finish.
    const openPicker = async () => {
      if (!await page.evaluate(() => document.body.classList.contains("show-sidebar"))) await page.locator("#mobileThreads").click();
      assert.ok(await page.locator("#newSessionButton").isVisible(), "new session is available without a project heading");
      await page.locator("#newSessionButton").click();
      await page.waitForFunction(() => !document.querySelector("#createNewSession").disabled);
    };
    const sessionState = () => page.evaluate(() => ({ bridge: activeBridgeId, thread: selectedThread, provider: currentThreadProvider(), draft: promptInput.value, history: log.textContent, sockets: window.__sessionSockets.length }));
    await page.evaluate(() => { promptInput.value = "元のチャットの下書き"; promptInput.dispatchEvent(new Event("input", { bubbles: true })); });
    const before = await sessionState();
    await openPicker();
    assert.equal(await page.locator("#newSessionPath").inputValue(), "/Users/mini");
    await page.locator("#newSessionMachine").selectOption("air");
    await page.waitForFunction(() => document.querySelector("#newSessionPath").value === "/Users/air" && !document.querySelector("#createNewSession").disabled);
    await page.locator("#cancelNewSession").click();
    assert.deepEqual(await sessionState(), before, "cancel keeps the connection, conversation and draft intact");
    assert.equal(posts.length, 0);

    await openPicker();
    let releaseBrowse;
    blockBrowse = new Promise(resolve => { releaseBrowse = resolve; });
    await page.getByRole("button", { name: "WORK_LOCAL", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#newSessionFolders").getAttribute("aria-busy") === "true");
    assert.ok(await page.locator("#createNewSession").isDisabled());
    await page.locator("#newSessionMachine").selectOption("air");
    await page.waitForFunction(() => document.querySelector("#newSessionPath").value === "/Users/air" && !document.querySelector("#createNewSession").disabled);
    const lateResponse = page.waitForResponse(response => response.url().includes(encodeURIComponent("/Users/mini/WORK_LOCAL")));
    releaseBrowse();
    await lateResponse;
    assert.equal(await page.locator("#newSessionPath").inputValue(), "/Users/air", "a late mini response cannot replace Air's folder");

    await page.locator("#newSessionPath").fill("/Users/air/missing");
    assert.ok(await page.locator("#createNewSession").isDisabled(), "editing the path invalidates the previous selection");
    await page.locator("#newSessionBrowse").click();
    await page.waitForFunction(() => document.querySelector("#newSessionStatus").classList.contains("error"));
    assert.ok(await page.locator("#createNewSession").isDisabled());
    await page.locator("#newSessionPath").fill("/Users/air/offline");
    await page.locator("#newSessionPath").press("Enter");
    await page.waitForFunction(() => document.querySelector("#newSessionStatus").classList.contains("error"));
    assert.ok(await page.locator("#createNewSession").isDisabled());
    assert.deepEqual(await sessionState(), before, "failed browsing never leaves the current chat");
    await page.locator("#newSessionHome").click();
    await page.getByRole("button", { name: "WORK_LOCAL", exact: true }).click();
    await page.getByRole("button", { name: "履歴のない フォルダ & 計画", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#newSessionFolders").textContent.includes("この中にフォルダはありません"));
    const target = "/Users/air/WORK_LOCAL/履歴のない フォルダ & 計画";
    assert.equal(await page.locator("#newSessionPath").inputValue(), target);
    rejectPost = true;
    await page.locator("#createNewSession").click();
    await page.waitForFunction(() => document.querySelector("#newSessionStatus").classList.contains("error"));
    assert.ok(await page.locator("#newSessionDialog").isVisible());
    assert.deepEqual(await sessionState(), before, "a folder removed before starting does not change the session");
    rejectPost = false;
    await page.locator("#newSessionBrowse").click();
    await page.waitForFunction(() => !document.querySelector("#createNewSession").disabled);

    for (const width of [320, 390, 820, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.locator("#newSessionDialog").evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth), `dialog fits ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.argv.includes("--shots")) {
      const directory = path.resolve(__dirname, "../output/playwright");
      fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, `new-session-${engine.name()}.png`) });
    }
    const postsBeforeStart = posts.length;
    await page.locator("#createNewSession").evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => !document.querySelector("#newSessionDialog").open && connectionReady && selectedThread.startsWith("fresh-"));
    assert.equal(posts.length, postsBeforeStart + 1, "double taps only start once");
    assert.deepEqual(posts.at(-1), { machine: "air", path: target });
    const socket = new URL(await page.evaluate(() => window.__sessionSockets.at(-1)));
    assert.equal(socket.origin.replace(/^ws/, "http"), airOrigin);
    assert.equal(socket.searchParams.get("workdir"), target);
    assert.equal(socket.searchParams.get("provider"), "codex", "selection survives Air's Claude default");
    assert.equal(socket.searchParams.get("fresh"), "1");
    assert.equal(socket.searchParams.has("thread"), false);
    assert.ok(!(await page.locator("#log").textContent()).includes("保存しておく会話"));
    assert.equal(await page.evaluate(() => localStorage.getItem("codexPhoneReasoning")), "high");
    await page.waitForFunction(() => !threadSwitchBusy);
    await page.evaluate(async (bridgeId) => { await selectThread("original", { bridgeId, workdir: "/Users/mini/project", thread: { provider: "codex" } }); }, before.bridge);
    await page.waitForFunction(() => connectionReady && selectedThread === "original");
    assert.equal(await page.evaluate(() => promptInput.value), before.draft, "old draft is restored on return");
    assert.ok((await page.locator("#log").textContent()).includes("保存しておく会話"));
    await page.waitForFunction(() => !threadSwitchBusy);
    await page.evaluate(() => setMainView("terminal"));
    await openPicker();
    await page.locator("#newSessionProvider").selectOption("claude");
    await page.locator("#newSessionPath").fill("/Users/mini/新しいプロジェクト");
    await page.locator("#newSessionBrowse").click();
    await page.waitForFunction(() => !document.querySelector("#createNewSession").disabled);
    await page.locator("#createNewSession").click();
    await page.waitForFunction(() => connectionReady && selectedThread.startsWith("fresh-") && currentThreadProvider() === "claude");
    assert.equal(await page.evaluate(() => document.body.dataset.mainView), "chat");
    assert.equal(new URL(await page.evaluate(() => window.__sessionSockets.at(-1))).searchParams.get("workdir"), "/Users/mini/新しいプロジェクト");

    await page.waitForFunction(() => !threadSwitchBusy);
    await openPicker();
    const beforeCancel = await sessionState();
    let releasePost;
    blockPost = new Promise(resolve => { releasePost = resolve; });
    await page.locator("#createNewSession").click();
    const postResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspaces");
    await page.locator("#cancelNewSession").click();
    releasePost();
    await postResponse;
    assert.deepEqual(await sessionState(), beforeCancel, "cancelling validation cannot open a session later");
    await page.evaluate(() => { for (const state of bridgeStates.values()) state.threadCache = []; threadCache = []; renderThreadList(); });
    await page.locator("#newSessionButton").click();
    await page.waitForFunction(() => !document.querySelector("#createNewSession").disabled);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#newSessionDialog").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: new session verified for empty history, mini/Air, Codex/Claude, folder navigation, drafts, cancellation, stale responses, errors, double taps and mobile layout.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
