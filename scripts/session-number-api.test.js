const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const token = "isolated-session-number-fixture";

test("authenticated real bridge slots share numbers and retain them after restart", { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-number-api-"));
  const app = path.join(directory, "app");
  const numberDirectory = path.join(directory, "numbers");
  // Only application sources, not local settings, keys, transcripts or .env.
  for (const folder of ["scripts", "public"]) fs.cpSync(path.join(root, folder), path.join(app, folder), { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(require.resolve("ws/package.json"))), path.join(app, "node_modules"), "dir");
  const children = [];
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  t.after(async () => {
    await Promise.all(children.map(stop));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const reserve = net.createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const child = spawn(process.execPath, [path.join(app, "scripts/start-phone.js")], {
      cwd: app,
      env: {
        PATH: path.dirname(process.execPath), HOME: process.env.HOME,
        PHONE_UI_HOST: "127.0.0.1", PHONE_UI_PORT: String(port),
        PHONE_AGENT_PROVIDER: "claude", PHONE_WORKDIR: directory,
        PHONE_TOKEN: token, PHONE_SESSION_NUMBERS_DIR: numberDirectory,
        CODEX_APP_SERVER_URL: "ws://127.0.0.1:1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`fixture did not start: ${output.slice(-600)}`)), 10000);
      const read = chunk => {
        output += chunk;
        if (output.includes("Press Ctrl+C to stop.")) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${output.slice(-600)}`)); });
    });
    const request = (sessions, key = token, method = "POST") => fetch(`http://127.0.0.1:${port}/api/session-numbers`, {
      method,
      headers: { "x-phone-token": key, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ sessions }) } : {}),
    });
    return { child, request };
  };
  const first = await start();
  const second = await start();
  const one = { provider: "codex", threadId: "one" };
  const two = { provider: "codex", threadId: "two" };
  assert.equal((await first.request([one], "wrong-key")).status, 401);
  assert.equal(fs.existsSync(numberDirectory), false, "unauthenticated reads/writes create no number store");
  assert.equal((await first.request([], token, "GET")).status, 405);
  assert.equal((await first.request([one, { provider: "../invalid", threadId: "two" }])).status, 400);
  assert.equal(fs.existsSync(numberDirectory), false, "invalid batches are not partly assigned");
  assert.deepEqual((await (await first.request([one, two])).json()).sessions.map(item => item.sessionNumber), [1, 2]);
  assert.deepEqual((await (await second.request([two, one])).json()).sessions.map(item => item.sessionNumber), [2, 1]);
  await stop(first.child);
  const restarted = await start();
  assert.deepEqual((await (await restarted.request([two, one])).json()).sessions.map(item => item.sessionNumber), [2, 1]);
  assert.equal((await (await restarted.request([{ ...one, provider: "claude" }])).json()).sessions[0].sessionNumber, 1);
});
