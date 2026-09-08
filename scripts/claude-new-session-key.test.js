// A Claude new chat has no session id until its first turn finishes, so the
// bridge hands the phone a provisional `claude:<uuid>` in `ready` and the phone
// stores it as the selected thread. The bridge must keep that id so a reconnect
// carrying it resolves back to the same bridge instead of an empty second one.
const test = require("node:test");
const assert = require("node:assert/strict");

for (const key of Object.keys(process.env)) {
  if (/^(PHONE_|CODEX_|CLAUDE_|AGENT_)/.test(key)) delete process.env[key];
}
process.env.PHONE_UI_PORT = "45996";
process.env.PHONE_TOKEN = "test-token";
process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
// Loading start-phone may read local settings; block outbound fetches too.
globalThis.fetch = async () => ({ ok: true, status: 204, text: async () => "" });

const { ClaudeBridge } = require("./start-phone");

test("a fresh Claude bridge keeps its provisional id for reconnect", () => {
  const bridge = new ClaudeBridge(null, "new:conn", {});
  assert.match(bridge.threadId, /^claude:/);
  assert.equal(bridge.provisionalThreadId, bridge.threadId);
  assert.equal(bridge.claudeSessionId, null);
});

test("a resumed Claude bridge carries no provisional id", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const bridge = new ClaudeBridge(sessionId, "k", {});
  assert.equal(bridge.provisionalThreadId, "");
  assert.equal(bridge.claudeSessionId, sessionId);
  assert.equal(bridge.threadId, sessionId);
});
