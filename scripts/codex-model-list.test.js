// A new Codex model used to need a release of this bridge before the phone
// could pick it: the settings sheet and the composer menu read a list typed
// into the source, and that list was already two generations behind the one
// the app-server returned. Now the app-server's answer is what the phone sees,
// remembered on disk between runs, with the typed list only as a fallback.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A shell started by a bridge carries that bridge's PHONE_* and CODEX_* values,
// and anything left in the launch environment counts as pinned.
for (const key of Object.keys(process.env)) {
  if (/^(PHONE_|CODEX_|CLAUDE_|AGENT_)/.test(key)) delete process.env[key];
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-list-"));
const cachePath = path.join(sandbox, "models.json");
const port = 45992;
process.env.PHONE_UI_PORT = String(port);
process.env.PHONE_TOKEN = "test-token";
process.env.PHONE_CODEX_MODELS_CACHE_PATH = cachePath;

const { codexModelChoices, codexModelIdsFromList, localSettingsPayload, readCodexModelCache, rememberCodexModels } = require("./start-phone");

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const liveAnswer = [
  { id: "gpt-6.0-nova", model: "gpt-6.0-nova", displayName: "GPT-6.0-Nova", hidden: false },
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false },
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false },
  { id: "gpt-5.6-internal", model: "gpt-5.6-internal", hidden: true },
  { slug: "gpt-5.5" },
  { id: "" },
  null,
];

test("the app-server's list is read by id, without hidden or repeated entries", () => {
  assert.deepEqual(codexModelIdsFromList(liveAnswer), ["gpt-6.0-nova", "gpt-5.6-sol", "gpt-5.5"]);
  assert.deepEqual(codexModelIdsFromList(undefined), []);
});

test("a remembered list survives on disk and comes back in order", () => {
  assert.deepEqual(readCodexModelCache(cachePath).models, []);
  const remembered = rememberCodexModels(liveAnswer, { cachePath });
  assert.deepEqual(remembered, ["gpt-6.0-nova", "gpt-5.6-sol", "gpt-5.5"]);
  const onDisk = readCodexModelCache(cachePath);
  assert.deepEqual(onDisk.models, remembered);
  assert.ok(onDisk.updatedAt, "the cache records when the list was last confirmed");
  // A failed/missing answer leaves the last catalog; a successful empty list
  // is authoritative and must not resurrect fallback models.
  assert.deepEqual(rememberCodexModels(undefined, { cachePath }), remembered);
  assert.deepEqual(readCodexModelCache(cachePath).models, remembered);
  assert.deepEqual(rememberCodexModels([], { cachePath }), []);
  assert.deepEqual(codexModelChoices(), []);
});

test("a confirmed catalog supplies choices; fallback is only for an unknown catalog", () => {
  const choices = codexModelChoices({
    cache: { models: ["gpt-6.0-nova", "gpt-5.6-sol"], updatedAt: "2026-09-05T00:00:00Z" },
    fallback: ["gpt-5.6-sol", "gpt-5.5"],
    configured: "gpt-7-preview",
  });
  assert.deepEqual(choices, ["gpt-6.0-nova", "gpt-5.6-sol"]);
  // Nothing remembered yet: the fallback alone, still with the configured model.
  assert.deepEqual(codexModelChoices({ cache: { models: [] }, fallback: ["gpt-5.6-sol"], configured: "gpt-5.6-sol" }), ["gpt-5.6-sol"]);
});

test("the settings sheet offers a model the moment the app-server has named it", () => {
  rememberCodexModels(liveAnswer, { cachePath });
  const payload = localSettingsPayload({ envValues: { [`PHONE_AGENT_PROVIDER_${port}`]: "claude" } });
  const codex = payload.options.modelsByProvider.codex;
  assert.equal(codex[0], "gpt-6.0-nova", "the newest model the account has is offered first, on a Claude bridge too");
  assert.ok(codex.includes("gpt-5.6-sol"));
  assert.ok(payload.options.codexModelsUpdatedAt, "the sheet can say how fresh the list is");
  assert.deepEqual(payload.options.modelsByProvider.claude, ["sonnet", "opus", "haiku", "fable"]);
});

// The page keeps the bridge's answer per provider and redraws the menu from it.
const mainSource = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");

function functionSource(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is no longer declared the way this test finds it`);
  // The body starts at the first brace after the parameter list, not at a
  // brace inside it: `({ force = false } = {})` would otherwise end the read.
  let parens = 0;
  let bodyStart = -1;
  for (let i = mainSource.indexOf("(", start); i < mainSource.length; i += 1) {
    if (mainSource[i] === "(") parens += 1;
    else if (mainSource[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        bodyStart = mainSource.indexOf("{", i);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `could not find the body of ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < mainSource.length; i += 1) {
    if (mainSource[i] === "{") depth += 1;
    else if (mainSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return mainSource.slice(start, i + 1);
    }
  }
  throw new Error(`could not read the body of ${name}`);
}

