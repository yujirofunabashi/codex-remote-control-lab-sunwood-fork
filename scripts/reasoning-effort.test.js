// The depth menu used to be decoration on the Codex side: the phone offered a
// fixed four steps, sent nothing, and the turn ran at whatever
// `model_reasoning_effort` in the Codex config said. These cover the two halves
// of the fix -- the level reaching `turn/start`, and the menu naming the levels
// the selected model actually has.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

const APP_SERVER_PORT = 45996;
const recorded = [];
const wss = new WebSocketServer({ port: APP_SERVER_PORT });
wss.on("connection", (sock) => {
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    recorded.push(msg);
    if (msg.method === "initialize") sock.send(JSON.stringify({ id: msg.id, result: {} }));
    if (msg.method === "thread/start") sock.send(JSON.stringify({ id: msg.id, result: { thread: { id: "test-thread" } } }));
    if (msg.method === "turn/start") sock.send(JSON.stringify({ id: msg.id, result: { turn: { id: "test-turn" } } }));
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-effort-"));
process.env.CODEX_APP_SERVER_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`;
process.env.PHONE_UI_PORT = "45996";
process.env.PHONE_TOKEN = "test-token";
process.env.PHONE_WORKDIR = tmp;
process.env.PHONE_CODEX_MODELS_CACHE_PATH = path.join(tmp, "models.json");
// Set before the module loads its `.env`, which only fills in what is unset.
// Disposing a bridge counts as a lost connection, and a test must not put that
// on the owner's phone.
process.env.PHONE_NOTIFY_EVENTS = "0";
process.env.PHONE_DISCORD_WEBHOOK_URL = "";

const {
  SharedBridge,
  codexEffortLevel,
  codexEffortsFromList,
  codexReasoningChoices,
  reasoningChoicePayload,
  rememberCodexModels,
} = require("./start-phone");

test.after(() => {
  wss.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Shaped like a real `model/list` answer: the levels differ per model, which is
// the whole reason a fixed menu was wrong.
const liveAnswer = [
  {
    id: "gpt-6-astra",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
      { reasoningEffort: "ultra" },
    ],
  },
  { id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
  { id: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];

test("the levels come from the model's own list, and a hidden model is left out", () => {
  const efforts = codexEffortsFromList(liveAnswer);
  assert.deepEqual(efforts["gpt-6-astra"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(efforts["gpt-5.6-luna"], ["low", "medium", "high", "xhigh"]);
  assert.ok(!("hidden-model" in efforts), "a hidden model is not offered");
});

test("a model with no list of its own falls back rather than inventing levels", () => {
  const cache = { models: [], efforts: codexEffortsFromList(liveAnswer) };
  assert.deepEqual(codexReasoningChoices({ cache, model: "gpt-6-astra" }), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(codexReasoningChoices({ cache, model: "some-unreleased-model" }), ["low", "medium", "high", "xhigh"]);
});

test("a level is only forwarded when the model is known to take it", () => {
  const cache = { models: [], efforts: codexEffortsFromList(liveAnswer) };
  assert.equal(codexEffortLevel({ effort: "ultra" }, "gpt-6-astra", { cache }), "ultra");
  // Luna stops at xhigh: forwarding `ultra` would be ignored upstream and leave
  // the turn on the config default, which is the failure being fixed.
  assert.equal(codexEffortLevel({ effort: "ultra" }, "gpt-5.6-luna", { cache }), "");
  assert.equal(codexEffortLevel({ effort: "MAX" }, "gpt-6-astra", { cache }), "max");
  assert.equal(codexEffortLevel({ effort: "bogus" }, "gpt-6-astra", { cache }), "");
  assert.equal(codexEffortLevel({}, "gpt-6-astra", { cache }), "");
});

test("a model the account has not described yet still forwards a real level", () => {
  // Dropping a correct level because the list has not been fetched would be the
  // same silent miss in the other direction.
  const cache = { models: [], efforts: {} };
  assert.equal(codexEffortLevel({ effort: "max" }, "gpt-7-preview", { cache }), "max");
  assert.equal(codexEffortLevel({ effort: "nonsense" }, "gpt-7-preview", { cache }), "");
});

test("the phone is told the levels per model and a fallback per provider", () => {
  const payload = reasoningChoicePayload({ cache: { models: [], efforts: codexEffortsFromList(liveAnswer) } });
  assert.deepEqual(payload.byModel["gpt-6-astra"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(payload.codex, ["low", "medium", "high", "xhigh"]);
  // Claude's own documented set, which reaches `max` but has no `ultra`.
  assert.deepEqual(payload.claude, ["low", "medium", "high", "xhigh", "max"]);
});

test("the cache keeps the levels beside the model ids", () => {
  const cachePath = path.join(tmp, "remember.json");
  rememberCodexModels(liveAnswer, { cachePath });
  const onDisk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.deepEqual(onDisk.models, ["gpt-6-astra", "gpt-5.6-luna"]);
  assert.deepEqual(onDisk.efforts["gpt-6-astra"], ["low", "medium", "high", "xhigh", "max", "ultra"]);
});

function fakeClient() {
  return { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); }, on() {} };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function turnStartParams(options) {
  recorded.length = 0;
  const bridge = new SharedBridge(null, `effort-${Math.random()}`);
  bridge.clients.add(fakeClient());
  for (let i = 0; i < 200 && !bridge.ready; i += 1) await sleep(20);
  assert.ok(bridge.ready, "the bridge never finished starting a thread");
  bridge.prompt("hi", [], { approvalPolicy: "never", sandboxMode: "danger-full-access", ...options });
  for (let i = 0; i < 200 && !recorded.some((msg) => msg.method === "turn/start"); i += 1) await sleep(20);
  const turn = recorded.find((msg) => msg.method === "turn/start");
  bridge.dispose();
  assert.ok(turn, "no turn/start was sent");
  return turn.params;
}

test("a chosen level reaches the app-server on turn/start", async () => {
  const params = await turnStartParams({ model: "gpt-6-astra", effort: "ultra" });
  assert.equal(params.model, "gpt-6-astra");
  assert.equal(params.effort, "ultra");
});

test("no level means no override, leaving the thread on the Codex config", async () => {
  const params = await turnStartParams({ model: "gpt-6-astra" });
  assert.ok(!Object.prototype.hasOwnProperty.call(params, "effort"));
});

const mainSource = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");

// Reads a declaration out of the page verbatim, so these run the shipped code
// rather than a copy of it.
function declarationSource(keyword, name) {
  const start = mainSource.indexOf(`${keyword} ${name}`);
  assert.notEqual(start, -1, `${name} is no longer declared the way this test finds it`);
  let depth = 0;
  for (let i = start; i < mainSource.length; i += 1) {
    const char = mainSource[i];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth === 0) return mainSource.slice(start, i + 1);
    else if (char === "\n" && depth === 0 && keyword === "function" && mainSource[i - 1] === "}") return mainSource.slice(start, i);
  }
  throw new Error(`could not read ${name}`);
}

function pageScope() {
  const source = [
    declarationSource("const", "reasoningAliases"),
    declarationSource("const", "reasoningDepthOrder"),
    declarationSource("const", "reasoningDisplayLabels"),
    declarationSource("function", "normalizeReasoning"),
    declarationSource("function", "nearestSupportedReasoning"),
    declarationSource("function", "reasoningDisplayLabel"),
    "return { normalizeReasoning, nearestSupportedReasoning, reasoningDisplayLabel };",
  ].join("\n");
  return new Function(source)();
}

test("every level a provider can name has a label, in the case it is stored in", () => {
  const { reasoningDisplayLabel } = pageScope();
  // The labels are keyed by the provider's own lowercase name. Looking them up
  // in another case fell through to the bare English word.
  for (const [level, label] of [["low", "軽め"], ["medium", "標準"], ["high", "深め"], ["xhigh", "かなり深め"], ["max", "最大"]]) {
    assert.equal(reasoningDisplayLabel(level), label);
  }
  // "最大" is only ever a level that is really a maximum.
  assert.equal(reasoningDisplayLabel("xhigh"), "かなり深め");
  assert.equal(reasoningDisplayLabel("ultra"), "最大＋自動分担");
});

test("a level stored under the old four-step code still opens on the right one", () => {
  const { normalizeReasoning } = pageScope();
  // What a phone that has been used before has in storage.
  assert.equal(normalizeReasoning("XH"), "xhigh");
  assert.equal(normalizeReasoning("M"), "medium");
  // And the names now stored.
  assert.equal(normalizeReasoning("ultra"), "ultra");
  assert.equal(normalizeReasoning("max"), "max");
  assert.equal(normalizeReasoning("nonsense"), "medium");
});

test("switching to a shallower model settles on the deepest level it has", () => {
  const { nearestSupportedReasoning } = pageScope();
  const luna = ["low", "medium", "high", "xhigh"];
  // Chosen ultra on Astra, then switched to Luna: the menu must not keep
  // claiming a depth the turn cannot run at.
  assert.equal(nearestSupportedReasoning("ultra", luna), "xhigh");
  assert.equal(nearestSupportedReasoning("high", luna), "high");
  assert.equal(nearestSupportedReasoning("low", ["medium", "high"]), "medium");
});
