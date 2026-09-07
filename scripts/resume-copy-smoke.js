// Exercise the real drawer renderer and clipboard without a live AI backend.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const { startServer, mockApi, mockWebSocket } = require("./mobile-smoke");

async function run() {
  const { server, origin } = await startServer();
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  let browser;
  try {
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mockApi(page, origin);
    await mockWebSocket(page);
    await page.goto(`${origin}/?token=smoke-token`);
    await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done");
    await page.evaluate(() => {
      document.querySelector("[data-pwa-dismiss]")?.click();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (text) => { window.__copiedResume = text; },
      } });
    });
    await page.locator("#mobileThreads").click();
    await page.locator(".thread-resume-copy").first().waitFor();
    const codex = await page.locator(".thread-resume-copy").first().getAttribute("title");
    assert.ok(codex.includes("codex resume"));
    assert.ok(codex.includes("--remote 'ws://127.0.0.1:45213'"));
    await page.locator(".thread-resume-copy").first().click();
    assert.equal(await page.evaluate(() => window.__copiedResume), codex);
    await page.locator('[data-thread-provider="claude"]').click();
    await page.locator(".thread-item", { hasText: "Drawer and composer tuning" }).waitFor();
    const claude = await page.locator(".thread-resume-copy").first().getAttribute("title");
    assert.ok(claude.includes("claude --resume"));
    await page.locator(".thread-resume-copy").first().click();
    assert.equal(await page.evaluate(() => window.__copiedResume), claude);

    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const provider of ["codex", "claude"]) {
        const expected = await page.evaluate(async (provider) => {
          // The active Mac must not override the owner, nor may a renamed label.
          getBridgeState(activeBridgeId).info = { hostName: "Example-Mac-mini.local", codexUrl: "ws://127.0.0.1:45233" };
          getBridgeState("resume-air").info = { hostName: "Example-MacBook-Air.local", codexUrl: "ws://127.0.0.1:45213" };
          const thread = { provider, id: "saved-resume-thread", cwd: "/Users/example/My Project", bridgeId: "resume-air", machineLabel: "mini", name: "別のMacの会話を引き継ぐための長い名前" };
          const row = createThreadListItem(thread);
          row.id = "resume-test-row";
          threadList.replaceChildren(row);
          const button = row.querySelector(".thread-resume-copy");
          const b = button.getBoundingClientRect();
          const r = row.getBoundingClientRect();
          const title = row.querySelector(".thread-title").getBoundingClientRect();
          const before = { thread: selectedThread, bridge: activeBridgeId };
          // Dispatch in the same browser task as fixture insertion so the
          // normal background list refresh cannot remove the synthetic row.
          button.click();
          await Promise.resolve();
          return { command: button.title, copied: window.__copiedResume, unchanged: before.thread === selectedThread && before.bridge === activeBridgeId,
            fits: b.left >= r.left && b.right <= r.right + 1 && b.right <= innerWidth && b.top < title.bottom && b.bottom > title.top };
        }, provider);
        assert.ok(expected.command.includes("ssh -t 'air'"));
        assert.ok(expected.command.includes("Example-MacBook-Air.local"));
        assert.ok(!expected.command.includes("Example-Mac-mini.local"));
        if (provider === "codex") {
          assert.ok(expected.command.includes("--remote"));
          assert.ok(expected.command.includes("45213"));
          assert.ok(!expected.command.includes("45233"));
        }
        assert.ok(expected.fits, `${provider} copy button must fit at ${width}px`);
        assert.equal(expected.copied, expected.command);
        assert.equal(expected.unchanged, true);
      }
    }
    const unsafe = await page.evaluate(() => {
      const thread = { provider: "codex", id: "saved-id", cwd: "/tmp/project", bridgeId: "unknown-owner" };
      const missingOwner = resumeCommandForThread(thread);
      const version = uiUtils.portableResumeVersion;
      uiUtils.portableResumeVersion = 1;
      const oldHelper = resumeCommandForThread({ ...thread, bridgeId: activeBridgeId });
      uiUtils.portableResumeVersion = version;
      return { missingOwner, oldHelper };
    });
    assert.deepEqual(unsafe, { missingOwner: "", oldHelper: "" });

    const statusFallback = await page.evaluate(() => {
      const state = getBridgeState("older-bridge");
      state.info = { hostName: "Example-MacBook-Air.local" };
      state.status = { codexUrl: "ws://127.0.0.1:45913" };
      return resumeCommandForThread({ provider: "codex", id: "saved-id", cwd: "/tmp/project", bridgeId: "older-bridge" });
    });
    assert.ok(statusFallback.includes("--remote"));
    assert.ok(statusFallback.includes("45913"));
    const changedSocket = await page.evaluate(() => {
      const state = getBridgeState("older-bridge");
      state.info.codexUrl = "ws://127.0.0.1:45933";
      state.info.codexSocketPath = null;
      state.status.codexSocketPath = "/tmp/retired-socket";
      return resumeCommandForThread({ provider: "codex", id: "saved-id", cwd: "/tmp/project", bridgeId: "older-bridge" });
    });
    assert.ok(changedSocket.includes("45933"));
    assert.ok(!changedSocket.includes("retired-socket"));

    // A decision made in the terminal must clear the phone card and its fleet
    // badge, not leave an already answered request waiting on the next visit.
    const resolved = await page.evaluate(() => {
      const deliver = (message) => window.__mockSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      deliver({ type: "approval", request: { id: 91, method: "item/commandExecution/requestApproval", params: { threadId: selectedThread, command: ["pwd"] } } });
      deliver({ type: "runState", state: "running", label: "別の画面で承認に回答しました", turnId: "shared-turn" });
      return { request: pendingApproval, fleetRequest: getBridgeState().pendingApproval, hidden: approval.classList.contains("hidden") };
    });
    assert.deepEqual(resolved, { request: null, fleetRequest: null, hidden: true });

    const resumedStream = await page.evaluate(() => {
      const deliver = (message) => window.__mockSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      deliver({ type: "ready", provider: "codex", threadId: selectedThread, model: selectedModel, workdir: "/tmp/project", clients: 1,
        history: [{ type: "user", text: "Terminal input", outputGroup: "resumed-turn" },
          { type: "assistant", text: "Partial ", outputGroup: "resumed-turn" }],
        run: { state: "streaming", turnId: "resumed-turn" } });
      const before = assistantEntry;
      deliver({ type: "assistantDelta", threadId: selectedThread, text: "continuation" });
      return { sameEntry: before === assistantEntry, text: assistantEntry.markdownSource };
    });
    assert.deepEqual(resumedStream, { sameEntry: true, text: "Partial continuation" });
    console.log(`${engine.name()}: Codex/Claude copy buttons preserve owning host, clipboard and selection; fit 320/390/430px; missing ownership and old cached helpers fail closed`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
