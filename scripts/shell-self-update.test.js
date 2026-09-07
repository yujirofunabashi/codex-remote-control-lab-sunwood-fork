// A Home Screen app reopened from the switcher keeps the page it had, so every
// fix that shipped today reached the phone only if the owner killed the app by
// hand - and the sidebar kept showing the mixed list a fix had already removed.
// The bridge now names the build it serves, and the page reloads itself when it
// is running another one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { shellUpdateDecision, shellVersionOf } = require("../public/phone-ui-utils");

const served = "main.js?v=msjz1abc-claude-45234";
const running = "https://mini.example:8444/main.js?v=msjq9xyz-claude-45234";

test("the build is read from the versioned script address, wherever it points", () => {
  assert.equal(shellVersionOf(served), "msjz1abc-claude-45234");
  assert.equal(shellVersionOf(running), "msjq9xyz-claude-45234");
  assert.equal(shellVersionOf("main.js"), "");
  assert.equal(shellVersionOf(""), "");
});

test("a page running another build than the one served reloads, once, when idle", () => {
  assert.equal(shellUpdateDecision({ servedMain: served, ownMain: running }), "reload");
  // Mid-turn, mid-draft or in the background it waits for the next poll.
  assert.equal(shellUpdateDecision({ servedMain: served, ownMain: running, busy: true }), "wait");
  // Already reloaded for this build and still on the old one: do not loop.
  assert.equal(shellUpdateDecision({ servedMain: served, ownMain: running, lastReloadFor: "msjz1abc-claude-45234" }), "skip");
});

test("the same build, or no build named, changes nothing", () => {
  assert.equal(shellUpdateDecision({ servedMain: served, ownMain: `https://x/main.js?v=${shellVersionOf(served)}` }), "same");
  assert.equal(shellUpdateDecision({ servedMain: "", ownMain: running }), "same");
  assert.equal(shellUpdateDecision({ servedMain: served, ownMain: "" }), "same");
});

test("the page checks the build on every poll of the bridge it was loaded from", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");
  const refresh = main.slice(main.indexOf("async function refreshBridgeState("));
  assert.match(refresh.slice(0, 3000), /checkShellFreshness\(info, entry\)/);
  const check = main.slice(main.indexOf("function checkShellFreshness("), main.indexOf("async function refreshBridgeState("));
  assert.match(check, /entry\.id !== homeBridgeId/, "only the bridge that served this page can say which build it is");
  assert.match(check, /location\.reload\(\)/);
  const server = fs.readFileSync(path.join(__dirname, "start-phone.js"), "utf8");
  assert.match(server, /shell: \{ main: staticAssetHref\("main\.js"\)/, "the bridge names the build it serves");
});

test("a draft or upload started during the reload notice is preserved and retried when idle", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");
  const source = main.slice(main.indexOf("const shellReloadStorageKey ="), main.indexOf("async function refreshBridgeState("));
  const tasks = [], saved = [];
  let reloads = 0;
  const context = vm.createContext({
    uiUtils: { shellUpdateDecision, shellVersionOf }, homeBridgeId: "home",
    liveTurnActive: false, threadSwitchBusy: false, pendingFiles: [], addButton: { disabled: false },
    promptModal: { classList: { contains: () => true } }, promptInput: { value: "" },
    document: { visibilityState: "visible", querySelector: () => ({ getAttribute: () => running }) },
    sessionStorage: {}, safeReadStorage: () => saved.at(-1) || "", safeWriteStorage: (_storage, _key, value) => saved.push(value),
    showToast() {}, location: { reload: () => { reloads++; } },
    window: { setTimeout: callback => { tasks.push(callback); return tasks.length; } },
  });
  vm.runInContext(source, context);
  const poll = () => context.checkShellFreshness({ shell: { main: served } }, { id: "home" });
  poll();
  poll();
  assert.equal(tasks.length, 1, "one pending notice, not many reloads");
  context.promptInput.value = "unfinished text";
  tasks.shift()();
  assert.equal(reloads, 0);
  assert.equal(saved.length, 0);
  context.promptInput.value = "";
  context.pendingFiles.push({ path: "fixture.png" });
  poll();
  assert.equal(tasks.length, 0);
  context.pendingFiles.length = 0;
  context.addButton.disabled = true;
  poll();
  assert.equal(tasks.length, 0, "an upload is still busy before the attachment arrives");
  context.addButton.disabled = false;
  poll();
  tasks.shift()();
  assert.equal(reloads, 1);
  poll();
  assert.equal(tasks.length, 0, "a served build is reloaded only once");
});
