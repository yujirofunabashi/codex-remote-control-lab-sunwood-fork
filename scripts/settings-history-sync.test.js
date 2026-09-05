// Turning Codex history sync on in .env, then opening the settings sheet on a
// Claude bridge and saving, used to write the setting straight back off: the
// payload reported the stored value as false whenever the sheet was showing
// Claude, so the checkbox drew unchecked and saving persisted that. A setting
// the owner had just turned on came back off after one save.
const test = require("node:test");
const assert = require("node:assert/strict");

const port = 45991;
// These tests can run from a shell the bridge itself started, which carries the
// bridge's own PHONE_* and CODEX_* values. Anything left in the launch
// environment counts as pinned and makes the sheet describe the running bridge
// instead of what is stored - a different path from the one under test.
for (const key of Object.keys(process.env)) {
  if (/^(PHONE_|CODEX_|CLAUDE_|AGENT_)/.test(key)) delete process.env[key];
}
process.env.PHONE_UI_PORT = String(port);
process.env.PHONE_TOKEN = "test-token";

const { localSettingsPayload } = require("./start-phone");

test("a Claude bridge reports the Codex history sync value that is actually stored", () => {
  const on = localSettingsPayload({
    envValues: { [`PHONE_AGENT_PROVIDER_${port}`]: "claude", [`CODEX_HISTORY_SYNC_${port}`]: "1" },
  });
  assert.equal(on.settings.provider, "claude");
  assert.equal(on.settings.historySyncEnabled, true, "the sheet would draw the box unchecked and save it back off");

  const off = localSettingsPayload({
    envValues: { [`PHONE_AGENT_PROVIDER_${port}`]: "claude", [`CODEX_HISTORY_SYNC_${port}`]: "0" },
  });
  assert.equal(off.settings.historySyncEnabled, false);
});

test("a Codex bridge reads the same stored value", () => {
  const on = localSettingsPayload({
    envValues: { [`PHONE_AGENT_PROVIDER_${port}`]: "codex", [`CODEX_HISTORY_SYNC_${port}`]: "1" },
  });
  assert.equal(on.settings.provider, "codex");
  assert.equal(on.settings.historySyncEnabled, true);
});

test("the whole-bridge key still applies when the slot has no key of its own", () => {
  const on = localSettingsPayload({ envValues: { [`PHONE_AGENT_PROVIDER_${port}`]: "claude", CODEX_HISTORY_SYNC: "1" } });
  assert.equal(on.settings.historySyncEnabled, true);
});
