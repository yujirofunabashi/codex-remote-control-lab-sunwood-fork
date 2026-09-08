const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");
const { createLabServer } = require("./start-lab-bridge");
const root = "/home/agent-lab/work";

async function fixture(t) {
  const config = { id: "windows-lab", targetHost: "windows.fixture", host: "127.0.0.1", port: 45251, workRoot: root,
    phoneToken: "p".repeat(40), workerToken: "w".repeat(40), allowedOrigins: ["http://127.0.0.1:45999"], model: "gpt-6-astra", effort: "xhigh" };
  const app = createLabServer(config);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, options = {}) => fetch(origin + url, { ...options, headers: { authorization: `Bearer ${config.phoneToken}`, ...options.headers } });
  const worker = (url, body, headers = {}) => request(`/worker/${url}`, { method: "POST", headers: { "content-type": "application/json", "x-lab-worker-token": config.workerToken, ...headers }, body: JSON.stringify(body) });
  async function ready() {
    for (let i = 0; i < 3; i++) {
      const response = await worker("poll", { target: { vmState: "running", guestReady: true } });
      const { command } = await response.json();
      if (!command) break;
      await worker("result", { id: command.id, result: { ok: true, data: command.op === "browse" ? { path: root, entries: [] } : { artifacts: [] } } });
    }
  }
  return { ...app, config, origin, request, worker, ready };
}

test("phone and host credentials, origins and allowed operations stay separate", async t => {
  const app = await fixture(t);
  assert.equal((await fetch(app.origin + "/api/status")).status, 401);
  assert.equal((await app.request("/api/status", { headers: { authorization: `Bearer ${app.config.workerToken}` } })).status, 401);
  assert.equal((await app.request("/api/status", { headers: { origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await app.worker("poll", {}, { origin: app.config.allowedOrigins[0] })).status, 401);
  assert.equal((await app.worker("poll", {}, { "x-lab-worker-token": app.config.phoneToken })).status, 401);
  for (const endpoint of ["terminal/run", "config", "restart", "upload", "lab/publish"]) {
    assert.equal((await app.request(`/api/${endpoint}`, { method: "POST", body: "{}" })).status, 403);
  }
  const info = await (await app.request("/api/bridge/info")).json();
  assert.equal(info.machineLabel, "Windows");
  assert.equal(info.capabilities.lab, true);
  assert.deepEqual(info.modelChoices.codex, [app.config.model]);
  assert.equal(JSON.stringify(info).includes(app.config.workerToken), false);
  assert.equal(JSON.stringify(info).includes(app.config.phoneToken), false);
});

test("a saved file/folder remains readable when off but cannot create a session", async t => {
  const app = await fixture(t);
  await app.ready();
  const job = app.store.enqueue("read", { path: `${root}/plan.md` });
  app.store.complete(job.id, { ok: true, data: { path: `${root}/plan.md`, kind: "markdown", text: "# 下書き" } });
  const fetchedAt = app.store.state.files[`${root}/plan.md`].fetchedAt;
  await app.worker("poll", { target: { vmState: "off", guestReady: false } });
  const file = await (await app.request(`/api/file?path=${encodeURIComponent(`${root}/plan.md`)}`)).json();
  assert.equal(file.stale, true);
  assert.equal(file.fetchedAt, fetchedAt);
  assert.equal(file.text, "# 下書き");
  const folder = await (await app.request("/api/workspaces/browse")).json();
  assert.equal(folder.readOnly, true);
  assert.equal((await app.request("/api/workspaces", { method: "POST", body: JSON.stringify({ path: root }) })).status, 409);
  assert.equal((await app.request("/api/file?path=%2Fetc%2Fpasswd")).status, 403);
});

test("the real socket protocol accepts a prompt once, rejects scope changes, and resumes history", async t => {
  const app = await fixture(t);
  await app.ready();
  const thread = app.store.createThread(root);
  const messages = [];
  const socket = new WebSocket(app.origin.replace("http:", "ws:") + `/bridge?provider=codex&thread=${thread.id}`,
    ["phone-bridge-v1", "phone-token." + Buffer.from(app.config.phoneToken).toString("base64url")]);
  t.after(() => socket.terminate());
  socket.on("message", bytes => messages.push(JSON.parse(String(bytes))));
  await once(socket, "open");
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("Expected socket event was not received");
  };
  await until(() => messages.some(message => message.type === "ready"));
  const prompt = { type: "prompt", clientMessageId: "request-1", text: "実装を検査して", options: { model: app.config.model, effort: "xhigh", sandboxMode: "workspace-write", approvalPolicy: "never" } };
  socket.send(JSON.stringify({ ...prompt, options: { ...prompt.options, sandboxMode: "danger-full-access" } }));
  await until(() => messages.some(message => message.type === "error"));
  assert.equal(thread.history.length, 0);
  socket.send(JSON.stringify(prompt));
  socket.send(JSON.stringify(prompt));
  await until(() => messages.filter(message => message.type === "promptAccepted").length === 2);
  assert.equal(thread.history.length, 1);
  const poll = await (await app.worker("poll", { target: { vmState: "running", guestReady: true } })).json();
  assert.equal(poll.command.op, "run");
  assert.equal(poll.command.args.workdir, root);
  assert.equal(JSON.stringify(poll).includes(app.config.phoneToken), false);
  await app.worker("result", { id: poll.command.id, result: { ok: true, data: { text: "検査が終わりました。公開はしていません。" } } });
  await until(() => messages.some(message => message.type === "turn" && message.status === "completed"));
  const history = await (await app.request(`/api/thread?thread=${thread.id}`)).json();
  assert.equal(history.history.length, 2);
  socket.close();
  await once(socket, "close");
});
