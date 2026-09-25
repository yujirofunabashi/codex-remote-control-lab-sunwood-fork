// A bridge on the Windows PC that holds the brokerage software is reachable
// with one key, so the key must not also be a way around Codex's own limits.
// PHONE_LOCKDOWN_ROOT pins it to one folder: these cover that the phone's
// "full access" never reaches Codex, that nothing outside the folder, no
// terminal and no other AI can be asked for, that the phone's list of other
// machines is never kept there, and that Windows can start Codex at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

// Local notification settings must never escape through this test's teardown.
globalThis.fetch = async () => ({ ok: true, status: 204, text: async () => "" });

const APP_SERVER_PORT = 45997;
const recorded = [];
const wss = new WebSocketServer({ port: APP_SERVER_PORT });
wss.on("connection", (sock) => {
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    recorded.push(msg);
    if (msg.method === "initialize") sock.send(JSON.stringify({ id: msg.id, result: {} }));
    if (msg.method === "thread/start") sock.send(JSON.stringify({ id: msg.id, result: { thread: { id: "locked-thread", path: sessionPath } } }));
    if (msg.method === "turn/start") sock.send(JSON.stringify({ id: msg.id, result: { turn: { id: "locked-turn" } } }));
  });
});

// Outside the home folder, like C:\phone-work on the Windows PC.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "host-lockdown-"));
const lockRoot = path.join(tmp, "phone-work");
const project = path.join(lockRoot, "project-a");
const outside = path.join(tmp, "kabu-data");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const sessionPath = path.join(tmp, "rollout.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({ type: "session_meta", payload: { id: "locked-thread", cwd: lockRoot } }) + "\n");

process.env.CODEX_APP_SERVER_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`;
process.env.PHONE_UI_PORT = "45997";
process.env.PHONE_TOKEN = "test-token";
process.env.PHONE_WORKDIR = lockRoot;
process.env.PHONE_WORKSPACE_ROOTS = outside;
process.env.PHONE_CODEX_MODELS_CACHE_PATH = path.join(tmp, "models.json");
process.env.PHONE_NOTIFY_EVENTS = "0";
process.env.PHONE_DISCORD_WEBHOOK_URL = "";
process.env.PHONE_LOCKDOWN_ROOT = lockRoot;

const {
  SharedBridge,
  assertLockdownLaunch,
  bridgeInfoPayload,
  browseWorkspaceDirectories,
  codexLaunch,
  lockdownRoot,
  requireUnlockedProvider,
  validateWorkdir,
} = require("./start-phone");

test.after(() => {
  wss.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeClient() {
  return { readyState: 1, sent: [], send(body) { this.sent.push(JSON.parse(body)); }, on() {} };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the phone's full access reaches Codex as workspace-write with approval", async () => {
  recorded.length = 0;
  const bridge = new SharedBridge(null, `locked-${Math.random()}`);
  bridge.clients.add(fakeClient());
  for (let i = 0; i < 200 && !bridge.ready; i += 1) await sleep(20);
  assert.ok(bridge.ready, "the bridge never finished starting a thread");
  bridge.prompt("hi", [], { approvalPolicy: "never", sandboxMode: "danger-full-access" });
  for (let i = 0; i < 200 && !recorded.some((msg) => msg.method === "turn/start"); i += 1) await sleep(20);
  const turn = recorded.find((msg) => msg.method === "turn/start");
  bridge.dispose();
  assert.ok(turn, "no turn/start was sent");
  assert.equal(turn.params.approvalPolicy, "on-request");
  assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
  const start = recorded.find((msg) => msg.method === "thread/start");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "on-request");
});

test("only the locked folder can be a workdir, even an owner-allowed root is closed", () => {
  assert.equal(validateWorkdir(project), project);
  assert.throws(() => validateWorkdir(outside));
  assert.throws(() => validateWorkdir(os.homedir()));
});

test("browsing starts in the locked folder and cannot climb out of it", () => {
  const listing = browseWorkspaceDirectories("");
  assert.equal(listing.path, lockRoot);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["project-a"]);
  assert.throws(() => browseWorkspaceDirectories(tmp));
});

test("only Codex is offered, and the other AIs are refused", () => {
  assert.equal(requireUnlockedProvider("codex"), "codex");
  assert.throws(() => requireUnlockedProvider("claude"), (error) => error.statusCode === 403);
  assert.throws(() => requireUnlockedProvider("gemini"), (error) => error.statusCode === 403);
  const info = bridgeInfoPayload();
  assert.deepEqual(info.providers, ["codex"]);
  assert.equal(info.capabilities.fleet, false);
  assert.equal(info.capabilities.homeScreenInstall, false);
  assert.deepEqual(info.capabilities.lockdown, { root: lockRoot.split(path.sep).join("/"), approvalPolicy: "on-request", sandboxMode: "workspace-write", terminal: false });
});

test("a whole drive, a top-level folder or the home folder is not one folder", () => {
  assert.throws(() => lockdownRoot(path.parse(tmp).root));
  assert.throws(() => lockdownRoot(path.join(path.parse(tmp).root, "Users")));
  assert.throws(() => lockdownRoot(os.homedir()));
  assert.throws(() => lockdownRoot("relative/folder"));
  assert.equal(lockdownRoot(""), "");
});

test("a locked-down bridge refuses to listen beyond this computer", () => {
  assert.throws(() => assertLockdownLaunch({ host: "0.0.0.0", launchWorkdir: lockRoot }), /PHONE_UI_HOST=127\.0\.0\.1/);
  assert.throws(() => assertLockdownLaunch({ host: "127.0.0.1", launchWorkdir: outside }), /inside PHONE_LOCKDOWN_ROOT/);
  assert.doesNotThrow(() => assertLockdownLaunch({ host: "127.0.0.1", launchWorkdir: project }));
});

test("Windows starts Codex through the package's own launcher under this Node", () => {
  const windows = codexLaunch(["app-server"], { platform: "win32", env: {} });
  assert.equal(windows.command, process.execPath);
  assert.match(windows.args[0], /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  assert.equal(windows.args[1], "app-server");
  assert.equal(codexLaunch(["app-server"], { platform: "darwin", env: {} }).args[0], "app-server");
  assert.equal(codexLaunch(["x"], { platform: "win32", env: { CODEX_BIN: "C:\\codex.exe" } }).command, "C:\\codex.exe");
});
