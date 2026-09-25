// The locked-down bridge as the phone meets it: a real server process, a stub
// app-server. A refused AI must arrive as a message the phone will not redial
// (a refused upgrade reached the page as a bare drop and it redialled about once
// a second), and the terminal and registry routes must be closed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const WebSocket = require("ws");

const root = path.resolve(__dirname, "..");
const token = "isolated-lockdown-fixture";

async function freePort() {
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const { port } = reserve.address();
  await new Promise((resolve) => reserve.close(resolve));
  return port;
}

async function fixture(t, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-lockdown-"));
  const app = path.join(directory, "app");
  const lockRoot = path.join(directory, "phone-work");
  fs.mkdirSync(lockRoot);
  // Only application sources, not local settings, keys, transcripts or .env.
  for (const folder of ["scripts", "public"]) fs.cpSync(path.join(root, folder), path.join(app, folder), { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(require.resolve("ws/package.json"))), path.join(app, "node_modules"), "dir");
  const stubPort = await freePort();
  const stub = new WebSocket.Server({ port: stubPort, host: "127.0.0.1" });
  stub.on("connection", (sock) => sock.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined) sock.send(JSON.stringify({ id: msg.id, result: { data: [] } }));
  }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(app, "scripts/start-phone.js")], {
    cwd: app,
    env: {
      PATH: path.dirname(process.execPath), HOME: process.env.HOME,
      PHONE_UI_HOST: "127.0.0.1", PHONE_UI_PORT: String(port),
      PHONE_AGENT_PROVIDER: "codex", PHONE_WORKDIR: lockRoot, PHONE_LOCKDOWN_ROOT: lockRoot,
      PHONE_TOKEN: token, PHONE_NOTIFY_EVENTS: "0", PHONE_DISCORD_WEBHOOK_URL: "",
      PHONE_SESSION_NUMBERS_DIR: path.join(directory, "numbers"),
      CODEX_APP_SERVER_URL: `ws://127.0.0.1:${stubPort}`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    stub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { child, port, output: () => output };
}

async function started(server) {
  const deadline = Date.now() + 10000;
  while (!server.output().includes("Press Ctrl+C to stop.")) {
    if (server.child.exitCode !== null) throw new Error(`fixture exited: ${server.output().slice(-600)}`);
    if (Date.now() > deadline) throw new Error(`fixture did not start: ${server.output().slice(-600)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a locked-down bridge will not listen beyond this computer", { timeout: 20000 }, async (t) => {
  const server = await fixture(t, { PHONE_UI_HOST: "0.0.0.0" });
  const [code] = await once(server.child, "exit");
  assert.notEqual(code, 0);
  assert.match(server.output(), /PHONE_UI_HOST=127\.0\.0\.1/);
});

test("another AI is refused with a message the phone does not redial", { timeout: 20000 }, async (t) => {
  const server = await fixture(t);
  await started(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/bridge?provider=claude`, [`phone-token.${Buffer.from(token).toString("base64url")}`]);
  const [data] = await once(ws, "message");
  const msg = JSON.parse(String(data));
  assert.equal(msg.type, "error");
  assert.equal(msg.retryable, false);
  assert.equal(msg.code, "provider_unavailable");
  assert.match(msg.text, /Codex/);
  await once(ws, "close");
});

test("the terminal and the registry backup are closed, and only Codex is offered", { timeout: 20000 }, async (t) => {
  const server = await fixture(t);
  await started(server);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { "x-phone-token": token, "content-type": "application/json" };
  const terminal = await fetch(`${base}/api/terminal/run`, { method: "POST", headers, body: JSON.stringify({ command: "echo hi" }) });
  assert.equal(terminal.status, 403);
  const registry = await fetch(`${base}/api/bridge/registry`, { headers });
  assert.equal(registry.status, 403);
  assert.equal((await registry.json()).code, "registry-disabled");
  const info = await (await fetch(`${base}/api/bridge/info`, { headers })).json();
  assert.deepEqual(info.providers, ["codex"]);
  assert.equal(info.capabilities.lockdown.sandboxMode, "workspace-write");
  const other = await fetch(`${base}/api/threads?provider=claude`, { headers });
  assert.equal(other.status, 403);
});
