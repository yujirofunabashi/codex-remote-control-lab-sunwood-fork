const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const startPhone = path.join(__dirname, "start-phone.js");

// The flag is fixed when the module loads from the launch environment, so each
// case is read in a fresh process with only the variables the case is about.
function codexServerIsManaged(extraEnv) {
  const script = `
    const { shouldStartCodexServer } = require(${JSON.stringify(startPhone)});
    process.stdout.write(JSON.stringify({ shouldStartCodexServer }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PHONE_UI_PORT: "45999",
      PHONE_TOKEN: "test-token",
      PHONE_WORKDIR: os.tmpdir(),
      ...extraEnv,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).shouldStartCodexServer;
}

test("a Claude-default bridge still starts the Codex app-server on demand", () => {
  // The UI lets a chat switch to Codex on any bridge. That switch is only real
  // if the bridge is willing to bring the app-server up when the first codex
  // request arrives, whichever provider it opened with.
  assert.equal(codexServerIsManaged({ PHONE_AGENT_PROVIDER: "claude" }), true);
  assert.equal(codexServerIsManaged({ PHONE_AGENT_PROVIDER: "codex" }), true);
});

test("an external app-server URL or socket leaves the Codex process to its owner", () => {
  assert.equal(codexServerIsManaged({ PHONE_AGENT_PROVIDER: "claude", CODEX_APP_SERVER_URL: "ws://127.0.0.1:1" }), false);
  assert.equal(codexServerIsManaged({ PHONE_AGENT_PROVIDER: "claude", CODEX_APP_SERVER_SOCK: "/tmp/app-server.sock" }), false);
});
