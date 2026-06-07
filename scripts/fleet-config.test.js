const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { bridgeEnvForEntry, latestBridgeConfig, normalizeFleetConfig, shouldRespawnBridgeExit } = require("./start-fleet");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".tmp-fleet-config-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("fleet config normalizes bridge ports and workdir", () => {
  const config = normalizeFleetConfig({
    bridges: [
      {
        id: "work-a",
        label: "Work A",
        workdir: "/tmp/work-a",
        phonePort: 45214,
        appServerPort: 45213,
        provider: "codex",
        model: "gpt-5.5",
        color: "#2f6f2f",
      },
    ],
  });

  assert.equal(config.bridges[0].id, "work-a");
  assert.equal(config.bridges[0].phonePort, 45214);
  assert.equal(config.bridges[0].appServerPort, 45213);
  assert.equal(config.bridges[0].provider, "codex");
});

test("fleet config defaults each app-server port from its phone slot", () => {
  const config = normalizeFleetConfig({
    bridges: [{ id: "work-b", workdir: "/tmp/work-b", phonePort: 45224 }],
  });

  assert.equal(config.bridges[0].phonePort, 45224);
  assert.equal(config.bridges[0].appServerPort, 45223);
});

test("fleet config can attach a bridge to an existing app-server URL", () => {
  const config = normalizeFleetConfig({
    bridges: [
      {
        id: "windows-codex",
        workdir: "/tmp/work-c",
        phonePort: 45244,
        appServerUrl: "ws://127.0.0.1:45243",
        appServerCwd: "C:\\Users\\admin\\workspace",
      },
    ],
  });

  assert.equal(config.bridges[0].phonePort, 45244);
  assert.equal(config.bridges[0].appServerPort, null);
  assert.equal(config.bridges[0].appServerUrl, "ws://127.0.0.1:45243/");
  assert.equal(config.bridges[0].appServerCwd, "C:\\Users\\admin\\workspace");
});

test("fleet config rejects unsupported app-server URL protocols", () => {
  assert.throws(
    () =>
      normalizeFleetConfig({
        bridges: [{ id: "work-c", workdir: "/tmp/work-c", phonePort: 45244, appServerUrl: "http://127.0.0.1:45243" }],
      }),
    /appServerUrl must use ws:\/\/ or wss:\/\//,
  );
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

test("fleet config rejects unsupported providers", () => {
  assert.throws(
    () =>
      normalizeFleetConfig({
        bridges: [{ id: "work-c", workdir: "/tmp/work-c", phonePort: 45234, provider: "gemini" }],
      }),
    /provider must be codex/,
  );
});

test("bridgeEnvForEntry passes only scoped bridge settings", () => {
  const env = bridgeEnvForEntry(
    {
      id: "work-a",
      label: "Work A",
      group: "client",
      provider: "codex",
      workdir: "/tmp/work-a",
      phonePort: 45214,
      appServerPort: 45213,
      model: "gpt-5.5",
      color: "#2f6f2f",
    },
    { PATH: "/bin" },
    { configPath: "/tmp/fleet.json" },
  );

  assert.equal(env.PHONE_UI_PORT, "45214");
  assert.equal(env.CODEX_APP_SERVER_PORT, "45213");
  assert.equal(env.PHONE_BRIDGE_ID, "work-a");
  assert.equal(env.PHONE_FLEET_CONFIG_PATH, "/tmp/fleet.json");
  assert.equal(env.PHONE_FLEET_BRIDGE_ID, "work-a");
  assert.equal(env.PHONE_AGENT_PROVIDER, "codex");
  assert.equal(env.PHONE_AGENT_PROVIDER_45214, "codex");
  assert.equal(env.PHONE_WORKDIR, "/tmp/work-a");
  assert.equal(env.PHONE_WORKDIR_45214, "/tmp/work-a");
  assert.equal(env.CODEX_WORKDIR_45214, "/tmp/work-a");
  assert.equal(env.CODEX_MODEL, "gpt-5.5");
  assert.equal(env.CODEX_MODEL_45214, "gpt-5.5");
  assert.equal(env.PHONE_TOKEN, undefined);
});

test("bridgeEnvForEntry passes app-server URL without a managed app-server port", () => {
  const env = bridgeEnvForEntry(
    {
      id: "windows-codex",
      label: "Windows Codex",
      group: "remote",
      provider: "codex",
      workdir: "/tmp/windows-codex",
      phonePort: 45244,
      appServerPort: null,
      appServerUrl: "ws://127.0.0.1:45243/",
      appServerCwd: "C:\\Users\\admin\\workspace",
      model: "gpt-5.5",
      color: "",
    },
    { PATH: "/bin", CODEX_APP_SERVER_SOCK: "/tmp/old.sock" },
  );

  assert.equal(env.PHONE_UI_PORT, "45244");
  assert.equal(env.CODEX_APP_SERVER_URL, "ws://127.0.0.1:45243/");
  assert.equal(env.CODEX_APP_SERVER_SOCK, "");
  assert.equal(env.CODEX_APP_SERVER_PORT, undefined);
  assert.equal(env.CODEX_APP_SERVER_CWD, "C:\\Users\\admin\\workspace");
});

test("fleet restart reloads the latest bridge config", () => {
  withTempDir((dir) => {
    const configPath = path.join(dir, "fleet.json");
    const oldWorkdir = path.join(dir, "old-workdir");
    const newWorkdir = path.join(dir, "new-workdir");
    fs.mkdirSync(oldWorkdir);
    fs.mkdirSync(newWorkdir);
    const previous = normalizeFleetConfig({
      bridges: [{ id: "slot-b", phonePort: 45224, appServerPort: 45223, workdir: oldWorkdir, model: "gpt-5.4" }],
    }).bridges[0];

    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        bridges: [{ id: "slot-b", phonePort: 45224, appServerPort: 45223, workdir: newWorkdir, model: "gpt-5.5" }],
      })}\n`,
    );

    const latest = latestBridgeConfig(configPath, previous);

    assert.equal(latest.workdir, newWorkdir);
    assert.equal(latest.model, "gpt-5.5");
  });
});

test("fleet respawns a bridge after an in-app restart request", () => {
  assert.equal(shouldRespawnBridgeExit(42, null, false), true);
  assert.equal(shouldRespawnBridgeExit(42, "SIGTERM", false), false);
  assert.equal(shouldRespawnBridgeExit(1, null, false), false);
  assert.equal(shouldRespawnBridgeExit(42, null, true), false);
});
