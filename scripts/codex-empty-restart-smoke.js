// Real Codex + bridge, isolated storage, no prompts or external inference.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once, EventEmitter } = require("node:events");
const WebSocket = require("ws");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-restart-")));
  const fixtureHome = path.join(directory, "codex-home");
  const project = path.join(directory, "project");
  fs.mkdirSync(fixtureHome);
  fs.mkdirSync(project);
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const endpoint = `ws://127.0.0.1:${reserve.address().port}`;
  await new Promise(resolve => reserve.close(resolve));
  const root = path.resolve(__dirname, "..");
  const codex = process.env.CODEX_BIN || path.join(root, "node_modules/.bin/codex");
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: fixtureHome };
  const originalHomedir = os.homedir;
  let child, bridge, control;
  const start = () => {
    child = spawn(codex, [
      "-c", "check_for_update_on_startup=false",
      "-c", 'model="fixture"',
      "-c", 'model_provider="fixture"',
      "-c", 'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false}',
      "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "-c", "features.apps=false",
      "app-server", "--listen", endpoint,
    ], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await stopped;
  };
  async function connect() {
    let socket;
    for (let attempt = 0; attempt < 100; attempt++) {
      socket = new WebSocket(endpoint);
      try { await once(socket, "open"); break; } catch { socket.terminate(); await pause(50); }
    }
    assert.equal(socket.readyState, WebSocket.OPEN, "fixture app-server started");
    let next = 0;
    const pending = new Map();
    socket.on("message", raw => {
      const message = JSON.parse(raw);
      const request = !message.method && pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await request("initialize", { clientInfo: { name: "empty-restart-smoke", version: "1" } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    return { request, close: () => socket.close() };
  }
  try {
    for (const key of Object.keys(process.env)) if (/^(PHONE_|CODEX_|CLAUDE_|AGENT_)/.test(key)) delete process.env[key];
    process.env.CODEX_APP_SERVER_URL = endpoint;
    process.env.PHONE_WORKDIR = project;
    process.env.PHONE_TOKEN = "isolated-smoke-token";
    process.env.PHONE_NOTIFY_EVENTS = "0";
    process.env.CODEX_HISTORY_SYNC = "0";
    os.homedir = () => directory;
    const { SharedBridge } = require("./start-phone");
    // A checkout can have local notification settings. Never use them here.
    for (const key of Object.keys(process.env)) if (/^PHONE_(NOTIFY|NTFY|PUSHOVER|DISCORD)_/.test(key)) process.env[key] = "";
    const attach = instance => {
      const browser = new EventEmitter();
      browser.readyState = WebSocket.OPEN;
      browser.send = () => {};
      instance.addClient(browser);
    };
    start();
    control = await connect();
    bridge = new SharedBridge(null, "new-empty-fixture", { workdir: project });
    attach(bridge);
    await waitFor(() => bridge.ready || bridge.startupFailed, "new conversation ready");
    assert.equal(bridge.startupFailed, false);
    // Metadata-only reads do not materialize the file: the bridge must already
    // have saved it before saying it is ready for the first user message.
    const { thread } = await control.request("thread/read", { threadId: bridge.threadId, includeTurns: false });
    assert.ok(fs.existsSync(thread.path), "new conversation has a saved record before the first prompt");
    const before = fs.readFileSync(thread.path, "utf8");
    assert.equal(before.trim().split("\n").length, 1, "no synthetic user turn is written");
    bridge.dispose();
    control.close();
    await stop();
    start();
    control = await connect();
    bridge = new SharedBridge(thread.id, "reopened-empty-fixture", { workdir: directory });
    attach(bridge);
    await waitFor(() => bridge.ready || bridge.startupFailed, "same empty conversation after restart");
    assert.equal(bridge.startupFailed, false);
    assert.equal(bridge.threadId, thread.id, "the same conversation id survives the restart");
    assert.equal(bridge.workdir, project, "the stored original folder wins over a stale browser hint");
    assert.equal(bridge.history.length, 0);
    assert.equal(fs.readFileSync(thread.path, "utf8"), before, "reopening does not rewrite the original");
    console.log("Real Codex: new unsent conversation is saved before ready, survives a server restart with the same id and folder, and contains no fabricated messages");
  } finally {
    bridge?.dispose();
    control?.close();
    os.homedir = originalHomedir;
    await stop();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
