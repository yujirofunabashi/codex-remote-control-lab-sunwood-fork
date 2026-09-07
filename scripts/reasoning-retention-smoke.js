// Reproduce preference loss using the real page, without live AI requests.
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
    await page.addInitScript(() => {
      if (!localStorage.getItem("codexPhoneReasoning")) localStorage.setItem("codexPhoneReasoning", "ultra");
    });
    const open = async () => {
      await page.goto(`${origin}/?token=smoke-token`);
      await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done");
    };
    await open();
    assert.equal(await page.evaluate(() => localStorage.getItem("codexPhoneReasoning")), "ultra", "startup fallback must not overwrite the saved choice");
    const states = await page.evaluate(() => {
      const full = ["low", "medium", "high", "xhigh", "max", "ultra"];
      const shallow = full.slice(0, 4);
      const owner = activeBridgeId;
      const snapshots = [];
      const record = (step) => snapshots.push({ step, requested: selectedReasoning, stored: localStorage.getItem("codexPhoneReasoning"), effective: effortForSubmission(), label: modelButton.textContent });
      setActiveProvider("codex");
      setSelectedModel("gpt-6-astra");
      adoptReasoningChoices({ codex: shallow, byModel: { "gpt-6-astra": full, "gpt-5.6-luna": shallow } });
      record("known-model");
      // Empty/partial metadata during a reconnect must retain known capabilities.
      adoptReasoningChoices({ codex: shallow, byModel: {} });
      record("partial-reconnect");
      setSelectedModel("gpt-5.6-luna");
      record("shallower-model");
      setSelectedModel("gpt-6-astra");
      record("return-to-model");
      setActiveProvider("claude");
      setSelectedModel("opus");
      record("other-provider");
      setActiveProvider("codex");
      record("return-to-provider");
      // Capabilities belong to a bridge, preferences do not get downgraded by it.
      activeBridgeId = "reasoning-other-mac";
      adoptReasoningChoices({ codex: shallow, byModel: { "gpt-6-astra": shallow } });
      record("other-mac");
      activeBridgeId = owner;
      updateModelButton();
      record("return-to-mac");
      // A background response for the other Mac must not change this one's menu.
      adoptReasoningChoices({ byModel: { "gpt-6-astra": ["medium"] } }, { bridgeId: "reasoning-other-mac" });
      record("late-other-mac-response");
      selectReasoning("high");
      record("explicit-choice");
      return snapshots;
    });
    for (const state of states) {
      const explicit = state.step === "explicit-choice";
      assert.equal(state.requested, explicit ? "high" : "ultra", JSON.stringify(state));
      assert.equal(state.stored, explicit ? "high" : "ultra", JSON.stringify(state));
      const expected = explicit ? "high" : state.step === "other-provider" ? "max" : ["shallower-model", "other-mac"].includes(state.step) ? "xhigh" : "ultra";
      assert.equal(state.effective, expected, JSON.stringify(state));
    }
    await open();
    assert.equal(await page.evaluate(() => localStorage.getItem("codexPhoneReasoning")), "high", "explicit choice survives reload");
    const submission = await page.evaluate(() => {
      const sent = [];
      ws.send = (body) => sent.push(JSON.parse(body));
      promptInput.value = "offline reasoning submission check";
      composer.requestSubmit();
      return sent.find((message) => message.type === "prompt");
    });
    assert.equal(submission?.options.effort, "high", "the saved setting must reach the outgoing prompt, not just the label");
    console.log(`${engine.name()}: reasoning preference survives startup, reconnect, model/provider/Mac switches and reload; effective depth respects capabilities`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
