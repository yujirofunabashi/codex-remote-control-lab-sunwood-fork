// Exercise the shipped phone UI with local mock connections only.
const assert = require("node:assert/strict");
const { chromium, webkit } = require("playwright");
const { startServer, mockApi, mockWebSocket } = require("./mobile-smoke");

async function run() {
  const { server, origin } = await startServer();
  const engine = process.argv.includes("--webkit") ? webkit : chromium;
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await mockApi(page, origin);
    await mockWebSocket(page);
    await page.addInitScript(() => {
      localStorage.setItem("codexPhoneModel", "gpt-5.5");
      localStorage.setItem("codexPhoneReasoning", "medium");
    });
    await page.goto(`${origin}/?token=smoke-token`);
    await page.waitForFunction(() => document.querySelector("#runState")?.dataset.state === "done");
    const result = await page.evaluate(() => {
      const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"];
      const sent = [];
      ws.send = body => sent.push(JSON.parse(body));
      adoptModelChoices({ codex: ["gpt-5.5", ...models] });
      const oldSelection = selectedModel;
      const menu = [...modelMenu.querySelectorAll("[data-model-choice]")].map(row => row.dataset.modelChoice);
      promptInput.value = "keep this draft";
      pendingFiles = [{ name: "keep.txt", kind: "file", dataUrl: "data:text/plain;base64,a2VlcA==" }];
      composer.requestSubmit();
      const rejected = { sent: sent.length, draft: promptInput.value, files: pendingFiles.length, pending: Boolean(pendingSubmission) };

      artifactList.replaceChildren();
      renderLocalSettings({
        settings: { provider: "codex", model: "gpt-5.5", workdir: "/tmp" },
        active: { provider: "codex", model: "gpt-5.5", workdir: "/tmp" },
        options: { modelsByProvider: { codex: ["gpt-5.5", ...models], claude: ["sonnet", "opus", "haiku", "fable"] }, defaultModels: { codex: "gpt-5.5" } },
      });
      const select = artifactList.querySelectorAll(".settings-form select")[1];
      const savedOptions = [...select.options].map(option => ({ value: option.value, disabled: option.disabled }));
      const savedSelection = select.value;
      const accepted = [];
      pendingFiles = [];
      for (const model of models) {
        setSelectedModel(model);
        selectReasoning("medium");
        promptInput.value = "verified simple work";
        composer.requestSubmit();
        accepted.push(sent.at(-1));
        releasePendingSubmission();
      }
      setActiveProvider("claude");
      setSelectedModel("sonnet");
      selectReasoning("low");
      promptInput.value = "simple Claude work";
      composer.requestSubmit();
      const claude = sent.at(-1);
      releasePendingSubmission();

      setActiveProvider("codex");
      adoptModelChoices({ codex: [] });
      const emptyMenu = modelMenu.querySelectorAll("[data-model-choice]").length;
      return { oldSelection, menu, rejected, savedOptions, savedSelection, accepted, claude, emptyMenu };
    });
    assert.equal(result.oldSelection, "gpt-5.5");
    assert.ok(!result.menu.includes("gpt-5.5"));
    assert.deepEqual(result.rejected, { sent: 0, draft: "keep this draft", files: 1, pending: false });
    assert.equal(result.savedSelection, "gpt-5.5");
    assert.equal(result.savedOptions.find(option => option.value === "gpt-5.5").disabled, true);
    assert.deepEqual(result.accepted.map(message => message.options.model), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]);
    assert.ok(result.accepted.every(message => message.options.effort === "medium"));
    assert.equal(result.claude.options.model, "sonnet");
    assert.equal(result.claude.options.effort, "low");
    assert.equal(result.emptyMenu, 0);
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: old choices rejected with drafts/attachments intact; eligible models and lighter efforts preserved; no automatic replacement`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
