const test = require("node:test");
const assert = require("node:assert/strict");

const { settingEnvKeysForSlot, slotEnvKey, slotSettingValue } = require("./phone-slot-settings");

test("slotEnvKey scopes a base environment key to a phone UI port", () => {
  assert.equal(slotEnvKey("PHONE_WORKDIR", 45224), "PHONE_WORKDIR_45224");
});

test("slotSettingValue prefers a port-scoped value over a shared env value", () => {
  const env = {
    PHONE_WORKDIR: "/Users/minijiro/shared",
    PHONE_WORKDIR_45224: "/Users/minijiro/slot-45224",
  };

  assert.equal(slotSettingValue(env, "PHONE_WORKDIR", 45224), "/Users/minijiro/slot-45224");
});

test("slotSettingValue keeps explicit launch env ahead of port-scoped saved settings", () => {
  const env = {
    PHONE_WORKDIR: "/Users/minijiro/launch",
    PHONE_WORKDIR_45224: "/Users/minijiro/saved-slot",
  };

  assert.equal(
    slotSettingValue(env, "PHONE_WORKDIR", 45224, {
      launchEnvKeys: new Set(["PHONE_WORKDIR"]),
    }),
    "/Users/minijiro/launch",
  );
});

test("slotSettingValue supports provider-specific fallback keys per port", () => {
  const env = {
    CODEX_MODEL: "gpt-global",
    CODEX_MODEL_45224: "gpt-slot",
  };

  assert.equal(slotSettingValue(env, "PHONE_MODEL", 45224, { fallbackKeys: ["CODEX_MODEL"] }), "gpt-slot");
});

test("settingEnvKeysForSlot includes shared and port-scoped keys for pin detection", () => {
  assert.deepEqual(settingEnvKeysForSlot("PHONE_WORKDIR", 45224, ["CODEX_WORKDIR"]), [
    "PHONE_WORKDIR",
    "CODEX_WORKDIR",
    "PHONE_WORKDIR_45224",
    "CODEX_WORKDIR_45224",
  ]);
});
