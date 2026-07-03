const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { launchSettingsFromFleetOrEnv, readFleetConfigBridgeSettings, updateFleetConfigBridgeSettings } = require("./start-phone");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".tmp-fleet-settings-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("fleet settings update persists the current port entry", () => {
  withTempDir((dir) => {
    const workdir = path.join(dir, "workspace");
    fs.mkdirSync(workdir);
    const configPath = path.join(dir, "fleet.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          bridges: [
            { id: "slot-a", phonePort: 45214, workdir: path.join(dir, "old-a"), provider: "codex", model: "gpt-5.4" },
            { id: "slot-b", phonePort: 45224, workdir: path.join(dir, "old-b"), provider: "codex", model: "gpt-5.4" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = updateFleetConfigBridgeSettings(configPath, {
      port: 45224,
      provider: "codex",
      model: "gpt-5.5",
      workdir,
      appServerCwd: "C:\\Users\\USER\\workspace",
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.equal(result.updated, true);
    assert.equal(config.bridges[0].workdir, path.join(dir, "old-a"));
    assert.equal(config.bridges[1].provider, "codex");
    assert.equal(config.bridges[1].model, "gpt-5.5");
    assert.equal(config.bridges[1].workdir, workdir);
    assert.equal(config.bridges[1].appServerCwd, "C:\\Users\\USER\\workspace");
  });
});

test("fleet settings read returns the current bridge settings", () => {
  withTempDir((dir) => {
    const workdir = path.join(dir, "workspace");
    fs.mkdirSync(workdir);
    const configPath = path.join(dir, "fleet.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        bridges: [{ id: "slot-a", phonePort: 45214, workdir, provider: "codex", model: "gpt-5.5", appServerCwd: "C:\\Users\\admin\\workspace" }],
      })}\n`,
    );

    assert.deepEqual(readFleetConfigBridgeSettings(configPath, { port: 45214 }), {
      provider: "codex",
      model: "gpt-5.5",
      workdir,
      appServerCwd: "C:\\Users\\admin\\workspace",
    });
  });
});

test("launch settings prefer fleet config over stale launch env", () => {
  withTempDir((dir) => {
    const oldWorkdir = path.join(dir, "old-workdir");
    const newWorkdir = path.join(dir, "new-workdir");
    fs.mkdirSync(oldWorkdir);
    fs.mkdirSync(newWorkdir);
    const configPath = path.join(dir, "fleet.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        bridges: [{ id: "slot-b", phonePort: 45224, workdir: newWorkdir, provider: "codex", model: "gpt-5.5" }],
      })}\n`,
    );
    const env = {
      PHONE_WORKDIR: oldWorkdir,
      PHONE_WORKDIR_45224: oldWorkdir,
      CODEX_MODEL: "gpt-5.4",
      CODEX_MODEL_45224: "gpt-5.4",
      CODEX_APP_SERVER_CWD_45224: "C:\\Users\\admin\\stale",
    };

    const result = launchSettingsFromFleetOrEnv(env, {
      filePath: configPath,
      port: 45224,
      bridgeId: "slot-b",
      provider: "codex",
      fallbackWorkdir: dir,
      fallbackModel: "gpt-5.4",
      launchEnvKeys: new Set(Object.keys(env)),
    });

    assert.equal(result.workdir, newWorkdir);
    assert.equal(result.model, "gpt-5.5");
    assert.equal(result.appServerCwd, "C:\\Users\\admin\\stale");
  });
});

test("launch settings read app-server cwd from fleet config before env", () => {
  withTempDir((dir) => {
    const workdir = path.join(dir, "workspace");
    fs.mkdirSync(workdir);
    const configPath = path.join(dir, "fleet.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        bridges: [{ id: "slot-c", phonePort: 45244, workdir, provider: "codex", model: "gpt-5.5", appServerCwd: "C:\\Users\\admin\\workspace" }],
      })}\n`,
    );

    const env = {
      CODEX_APP_SERVER_CWD_45244: "C:\\Users\\admin\\env",
    };

    const result = launchSettingsFromFleetOrEnv(env, {
      filePath: configPath,
      port: 45244,
      bridgeId: "slot-c",
      provider: "codex",
      fallbackWorkdir: dir,
      fallbackModel: "gpt-5.4",
      launchEnvKeys: new Set(Object.keys(env)),
    });

    assert.equal(result.appServerCwd, "C:\\Users\\admin\\workspace");
  });
});

test("fleet settings update is skipped when no fleet config is active", () => {
  const result = updateFleetConfigBridgeSettings("", { port: 45224, provider: "codex" });

  assert.equal(result.updated, false);
});
