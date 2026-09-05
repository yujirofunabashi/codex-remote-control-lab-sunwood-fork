// Two Macs, two providers, four combinations - and for a while the phone could
// only ever show one provider at a time across both Macs. Switching to Codex on
// the mini turned the Air's chats into Codex too, and coming back turned both
// into Claude again. Nothing in the tests could see it: the rules live in
// main.js, which no test loaded. These do, by lifting the two functions that
// decide the provider straight out of the shipped file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

// The real function, with only the handful of globals it touches stubbed.
const adopt = new Function(`
  let threadProvider = "";
  let activeProvider = "";
  let threadProviderExplicit = false;
  function normalizeProviderName(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "codex" || text === "claude" ? text : "";
  }
  function currentThreadProvider() {
    return normalizeProviderName(threadProvider || activeProvider) || "codex";
  }
  function setActiveProvider(provider) {
    activeProvider = normalizeProviderName(provider) || "codex";
  }
  ${functionSource("adoptBridgeProvider")}
  return function run(state, provider, served) {
    threadProvider = state.threadProvider;
    activeProvider = state.activeProvider;
    threadProviderExplicit = state.threadProviderExplicit;
    adoptBridgeProvider(provider, served);
    return { threadProvider, activeProvider, threadProviderExplicit };
  };
`)();

const bothProviders = ["codex", "claude"];

test("a chat switched to Codex is not dragged back by the bridge's startup provider", () => {
  // Both Macs start as Claude bridges. Choosing Codex on one of them has to
  // outlive every /api/info answer that follows, or switching Macs and back
  // silently undoes the choice.
  const after = adopt({ threadProvider: "codex", activeProvider: "codex", threadProviderExplicit: true }, "claude", bothProviders);
  assert.equal(after.threadProvider, "codex");
  assert.equal(after.activeProvider, "codex");
  assert.equal(after.threadProviderExplicit, true);
});

test("a Mac with no choice of its own follows the provider that bridge started with", () => {
  const after = adopt({ threadProvider: "", activeProvider: "codex", threadProviderExplicit: false }, "claude", bothProviders);
  assert.equal(after.activeProvider, "claude");
  assert.equal(after.threadProviderExplicit, false);
});

test("a bridge that serves only one provider still overrides a choice it cannot run", () => {
  // The rule that made the bridge authoritative was fixing a real failure: a
  // stored provider the bridge could not serve left the connection unable to
  // settle. An older bridge that lists one provider keeps that protection.
  const after = adopt({ threadProvider: "codex", activeProvider: "codex", threadProviderExplicit: true }, "claude", ["claude"]);
  assert.equal(after.threadProvider, "claude");
  assert.equal(after.activeProvider, "claude");
  assert.equal(after.threadProviderExplicit, false);
});

test("an answer that names no provider changes nothing", () => {
  const after = adopt({ threadProvider: "claude", activeProvider: "claude", threadProviderExplicit: true }, "", bothProviders);
  assert.equal(after.threadProvider, "claude");
  assert.equal(after.activeProvider, "claude");
});

test("the icon's provider seeds only the Mac that icon opens", () => {
  // Read from the source: the launch parameter is applied through the bridge it
  // was launched with, never straight into a switch to another Mac.
  const applySource = functionSource("applyActiveBridgeState");
  assert.match(applySource, /bridgeId === launchProviderBridgeId \? initialProviderParam : ""/);
  const strayUse = applySource.replace(/bridgeId === launchProviderBridgeId \? initialProviderParam : ""/g, "");
  assert.doesNotMatch(strayUse, /initialProviderParam/, "the launch provider must not be applied to every bridge switch");
  assert.match(mainSource, /const launchProviderBridgeId = initialProviderParam \? activeBridgeId : "";/);
});

test("a Mac's remembered provider outranks the provider its bridge started with", () => {
  const applySource = functionSource("applyActiveBridgeState");
  const activeLine = /activeProvider = normalizeProviderName\(([^)]*)\)/.exec(applySource)?.[1] || "";
  assert.ok(activeLine.includes("view.provider"), "the remembered per-Mac provider is not consulted");
  assert.ok(
    activeLine.indexOf("view.provider") < activeLine.indexOf("state.info?.provider"),
    "the bridge's startup provider must not outrank the choice remembered for that Mac",
  );
});

