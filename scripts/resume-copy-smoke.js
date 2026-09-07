// Exercise the real drawer renderer and clipboard without a live AI backend.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const { startServer, mockApi, mockWebSocket } = require("./mobile-smoke");

async function run() {
  const { server, origin } = await startServer();
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
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
          getBridgeState(activeBridgeId).info = { hostName: "Example-Mac-mini.local" };
          getBridgeState("resume-air").info = { hostName: "Example-MacBook-Air.local" };
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
        assert.ok(expected.fits, `${provider} copy button must fit at ${width}px`);
        assert.equal(expected.copied, expected.command);
        assert.equal(expected.unchanged, true);
      }
    }
    const unsafe = await page.evaluate(() => {
      const thread = { provider: "codex", id: "saved-id", cwd: "/tmp/project", bridgeId: "unknown-owner" };
      const missingOwner = resumeCommandForThread(thread);
      const version = uiUtils.portableResumeVersion;
      uiUtils.portableResumeVersion = undefined;
      const oldHelper = resumeCommandForThread({ ...thread, bridgeId: activeBridgeId });
      uiUtils.portableResumeVersion = version;
      return { missingOwner, oldHelper };
    });
    assert.deepEqual(unsafe, { missingOwner: "", oldHelper: "" });
    console.log(`${engine.name()}: Codex/Claude copy buttons preserve owning host, clipboard and selection; fit 320/390/430px; missing ownership and old cached helpers fail closed`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
