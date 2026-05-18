const test = require("node:test");
const assert = require("node:assert/strict");

const { bridgeEnvForEntry, normalizeFleetConfig } = require("./start-fleet");

test("fleet config normalizes bridge ports and workdir", () => {
  const config = normalizeFleetConfig({
    bridges: [
      {
        id: "work-a",
        label: "Work A",
        workdir: "/tmp/work-a",
        phonePort: 45214,
        appServerPort: 45213,
        model: "gpt-5.5",
        color: "#2f6f2f",
      },
    ],
  });

  assert.equal(config.bridges[0].id, "work-a");
  assert.equal(config.bridges[0].phonePort, 45214);
  assert.equal(config.bridges[0].appServerPort, 45213);
});

test("fleet config defaults each app-server port from its phone slot", () => {
  const config = normalizeFleetConfig({
    bridges: [{ id: "work-b", workdir: "/tmp/work-b", phonePort: 45224 }],
  });

  assert.equal(config.bridges[0].phonePort, 45224);
  assert.equal(config.bridges[0].appServerPort, 45223);
});

test("fleet config rejects duplicate ports", () => {
  assert.throws(
    () =>
      normalizeFleetConfig({
        bridges: [
          { id: "a", workdir: "/tmp/a", phonePort: 45214, appServerPort: 45213 },
          { id: "b", workdir: "/tmp/b", phonePort: 45214, appServerPort: 45223 },
        ],
      }),
    /duplicate port/,
  );
});

test("bridgeEnvForEntry passes only scoped bridge settings", () => {
  const env = bridgeEnvForEntry(
    {
      id: "work-a",
      label: "Work A",
      group: "client",
      workdir: "/tmp/work-a",
      phonePort: 45214,
      appServerPort: 45213,
      model: "gpt-5.5",
      color: "#2f6f2f",
    },
    { PATH: "/bin" },
  );

  assert.equal(env.PHONE_UI_PORT, "45214");
  assert.equal(env.CODEX_APP_SERVER_PORT, "45213");
  assert.equal(env.PHONE_BRIDGE_ID, "work-a");
  assert.equal(env.PHONE_WORKDIR, "/tmp/work-a");
  assert.equal(env.CODEX_MODEL, "gpt-5.5");
  assert.equal(env.PHONE_TOKEN, undefined);
});
