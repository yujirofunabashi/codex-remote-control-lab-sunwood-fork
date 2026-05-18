const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultCodexAppServerPort, settingEnvKeysForSlot, slotEnvKey, slotSettingValue } = require("./phone-slot-settings");

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

test("slotSettingValue keeps port-scoped settings ahead of shared launch env", () => {
  const env = {
    PHONE_WORKDIR: "/Users/minijiro/shared-launch",
    PHONE_WORKDIR_45224: "/Users/minijiro/slot",
  };

  assert.equal(
    slotSettingValue(env, "PHONE_WORKDIR", 45224, {
      launchEnvKeys: new Set(["PHONE_WORKDIR"]),
    }),
    "/Users/minijiro/slot",
  );
});

test("slotSettingValue uses shared launch env when there is no port-scoped value", () => {
  const env = {
    PHONE_WORKDIR: "/Users/minijiro/shared-launch",
  };

  assert.equal(
    slotSettingValue(env, "PHONE_WORKDIR", 45224, {
      launchEnvKeys: new Set(["PHONE_WORKDIR"]),
    }),
    "/Users/minijiro/shared-launch",
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

test("defaultCodexAppServerPort pairs each phone UI slot with its own upstream port", () => {
  assert.equal(defaultCodexAppServerPort(45214), 45213);
  assert.equal(defaultCodexAppServerPort(45224), 45223);
  assert.equal(defaultCodexAppServerPort(45244), 45243);
});

test("defaultCodexAppServerPort falls back when the paired port would be invalid", () => {
  assert.equal(defaultCodexAppServerPort(1024), 45213);
  assert.equal(defaultCodexAppServerPort("not-a-port"), 45213);
});