// Once each Mac could be left in its own provider, the sidebar mixed them: the
// Air's Claude chats sat on top of the mini's Codex list, and the Codex chats
// read as missing. The list now follows the provider the phone is in, on every
// Mac, and a row opened from it puts the phone in that row's provider.
const fleetRecords = new Function(`
  let activeBridgeId = "mini";
  let threadCache = [];
  let currentProvider = "codex";
  const bridgeRegistry = { bridges: [{ id: "mini" }, { id: "air" }] };
  const states = { mini: { threadCache: [] }, air: { threadCache: [] } };
  function getBridgeState(id) { return states[id]; }
  function shortMachineName(entry) { return entry.id; }
  function bridgeMachineKey(entry) { return entry.id; }
  function normalizeProviderName(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "codex" || text === "claude" ? text : "";
  }
  function currentThreadProvider() { return currentProvider; }
  ${functionSource("fleetThreadRecords")}
  return function run({ provider, active, other }) {
    currentProvider = provider;
    threadCache = active;
    states.air.threadCache = other;
    return fleetThreadRecords().map((thread) => thread.machineKey + ":" + thread.provider + ":" + thread.id);
  };
`)();

test("the sidebar shows one provider across every Mac, the one the phone is in", () => {
  const active = [
    { id: "c1", provider: "codex" },
    { id: "k1", provider: "claude" },
  ];
  const other = [
    { id: "k2", provider: "claude" },
    { id: "c2", provider: "codex" },
    { id: "u1" }, // no provider on the record: taken as the list's own
  ];
  assert.deepEqual(fleetRecords({ provider: "codex", active, other }), ["mini:codex:c1", "air:codex:c2", "air:undefined:u1"]);
  assert.deepEqual(fleetRecords({ provider: "claude", active, other }), ["mini:claude:k1", "air:claude:k2", "air:undefined:u1"]);
});

test("asking the other Mac for chats does not rewrite the provider that Mac was left in", () => {
  const source = functionSource("loadFleetThreads");
  assert.doesNotMatch(source, /state\.activeProvider\s*=/, "the fleet refresh must not overwrite a Mac's remembered provider");
  assert.match(source, /currentThreadProvider\(\)/, "the other Mac is asked for the provider the phone is in");
});

const useProvider = new Function(`
  let threadProvider = "claude";
  let activeProvider = "claude";
  let threadProviderExplicit = false;
  let selectedThread = "k1";
  const selectedThreadByProvider = new Map();
  function normalizeProviderName(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "codex" || text === "claude" ? text : "";
  }
  function currentThreadProvider() { return normalizeProviderName(threadProvider || activeProvider) || "codex"; }
  function setActiveProvider(provider) { activeProvider = normalizeProviderName(provider) || "codex"; }
  ${functionSource("useThreadProvider")}
  return function run(provider) {
    const changed = useThreadProvider(provider);
    return { changed, threadProvider, activeProvider, threadProviderExplicit, remembered: Object.fromEntries(selectedThreadByProvider) };
  };
`)();

test("opening a row puts the phone in that row's provider, and remembers where it was", () => {
  let result = useProvider("codex");
  assert.equal(result.changed, true);
  assert.equal(result.threadProvider, "codex");
  assert.equal(result.activeProvider, "codex");
  assert.equal(result.threadProviderExplicit, true);
  assert.deepEqual(result.remembered, { claude: "k1" });
  // Same provider, or no provider on the row: nothing to change.
  result = useProvider("codex");
  assert.equal(result.changed, false);
  result = useProvider("");
  assert.equal(result.changed, false);
  assert.match(functionSource("selectThread"), /useThreadProvider\(options\.thread\?\.provider\)/);
});

// The list follows one provider, and nothing in the drawer said which: a Codex
// list and a Claude list of the same Mac read as the same screen. The switch
// at the top of the list is where that is chosen and seen.
test("the drawer has a switch for which provider the list shows, and it marks the current one", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(indexSource, /data-thread-provider="claude"/);
  assert.match(indexSource, /data-thread-provider="codex"/);
  assert.match(mainSource, /switchThreadProvider\(provider\)/, "tapping the switch changes the provider the same way the settings sheet does");
  const render = new Function(`
    let currentProvider = "codex";
    const buttons = ["claude", "codex"].map((name) => ({
      dataset: { threadProvider: name },
      active: false,
      selected: "",
      classList: { toggle(cls, on) { if (cls === "active") this.owner.active = on; } },
      setAttribute(name, value) { if (name === "aria-selected") this.selected = value; },
    }));
    for (const button of buttons) button.classList.owner = button;
    const threadProviderTabButtons = buttons;
    function normalizeProviderName(value) {
      const text = String(value || "").trim().toLowerCase();
      return text === "codex" || text === "claude" ? text : "";
    }
    function currentThreadProvider() { return currentProvider; }
    ${functionSource("renderThreadProviderTabs")}
    return function run(provider) {
      currentProvider = provider;
      renderThreadProviderTabs();
      return Object.fromEntries(buttons.map((b) => [b.dataset.threadProvider, b.active + "/" + b.selected]));
    };
  `)();
  assert.deepEqual(render("codex"), { claude: "false/false", codex: "true/true" });
  assert.deepEqual(render("claude"), { claude: "true/true", codex: "false/false" });
});
