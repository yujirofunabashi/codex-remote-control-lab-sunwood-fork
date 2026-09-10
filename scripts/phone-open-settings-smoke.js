// Real UI, mocked machines: never opens a live session or sends a prompt.
// node scripts/phone-open-settings-smoke.js [--webkit] [--shots]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { bridgeIdFromBaseUrl } = require("../public/phone-ui-utils");
const root = path.resolve(__dirname, "..");
const airOrigin = "http://127.0.0.1:45999";
const version = `${"a".repeat(64)}-${"b".repeat(64)}`;
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "ok" : "FAIL"} ${name}${!condition ? ` ${JSON.stringify(detail || "")}` : ""}`);
}

async function main() {
  const publicDir = process.env.PHONE_SMOKE_PUBLIC_DIR || path.join(root, "public");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${publicDir}${path.sep}`)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      if (file.endsWith("index.html")) data = data.toString().replace(/src="[^"]*main\.js[^"]*"/, `src="/main.js?v=${version}"`);
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream" }).end(data);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const homeId = bridgeIdFromBaseUrl(origin);
  const browser = await (process.argv.includes("--webkit") ? webkit : chromium).launch();
  const errors = [];
  const shots = process.argv.includes("--shots");
  const shotsDir = path.join(root, "output/playwright/phone-open-settings");
  if (shots) fs.mkdirSync(shotsDir, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ homeId, airOrigin }) => {
      localStorage.setItem("codexPhonePwaInstallHint:v1", "dismissed");
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
            const requested = url.searchParams.get("thread");
            if (requested && requested !== `${machine}-${provider}`) {
              this.emit({ type: "runState", run: { state: "error", label: "会話を開けません" } });
              this.emit({ type: "error", text: "この会話の履歴を開けませんでした。会話は切り替えていません。一覧から元の会話を選び直してください。" });
              return;
            }
            const threadId = requested || `${machine}-${provider}`;
            this.emit({ type: "ready", threadId, provider, model: provider === "claude" ? "sonnet" : "gpt-5", workdir: `/fixture/${machine}`, run: { state: "done" }, history: [{ type: "assistant", text: `${machine} ${provider} の元の回答` }], clients: 1 });
          }, 20);
        }
        emit(payload) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
        send() { throw new Error("This smoke must never send a prompt"); }
        close() { this.readyState = 3; }
      }
      MockWebSocket.OPEN = 1;
      MockWebSocket.CLOSED = 3;
      window.WebSocket = MockWebSocket;
      if (!localStorage.getItem("fixture-seeded")) {
        localStorage.setItem("fixture-seeded", "1");
        localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [{ id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true }] }));
        localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: "fixture-token" }));
        localStorage.setItem("codexPhoneBridgeViewState:v1", JSON.stringify({ [homeId]: { provider: "claude", selectedThread: "mini-claude" } }));
      }
    }, { homeId, airOrigin });
    let delayRecovery = null;
    let recoveryRequested = null;
    let delayWorkspace = null;
    let workspaceRequested = null;
    let workspaceFailure = false;
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      const machine = url.origin === airOrigin ? "air" : "mini";
      const provider = url.searchParams.get("provider") || "claude";
      const cwd = `/fixture/${machine}`;
      const headers = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, authorization, x-phone-token" };
      const reply = (json, status = 200) => route.fulfill({ json, status, headers });
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (["/api/info", "/api/bridge/info"].includes(url.pathname)) return reply({ provider: "claude", providers: ["codex", "claude"], model: "sonnet", workdir: cwd, cwd, machineLabel: machine === "mini" ? "mini" : "Air", shell: { main: `/main.js?v=${version}` } });
      if (url.pathname === "/api/threads") return reply({ provider, activeProvider: provider, data: [{ id: `${machine}-${provider}`, name: `${machine} ${provider}`, provider, cwd }], hiddenProjects: [] });
      if (url.pathname === "/api/thread") {
        const id = url.searchParams.get("thread");
        if (id === "mini-claude" && provider === "claude" && delayRecovery) {
          recoveryRequested?.();
          await delayRecovery;
        }
        if (id !== `${machine}-${provider}`) return provider === "claude" ? reply({ threadId: id, provider, missing: true, history: [] }) : reply({ error: `thread not loaded: ${id}` }, 500);
        return reply({ threadId: id, provider, history: [{ type: "assistant", text: `${machine} ${provider} の元の回答` }] });
      }
      if (url.pathname === "/api/status") return reply({ provider, bridges: [] });
      if (url.pathname === "/api/workspaces") {
        if (workspaceFailure) return reply({ error: "フォルダを確認できません" }, 404);
        if (delayWorkspace) { workspaceRequested?.(); await delayWorkspace; }
        return reply({ workspace: { path: JSON.parse(route.request().postData()).path } });
      }
      if (url.pathname === "/api/config") return reply({ config: { config: { model: "sonnet" } }, auth: { authMethod: "test" } });
      if (url.pathname === "/api/local-settings") return reply({ active: { provider: "claude", model: "sonnet", workdir: cwd }, settings: { provider: "claude", model: "sonnet", workdir: cwd }, options: { providers: ["codex", "claude"], models: ["sonnet"], workspaces: [{ path: cwd, name: "work" }] } });
      if (url.pathname === "/api/workspaces/browse") return reply({ path: cwd, displayPath: `/fixture/${"long-folder-".repeat(30)}`, entries: [{ name: "folder", path: `${cwd}/folder` }] });
      return reply({ data: [] });
    });
    const view = () => page.evaluate(() => ({ provider: currentThreadProvider(), thread: selectedThread, ready: connectionReady }));
    const settled = (provider, thread) => page.waitForFunction(({ provider, thread }) => connectionReady && currentThreadProvider() === provider && selectedThread === thread, { provider, thread }, { timeout: 4000 });
    await page.goto(`${origin}/?token=fixture-token&provider=codex`);
    await page.waitForFunction(() => window.__socketUrls.length > 0);
    const first = await page.evaluate(() => window.__socketUrls[0]);
    check("Codex icon never resumes the last Claude conversation as Codex", !first.includes("thread=mini-claude"), first);

    await page.evaluate(() => selectThread("mini-codex", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
    await settled("codex", "mini-codex");
    await page.evaluate(() => switchThreadProvider("claude"));
    await settled("claude", "mini-claude");
    await page.locator("#prompt").fill("未送信の下書き");
    await page.evaluate(() => setActiveBridge("air"));
    await page.waitForFunction(() => connectionReady && activeBridgeId === "air");
    await page.evaluate(homeId => setActiveBridge(homeId), homeId);
    await page.waitForFunction(() => window.__socket.readyState === 1);
    check("returning to mini preserves its chosen AI and conversation", (await view()).provider === "claude" && (await view()).thread === "mini-claude", await view());
    check("returning to the same conversation restores its draft", await page.locator("#prompt").inputValue() === "未送信の下書き");
    await page.evaluate(() => switchThreadProvider("codex"));
    await page.waitForFunction(() => window.__socket.readyState === 1);
    check("each machine remembers both providers' conversation selections", new URL(await page.evaluate(() => window.__socketUrls.at(-1))).searchParams.get("thread") === "mini-codex");

    await page.evaluate(() => switchThreadProvider("claude"));
    await settled("claude", "mini-claude");
    await page.goto(`${origin}/?provider=codex`);
    await page.waitForFunction(() => window.__socketUrls.length > 0);
    check("reopening the Codex icon restores its own persisted conversation", new URL(await page.evaluate(() => window.__socketUrls[0])).searchParams.get("thread") === "mini-codex");
    await settled("codex", "mini-codex");

    await page.locator("#prompt").blur();
    await page.evaluate(() => showSettings());
    await page.waitForFunction(() => document.querySelector(".settings-form"));
    for (const width of [320, 393, 768]) {
      await page.setViewportSize({ width, height: 852 });
      await page.evaluate(() => showSettings());
      const metrics = await page.locator(".artifact-panel").evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, viewport: innerWidth }));
      check(`settings fit ${width}px with full build IDs and long paths`, metrics.width > 0 && metrics.scrollWidth <= metrics.width + 1 && metrics.left >= 0 && metrics.right <= width, metrics);
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(async () => { await showSettings(); document.querySelector(".artifact-panel").scrollTop = document.querySelector(".settings-actions").offsetTop; });
    if (shots) await page.screenshot({ path: path.join(shotsDir, `${process.argv.includes("--webkit") ? "webkit" : "chromium"}-settings.png`) });
    await page.evaluate(() => document.querySelector("#closePanelButton").click());

    await page.goto(`${origin}/?provider=codex&thread=mini-claude`);
    try { await settled("claude", "mini-claude"); } catch { /* Record the pre-fix failure below. */ }
    check("a previously poisoned selection recovers its verified original provider", (await view()).provider === "claude" && (await view()).ready, await view());
    check("recovery displays the preserved original answer", (await page.locator("#log").innerText()).includes("mini claude の元の回答"));

    await page.evaluate(() => selectThread("missing", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
    await page.waitForFunction(() => window.__socket.readyState === 1);
    await page.evaluate(() => setRunState("error", "会話を開けません"));
    await page.evaluate(() => renderHistoryEntries([], ""));
    check("a failed history load is never described as an empty conversation", !(await page.locator("#log").innerText()).includes("まだやり取りはありません"));
    check("a genuinely missing thread is retained without creating a replacement", (await view()).thread === "missing" && !(await view()).ready, await view());
    const recoveryButton = page.getByRole("button", { name: "同じフォルダで新しく開く", exact: true });
    const recoveryVisible = await recoveryButton.count() === 1;
    check("a missing conversation offers an explicit way forward", recoveryVisible, await page.evaluate(() => ({ run: currentRunState, ready: connectionReady, thread: selectedThread, workdir: selectedThreadWorkdir(""), panel: document.querySelector(".thread-recovery")?.textContent })));
    if (recoveryVisible) {
      await page.locator("#prompt").fill("元の会話に残す下書き");
      const savedDraftKey = await page.evaluate(() => currentThreadColorKey());
      const before = await page.evaluate(() => window.__socketUrls.length);
      try { await recoveryButton.click(); } catch (error) {
        console.log(JSON.stringify(await page.evaluate(() => ({ view: { run: currentRunState, ready: connectionReady, thread: selectedThread, workdir: selectedThreadWorkdir("") }, log: document.querySelector("#log").innerText, sockets: window.__socketUrls.slice(-3) }))));
        if (shots) await page.screenshot({ path: path.join(shotsDir, "recovery-failure.png") });
        throw error;
      }
      await settled("codex", "mini-codex");
      const created = await page.evaluate(() => window.__socketUrls.slice(-1)[0]);
      const requested = new URL(created);
      check("recovery opens only the chosen machine, AI and original folder", requested.origin === origin.replace("http:", "ws:")
        && requested.searchParams.get("provider") === "codex" && requested.searchParams.get("workdir") === "/fixture/mini"
        && requested.searchParams.get("fresh") === "1" && !requested.searchParams.has("thread"), created);
      check("one recovery click creates exactly one fresh conversation", await page.evaluate(before => window.__socketUrls.slice(before).filter(value => new URL(value).searchParams.get("fresh") === "1").length, before) === 1);
      check("the original conversation's draft remains saved", await page.evaluate(key => threadDrafts[key], savedDraftKey) === "元の会話に残す下書き");
      check("recovery controls disappear once the new conversation opens", await page.locator(".thread-recovery").count() === 0);
      await page.evaluate(() => selectThread("missing", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
      await page.waitForFunction(() => currentRunState === "error");
      check("returning to the original missing conversation restores its draft", await page.locator("#prompt").inputValue() === "元の会話に残す下書き");
      await page.evaluate(() => addEntry("error", "元の会話を開けません"));
      check("recovery controls remain visible alongside the actual failure message", await recoveryButton.isVisible());
      await page.evaluate(() => setRunState("ready"));
      check("a later idle status cannot hide the failure before the conversation opens", await page.evaluate(() => currentRunState === "error") && await recoveryButton.isVisible());
      for (const width of [320, 393]) {
        await page.setViewportSize({ width, height: 852 });
        const metrics = await page.locator(".thread-recovery").evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, right: el.getBoundingClientRect().right, viewport: innerWidth }));
        check(`recovery actions fit ${width}px`, metrics.width > 0 && metrics.scrollWidth <= metrics.width + 1 && metrics.right <= width, metrics);
      }
      if (shots) await page.screenshot({ path: path.join(shotsDir, `${process.argv.includes("--webkit") ? "webkit" : "chromium"}-recovery.png`) });
      workspaceFailure = true;
      await recoveryButton.click();
      await page.waitForFunction(() => [...document.querySelectorAll(".thread-recovery button")].every(button => !button.disabled));
      check("an unavailable folder preserves the original selection and draft", (await view()).thread === "missing" && await page.locator("#prompt").inputValue() === "元の会話に残す下書き");
      workspaceFailure = false;
      let releaseWorkspace;
      delayWorkspace = new Promise(resolve => { releaseWorkspace = resolve; });
      const workspacePending = new Promise(resolve => { workspaceRequested = resolve; });
      const freshBefore = await page.evaluate(() => window.__socketUrls.filter(value => new URL(value).searchParams.has("fresh")).length);
      await recoveryButton.click();
      await Promise.race([workspacePending, new Promise((_, reject) => setTimeout(() => reject(new Error("Folder validation did not start")), 4000))]);
      check("repeated recovery clicks are disabled during folder validation", await recoveryButton.isDisabled());
      await page.evaluate(() => selectThread("mini-codex", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
      await settled("codex", "mini-codex");
      releaseWorkspace();
      delayWorkspace = null;
      await page.waitForTimeout(100);
      check("a late folder validation cannot replace a newly selected conversation", (await view()).thread === "mini-codex"
        && await page.evaluate(() => window.__socketUrls.filter(value => new URL(value).searchParams.has("fresh")).length) === freshBefore);

      await page.goto(`${origin}/?provider=codex&thread=unknown-folder`);
      const pickFolder = page.getByRole("button", { name: "フォルダを選んで新しく開く", exact: true });
      await pickFolder.waitFor();
      await pickFolder.click();
      check("an unknown original folder requires explicit folder selection", await page.locator("#newSessionDialog").evaluate(el => el.open) && (await view()).thread === "unknown-folder");
      await page.keyboard.press("Escape");
    }

    if (checks.find(c => c.name.startsWith("a previously poisoned"))?.ok) {
      let release;
      delayRecovery = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { recoveryRequested = resolve; });
      await page.evaluate(() => selectThread("mini-claude", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
      await Promise.race([requested, new Promise((_, reject) => setTimeout(() => reject(new Error("Recovery did not start")), 4000))]);
      await page.evaluate(() => selectThread("mini-codex", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
      await settled("codex", "mini-codex");
      release();
      delayRecovery = null;
      await page.waitForTimeout(100);
      check("a late recovery cannot switch away from the newly selected conversation", (await view()).thread === "mini-codex" && (await view()).provider === "codex", await view());
    }
    await page.evaluate(() => selectThread("mini-codex", { thread: { provider: "codex" }, workdir: "/fixture/mini" }));
    await settled("codex", "mini-codex");
    await page.locator("#prompt").fill("競合中も残す下書き");
    await page.evaluate(() => {
      setReady(false);
      window.__socket.emit({ type: "runState", state: "error", label: "会話を開けません" });
      window.__socket.emit({ type: "error", code: "thread_writer_conflict", retryable: false,
        text: "同じ会話を別のCodex画面が使用しています。作業を保存して会話を閉じてから「同じ会話に再接続」を押してください。" });
    });
    const reconnect = page.getByRole("button", { name: "同じ会話に再接続", exact: true });
    await reconnect.waitFor();
    check("writer conflicts explain what to close before reconnecting", (await page.locator(".thread-recovery").innerText()).includes("別のCodex画面"));
    check("the recovery instructions wrap instead of hiding the next action", await page.locator(".thread-recovery > p").evaluate(el => getComputedStyle(el).whiteSpace === "normal" && el.scrollWidth <= el.clientWidth + 1));
    check("a known Codex conflict cannot trigger provider recovery", await page.evaluate(() => recoverSelectedThreadProvider(selectedThread, "codex", activeBridgeId)) === false);
    check("a conflict preserves both the saved answer and the draft", (await page.locator("#log").innerText()).includes("mini codex の元の回答")
      && await page.locator("#prompt").inputValue() === "競合中も残す下書き");
    if (shots) await page.screenshot({ path: path.join(shotsDir, `${process.argv.includes("--webkit") ? "webkit" : "chromium"}-writer-conflict.png`) });
    const beforeRetry = await page.evaluate(() => window.__socketUrls.length);
    await reconnect.click();
    await settled("codex", "mini-codex");
    const retried = new URL(await page.evaluate(() => window.__socketUrls.at(-1)));
    check("manual recovery reconnects exactly once to the original machine, AI, thread and folder", await page.evaluate(() => window.__socketUrls.length) === beforeRetry + 1
      && retried.origin === origin.replace("http:", "ws:") && retried.searchParams.get("thread") === "mini-codex"
      && retried.searchParams.get("provider") === "codex" && retried.searchParams.get("workdir") === "/fixture/mini" && !retried.searchParams.has("fresh"));
    check("reconnection preserves the unsent draft without submitting it", await page.locator("#prompt").inputValue() === "競合中も残す下書き");
    check("successful reconnection clears the recovery panel", await page.locator(".thread-recovery").count() === 0);
    check("no browser JavaScript errors", errors.length === 0, errors);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  assert.ok(checks.every(c => c.ok), "Phone open/settings regressions failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
