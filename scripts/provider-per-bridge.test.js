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
  let depth = 0;
  for (let i = mainSource.indexOf("{", start); i < mainSource.length; i += 1) {
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
