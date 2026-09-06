// Exercise the real page and model-label renderer with offline bridge fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium, webkit } = require("playwright");
const { startServer, mockApi, mockWebSocket } = require("./mobile-smoke");

async function run() {
  const { server, origin } = await startServer();
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const failures = [];
  try {
    await mockApi(page, origin);
    await mockWebSocket(page);
    await page.goto(`${origin}/?token=smoke-token`);
    await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done");
    await page.evaluate(() => document.querySelector("[data-pwa-dismiss]")?.click());
    const isolation = await page.evaluate(() => {
      const deliver = (message) => window.__mockSocket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      deliver({ type: "assistantDelta", threadId: selectedThread, text: "OWN_REPLY_MARKER" });
      const before = document.querySelector("#log").textContent;
      for (const message of [
        { type: "assistantDelta", text: "FOREIGN_REPLY_MARKER" },
        { type: "turn", status: "completed", run: { state: "done" } },
        { type: "runState", state: "done" },
        { type: "approval", request: { id: 1, method: "item/commandExecution/requestApproval", params: { command: ["foreign"] } } },
      ]) deliver({ ...message, threadId: "foreign-thread" });
      return {
        ownReplyVisible: before.includes("OWN_REPLY_MARKER"),
        foreignReplyAbsent: document.querySelector("#log").textContent === before,
        state: currentRunState,
        approval: pendingApproval,
      };
    });
    assert.equal(isolation.ownReplyVisible, true);
    assert.equal(isolation.foreignReplyAbsent, true);
    assert.equal(isolation.state, "streaming");
    assert.equal(isolation.approval, null);
    for (const width of [320, 375, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [provider, model, effort] of [
        ["claude", "opus", "xhigh"], ["claude", "sonnet", "max"],
        ["codex", "gpt-6-astra", "max"], ["codex", "gpt-5.6-sol", "xhigh"],
      ]) {
        for (const running of [false, true]) {
          await page.evaluate(({ provider, model, effort, running }) => {
            setActiveProvider(provider);
            adoptReasoningChoices({ [provider]: ["low", "medium", "high", "xhigh", "max"] });
            setSelectedModel(model, { persist: false, provider });
            selectedReasoning = effort;
            updateModelButton();
            applyServerRunState({ state: running ? "running" : "done", turnId: running ? "layout-turn" : null });
          }, { provider, model, effort, running });
          const result = await page.evaluate(() => {
            const button = document.querySelector("#modelButton");
            const rect = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(button);
            const textRects = [...range.getClientRects()].filter((r) => r.width > 0);
            const controls = ["#accessButton", "#modelButton", "#voiceButton", "#interruptRun", "#send"]
              .map((id) => document.querySelector(id)).filter((el) => el && el.getClientRects().length)
              .map((el) => ({ id: el.id, rect: el.getBoundingClientRect() }));
            const overlaps = controls.some((a, i) => controls.slice(i + 1).some((b) =>
              Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 &&
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1));
            return {
              text: button.textContent,
              textFits: textRects.every((r) => r.left >= rect.left - 1 && r.right <= rect.right + 1 && r.top >= rect.top - 1 && r.bottom <= rect.bottom + 1),
              controlsFit: controls.every(({ rect: r }) => r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight),
              overlaps,
              pageFits: document.documentElement.scrollWidth <= innerWidth,
            };
          });
          if (!result.textFits || !result.controlsFit || result.overlaps || !result.pageFits) failures.push({ width, provider, model, effort, running, ...result });
          if (process.argv.includes("--shots") && width === 390 && !running && model === "opus") {
            const directory = path.resolve(__dirname, "../output/playwright");
            fs.mkdirSync(directory, { recursive: true });
            await page.screenshot({ path: path.join(directory, `composer-${engine.name()}.png`) });
          }
        }
      }
    }
    assert.equal(failures.length, 0, JSON.stringify(failures, null, 2));
    console.log(`${engine.name()}: foreign session messages ignored; model and effort labels fit at 320, 375, 390, 430 and 768px, idle and running`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