const adopt = new Function(`
  let liveModelChoices = {};
  let redraws = 0;
  const modelMenu = {};
  function normalizeProviderName(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "codex" || text === "claude" ? text : "";
  }
  function updateModelButton() { redraws += 1; }
  ${functionSource("adoptModelChoices")}
  return function run(choices) {
    const before = redraws;
    adoptModelChoices(choices);
    return { live: liveModelChoices, redrew: redraws > before };
  };
`)();

test("the page takes the bridge's model list per provider and redraws the menu", () => {
  let result = adopt({ codex: ["gpt-6.0-nova", "gpt-5.6-sol"], claude: ["opus", "sonnet"] });
  assert.deepEqual(result.live, { codex: ["gpt-6.0-nova", "gpt-5.6-sol"], claude: ["opus", "sonnet"] });
  assert.equal(result.redrew, true);

  // An empty eligible list clears the menu. No answer at all changes nothing.
  result = adopt({ gemini: ["x"], codex: [] });
  assert.deepEqual(result.live, { codex: [], claude: ["opus", "sonnet"] });
  assert.equal(result.redrew, true);
  result = adopt(undefined);
  assert.equal(result.redrew, false);
});

test("the composer menu draws the bridge's list before the typed one", () => {
  const render = functionSource("renderInlineModelChoices");
  assert.match(render, /liveModelChoices\[activeProvider\] \|\| inlineModelChoices\[activeProvider\]/);
});

test("an old saved default or fallback cannot return below-floor models to the menu", () => {
  assert.deepEqual(codexModelChoices({
    cache: { models: ["gpt-5.5", "gpt-5.6-terra"] },
    configured: "gpt-5.4-mini", fallback: ["gpt-6-astra", "gpt-5.5"],
  }), ["gpt-5.6-terra"]);
  assert.deepEqual(codexModelChoices({
    cache: { models: ["gpt-5.5"] }, configured: "gpt-5.5", fallback: ["gpt-5.6-luna"],
  }), [], "no eligible model means no automatic replacement");
});

test("the final send refuses an old or ambiguous model before saving attachments or history", () => {
  const { SharedBridge } = require("./start-phone");
  const bridge = Object.create(SharedBridge.prototype);
  Object.assign(bridge, {
    model: "gpt-5.5", threadId: "old-thread", pending: new Map(),
    request() { assert.fail("an invalid model reached the app-server"); },
    appendHistory() { assert.fail("a rejected prompt entered history"); },
    emit() {}, setBridgeRunState() {},
  });
  for (const model of [undefined, "gpt-5.4-mini", "astra", "o3", "gpt-5.5-codex"]) {
    assert.throws(() => bridge.startPrompt("keep my draft", [], { model }), /GPT-5\.6/);
  }
});

test("each eligible role and supported effort reaches the real send path unchanged", () => {
  const { SharedBridge, validateCodexModel } = require("./start-phone");
  const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  const efforts = ["low", "medium", "high", "xhigh"];
  rememberCodexModels(models.map(id => ({ id, supportedReasoningEfforts: efforts })), { cachePath });
  const sent = [];
  const bridge = Object.create(SharedBridge.prototype);
  Object.assign(bridge, {
    model: "gpt-5.5", threadId: "old-thread", pending: new Map(),
    request(method, params) { sent.push({ method, params }); return sent.length; },
    appendHistory() {}, emit() {}, setBridgeRunState() {},
  });
  for (const model of models) for (const effort of efforts) {
    bridge.startPrompt("bounded verified work", [], { model, effort });
    assert.equal(sent.at(-1).params.model, model);
    assert.equal(sent.at(-1).params.effort, effort);
  }
  assert.equal(bridge.model, "gpt-5.5", "historical model metadata is not rewritten");
  assert.throws(() => validateCodexModel("gpt-7-preview"), /候補/);
  assert.throws(() => bridge.startPrompt("keep", [], { model: models[0], effort: "unsupported" }), /思考の深さ/);
  assert.equal(sent.length, 16);
});

test("old browser selections are rejected before a queued prompt is acknowledged", () => {
  const { SharedBridge } = require("./start-phone");
  const messages = [];
  const bridge = Object.create(SharedBridge.prototype);
  Object.assign(bridge, { model: "gpt-5.5", threadId: "old-thread", activeTurnId: "busy", turnQueue: [], emit(type, data) { messages.push({ type, ...data }); } });
  bridge.prompt("keep", [], {}, "draft-one");
  assert.equal(bridge.turnQueue.length, 0);
  assert.equal(messages[0].type, "error");
  assert.equal(messages[0].clientMessageId, "draft-one");
});
