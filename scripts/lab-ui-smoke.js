// Real browser + real lab HTTP/WebSocket server; an in-memory guest replaces
// Windows. No provider invocation, credentials, files or notifications leave it.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium, webkit } = require("playwright");
const { startServer } = require("./mobile-smoke");
const { createLabServer } = require("./start-lab-bridge");

async function run() {
  const { server, origin } = await startServer();
  const progressDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lab-progress-ui-"));
  const progressFile = path.join(progressDirectory, "progress.json");
  const progress = { schema: 1, status: "revision_limit", verifiedAt: Date.now() - 86400000, aiInvocations: 10,
    sourceSha256: "a".repeat(64), project: "Windows内の収益実験", department: "品質検査",
    result: "部門の実回答10件を確認。最後の検査は修正待ち。", stopReason: "注文の上限を守れるか未確認。",
    nextAction: "上限を守る方法を確認し、計画を修正する。", ownerAction: "ありません。" };
  fs.writeFileSync(progressFile, JSON.stringify(progress), { mode: 0o600 });
  const config = { id: "windows-lab", targetHost: "windows.fixture", host: "127.0.0.1", port: 45251,
    workRoot: "/home/agent-lab/work", model: "gpt-6-astra", effort: "xhigh",
    phoneToken: "p".repeat(40), workerToken: "w".repeat(40), allowedOrigins: [origin], progressFile };
  const app = createLabServer(config);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const labOrigin = `http://127.0.0.1:${app.server.address().port}`;
  config.allowedOrigins.push(labOrigin);
  const root = config.workRoot;
  const airOrigin = "http://127.0.0.1:45999";
  let vmState = "off", aiEnabled = false, runningJob = null, runCount = 0, observing = true;
  const results = [];
  const finish = (id, data) => app.store.complete(id, { ok: true, data });
  const snapshot = { artifacts: [{ path: `${root}/example/report.md`, size: 30 }], firstPlan: { path: `${root}/first-ai-task-01/PLAN.json`, text: '{"status":"計画の下書き"}', modifiedAt: Date.now() } };
  app.store.acceptSnapshot(snapshot);
  app.store.state.folders[root] = { path: root, fetchedAt: Date.now(), entries: [{ name: "example", path: `${root}/example` }] };
  const worker = setInterval(() => {
    try {
      if (!observing) return;
      app.store.heartbeat({ vmState, guestReady: vmState === "running", aiReady: aiEnabled && vmState === "running" });
      const command = app.store.lease();
      if (!command) return;
      if (command.op === "start") { vmState = "running"; finish(command.id, { ready: true }); }
      if (command.op === "shutdown") { vmState = "off"; finish(command.id, { stopping: true }); }
      if (command.op === "browse") finish(command.id, { path: command.args.path, entries: command.args.path === root ? [{ name: "example", path: `${root}/example` }] : [] });
      if (command.op === "snapshot") finish(command.id, snapshot);
      if (command.op === "read") finish(command.id, { path: command.args.path, kind: "markdown", text: "# 検査結果\n公開なし。\n<script>window.__labUnsafe=true</script>" });
      if (command.op === "run" && !runningJob) { runningJob = command; runCount++; app.store.event(command.id, { type: "status" }); }
      if (command.op === "interrupt") {
        app.store.complete(command.args.taskId, { ok: false, error: "作業を中断しました。", data: { interrupted: true } });
        finish(command.id, { interrupted: command.args.taskId });
        runningJob = null;
      }
    } catch (error) { results.push(error.message); }
  }, 50);
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(({ airOrigin, labOrigin, token }) => {
      localStorage.setItem("codexPhonePwaInstallHint:v1", "dismissed");
      localStorage.setItem("codexPhoneBridgeRegistry:v1", JSON.stringify({ version: 1, bridges: [
        { id: "air", label: "Air", baseUrl: airOrigin, rememberToken: true },
        { id: "windows-lab", label: "Windows実験室", baseUrl: labOrigin, rememberToken: true },
      ] }));
      localStorage.setItem("codexPhoneBridgeTokens:v1", JSON.stringify({ air: "fixture-token", "windows-lab": token }));
      localStorage.setItem("codexPhoneReasoning", "max");
      const NativeWebSocket = window.WebSocket;
      class LocalSocket extends EventTarget {
        constructor(address, protocols) {
          const url = new URL(address);
          if (url.port === new URL(labOrigin).port) return new NativeWebSocket(address, protocols);
          super();
          this.readyState = 0;
          setTimeout(() => {
            if (this.readyState === 3) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ready", provider: "codex", threadId: "original", model: "gpt-6-astra",
              workdir: "/Users/fixture/project", history: [{ type: "assistant", text: "前の返答" }], run: { state: "done" } }) }));
          }, 20);
        }
        send() {}
        close() { this.readyState = 3; }
      }
      LocalSocket.OPEN = 1;
      window.WebSocket = LocalSocket;
    }, { airOrigin, labOrigin, token: config.phoneToken });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.origin === labOrigin) return route.continue();
      const machine = url.origin === airOrigin ? "air" : "home";
      const info = { id: machine, machineLabel: machine === "air" ? "Air" : "mini", provider: "codex", providers: ["codex", "claude"], model: "gpt-6-astra", workdir: "/Users/fixture/project" };
      const reply = json => route.fulfill({ json, headers: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" } });
      if (["/api/bridge/info", "/api/info"].includes(url.pathname)) return reply(info);
      if (url.pathname === "/api/status") return reply({ ...info, bridges: [] });
      if (url.pathname === "/api/threads") return reply({ provider: "codex", data: [{ id: "original", provider: "codex", name: "前のチャット", cwd: info.workdir }] });
      if (url.pathname === "/api/thread") return reply({ provider: "codex", threadId: "original", history: [{ type: "assistant", text: "前の返答" }] });
      if (url.pathname === "/api/bridge/registry") return reply({ version: 2, bridges: [], tokens: {}, deleted: [] });
      if (url.pathname === "/api/workspaces/browse") return reply({ path: "/Users/fixture", entries: [] });
      return reply({ data: [] });
    });
    await page.goto(`${origin}/?token=fixture-token&thread=original&provider=codex`);
    await page.waitForFunction(() => connectionReady && getBridgeState("windows-lab").info?.capabilities?.lab);
    await page.waitForTimeout(750);
    assert.equal(await page.evaluate(() => bridgeRegistry.bridges.length), 3);
    const openSidebar = async () => { if (!await page.evaluate(() => document.body.classList.contains("show-sidebar"))) await page.locator("#mobileThreads").click(); };
    await page.locator("#prompt").fill("miniの下書き");
    await openSidebar();
    await page.locator("#newSessionButton").click();
    await page.locator("#newSessionMachine").selectOption("windows-lab");
    await page.waitForFunction(() => newSessionFolder?.bridgeId === "windows-lab");
    assert.ok(await page.locator("#createNewSession").isDisabled());
    assert.ok(await page.locator("#newSessionProvider").isDisabled());
    assert.match(await page.locator("#newSessionStatus").textContent(), /保存済み/);
    await page.locator("#cancelNewSession").click();
    assert.equal(await page.locator("#prompt").inputValue(), "miniの下書き");

    await page.evaluate(() => setActiveBridge("windows-lab"));
    await page.waitForFunction(() => connectionReady && selectedThread === "lab-first-plan");
    if (await page.evaluate(() => document.body.classList.contains("show-sidebar"))) {
      await page.locator("#sidebarScrim").click({ position: { x: 380, y: 100 } });
      await page.waitForFunction(() => document.querySelector("#threadSidebar").getBoundingClientRect().right <= 1);
    }
    await page.waitForFunction(() => document.querySelector("#labProgressState").textContent.includes("現在は停止中"));
    assert.ok(await page.locator("#labProgress").isVisible());
    assert.match(await page.locator("#labProgressResult").textContent(), /実回答10件/);
    await page.locator("#labProgress summary").click();
    assert.match(await page.locator("#labProgressFreshness").textContent(), /実行時刻ではありません/);
    assert.equal(await page.locator("#labProgressFreshness").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.match(await page.locator("#labProgressNext").textContent(), /計画を修正/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#labProgress").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator("#labProgressResult").evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
    if (process.argv.includes("--shots")) {
      const output = path.join(__dirname, "..", "output", "playwright");
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, "windows-lab-progress.png"), fullPage: true });
    }
    await page.locator("#labProgress summary").click();
    await openSidebar();
    assert.ok(await page.locator("#labControls").isVisible());
    assert.match(await page.locator("#labStateLabel").textContent(), /停止中/);
    await page.locator("#labStart").click();
    await page.waitForFunction(() => getBridgeState(activeBridgeId).status?.lab?.ready);
    await page.locator("#newSessionButton").click();
    await page.waitForFunction(() => !createNewSession.disabled);
    await page.getByRole("button", { name: "example", exact: true }).click();
    await page.waitForFunction(() => newSessionFolder?.path.endsWith("/example") && !createNewSession.disabled);
    await page.locator("#createNewSession").click();
    await page.waitForFunction(() => connectionReady && currentWorkspace.workspaceLocation.endsWith("/example") && !newSessionDialog.open);
    assert.ok(await page.locator("#accessButton").isDisabled());
    assert.ok(await page.locator("#modelButton").isDisabled());
    assert.equal(await page.evaluate(() => localStorage.getItem("codexPhoneReasoning")), "max");
    await page.locator("#prompt").fill("専用フォルダ内の検査をしてください");
    assert.ok(await page.locator("#send").isDisabled());
    assert.match(await page.locator("#labStateLabel").textContent(), /AI作業は準備中/);
    await page.locator("#prompt").press("Control+Enter");
    assert.equal(await page.locator("#prompt").inputValue(), "専用フォルダ内の検査をしてください");
    assert.equal(runCount, 0);
    // A first-time connection has no token during its initial artifact fetch.
    // Use only visible controls after entering the key, without a reload or
    // directly calling loadArtifacts/showArtifact from the test.
    const recoveredPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    recoveredPage.setDefaultTimeout(10000);
    try {
      await recoveredPage.goto(labOrigin);
      await recoveredPage.getByRole("textbox", { name: "接続キー", exact: true }).fill(config.phoneToken);
      await recoveredPage.getByRole("button", { name: "保存して接続", exact: true }).click();
      await recoveredPage.waitForFunction(() => document.querySelector("#labStateLabel").textContent.includes("AI作業は準備中"));
      await recoveredPage.locator("#artifactsTab").click();
      await recoveredPage.locator("#artifactList").getByRole("button", { name: /report\.md/ }).click();
      await recoveredPage.waitForFunction(() => document.querySelector("#artifactPreview").textContent.includes("実験室から取得"));
      assert.ok(await recoveredPage.locator("#send").isDisabled());
      assert.equal(runCount, 0);
    } finally {
      await recoveredPage.close();
    }
    await page.evaluate(async () => { await loadArtifacts(); await showArtifact("/home/agent-lab/work/example/report.md"); });
    assert.match(await page.locator("#artifactPreview").textContent(), /実験室から取得/);
    await page.evaluate(() => setMainView("chat"));
    aiEnabled = true; // Simulated approval/verification, never a real guest toggle.
    await page.waitForFunction(() => getBridgeState(activeBridgeId).status?.lab?.aiReady && !sendButton.disabled);
    await page.locator("#prompt").press("Control+Enter");
    await page.waitForFunction(() => currentRunState === "running" && !pendingSubmission && runStateLabel.textContent === "Windowsで作業中");
    await page.waitForFunction(() => document.querySelector("#labProgressState").textContent.includes("AIが作業中"));
    assert.equal(runCount, 1);
    // Break only the browser connection while the fake guest keeps running.
    await page.evaluate(() => { ws.close(); });
    await page.waitForFunction(() => connectionReady && currentRunState === "running");
    assert.equal(runCount, 1);
    finish(runningJob.id, { text: "専用フォルダ内の検査が終わりました。公開・支出なし。" });
    runningJob = null;
    await page.waitForFunction(() => currentRunState === "done" && log.textContent.includes("検査が終わりました"));
    await page.evaluate(async () => { await loadArtifacts(); await showArtifact("/home/agent-lab/work/example/report.md"); });
    assert.match(await page.locator("#artifactPreview").textContent(), /実験室から取得/);
    assert.equal(await page.evaluate(() => Boolean(window.__labUnsafe)), false);
    vmState = "off";
    await page.waitForTimeout(80);
    await page.evaluate(async () => { await refreshBridgeState(activeBridgeId, { force: true }); await showArtifact("/home/agent-lab/work/example/report.md"); });
    assert.match(await page.locator("#artifactPreview").textContent(), /保存済みの表示・現在の内容は未確認/);
    observing = false;
    app.store.lastHeartbeat = 0;
    await page.evaluate(() => refreshBridgeState(activeBridgeId, { force: true }));
    await page.waitForFunction(() => document.querySelector("#labProgressState").textContent.includes("稼働は未確認"));
    assert.match(await page.locator("#labProgressResult").textContent(), /実回答10件/);
    fs.writeFileSync(progressFile, JSON.stringify({ ...progress, status: "completed", result: "修正後の検査を完了。" }), { mode: 0o600 });
    await page.waitForFunction(() => document.querySelector("#labProgressResult").textContent.includes("修正後の検査を完了"));
    assert.match(await page.locator("#labProgressState").textContent(), /稼働は未確認/);
    if (process.argv.includes("--shots")) {
      const output = path.join(__dirname, "..", "output", "playwright");
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, "windows-lab-files.png"), fullPage: true });
    }
    await page.evaluate(() => setActiveBridge(homeBridgeId));
    await page.waitForFunction(() => connectionReady && selectedThread === "original");
    assert.equal(await page.locator("#labProgress").isVisible(), false);
    assert.equal(await page.locator("#prompt").inputValue(), "miniの下書き");
    assert.ok(await page.locator("#labControls").isHidden());
    assert.ok(await page.locator("#accessButton").isEnabled());
    assert.equal(await page.evaluate(() => localStorage.getItem("codexPhoneReasoning")), "max");
    assert.deepEqual(errors, []);
    assert.deepEqual(results, []);
    process.stdout.write("Windows lab UI passed: three machines, read-only before AI verification, offline cache, guarded folder, one submission through reconnect, results, original draft/settings.\n");
  } finally {
    clearInterval(worker);
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(progressDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; });
module.exports = { run };
