// Every connect that names no thread starts one, and the bridge object then
// lives on for an hour after the phone leaves. Each of those sat in everyone's
// list as 名前未設定のチャット with no date: one per open of a Codex icon, one
// per test run. The list now leaves out a thread nobody has spoken to.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const key of Object.keys(process.env)) {
  if (/^(PHONE_|CODEX_|CLAUDE_|AGENT_)/.test(key)) delete process.env[key];
}
process.env.PHONE_UI_PORT = "45993";
process.env.PHONE_TOKEN = "test-token";

const { bridgeIsUntouched } = require("./start-phone");

test("a thread nobody has spoken to is untouched, a turn in flight is not", () => {
  assert.equal(bridgeIsUntouched({ threadId: "t1", history: [] }), true);
  assert.equal(bridgeIsUntouched({ threadId: "t1" }), true);
  assert.equal(bridgeIsUntouched({ threadId: "t1", history: [{ type: "status", text: "接続しました" }] }), true);
  assert.equal(bridgeIsUntouched({ threadId: "t1", history: [{ type: "user", text: "テスト" }] }), false);
  assert.equal(bridgeIsUntouched({ threadId: "t1", history: [], hasActiveWork: () => true }), false);
});

test("the bridge's own list leaves untouched threads out", () => {
  const server = fs.readFileSync(path.join(__dirname, "start-phone.js"), "utf8");
  const list = server.slice(server.indexOf("function localThreadList("), server.indexOf("function timestampValueMs("));
  assert.match(list, /bridge\.threadId && !bridgeIsUntouched\(bridge\)/);
});

test("a Mac renamed on the Mac is renamed on every phone at its next poll", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");
  const refresh = main.slice(main.indexOf("async function refreshBridgeState("));
  const refreshed = refresh.slice(refresh.indexOf("const refreshed = {"), refresh.indexOf("status: \"connected\""));
  assert.match(refreshed, /label: info\.label \|\| entry\.label,/, "the bridge's own name must outrank the registry's copy");
  assert.doesNotMatch(refreshed, /isPlaceholderBridgeLabel/, "the old name must not be kept just because it is not a placeholder");
});
