// Real Codex writer ownership and terminal detach, with an isolated home and
// a local fake model. No credentials or external inference requests are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function deadline(promise, label, ms = 20000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function client(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.method) events.push(msg);
    const call = pending.get(msg.id);
    if (!call || msg.method) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve(msg.result);
  });
  const request = (method, params) => deadline(new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  }), method);
  await request("initialize", { clientInfo: { name: "handoff-smoke", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  const waitFor = async (method, predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const event = events.find((message) => message.method === method && predicate(message.params));
      if (event) return event.params;
      await pause(50);
    }
    throw new Error(`Timed out: ${method}`);
  };
  return { request, waitFor, close: () => ws.close() };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-"));
  const home = path.join(directory, "codex-home");
  const project = path.join(directory, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  let responses = 0;
  const model = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.startsWith("/v1/responses")) {
        res.writeHead(404); res.end(); return;
      }
      const id = `response_${++responses}`;
      const item = { id: `message_${responses}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Handoff fixture response.", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, status: "completed", output: [item],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
      res.end();
    });
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  fs.writeFileSync(path.join(home, "config.toml"), [
    'check_for_update_on_startup = false',
    'model = "handoff-test"',
    'model_provider = "handoff-test"',
    '[model_providers.handoff-test]',
    'name = "Handoff test (no inference)"',
    `base_url = "http://127.0.0.1:${model.address().port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
  ].join("\n"));
  // Only runtime necessities are inherited. No credentials or phone settings.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CODEX_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8" };
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const endpoint = `ws://127.0.0.1:${reserve.address().port}`;
  await new Promise((resolve) => reserve.close(resolve));
  const codex = process.env.CODEX_BIN || "codex";
  const server = spawn(codex, ["app-server", "--listen", endpoint], { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stderr.on("data", (data) => { serverLog = (serverLog + data).slice(-6000); });
  server.stdout.resume();
  const connections = [];
  const tmuxSocket = path.join(directory, "tmux.sock");
  const tmux = (...args) => execFileSync("tmux", ["-S", tmuxSocket, "-f", "/dev/null", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let proxy, terminalStarted = false;
  try {
    let phone;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { phone = await client(endpoint); break; } catch {
        if (server.exitCode !== null) throw new Error(`app-server exited: ${serverLog}`);
        await pause(100);
      }
    }
    assert.ok(phone, `app-server did not start: ${serverLog}`);
    connections.push(phone);
    const { thread } = await phone.request("thread/start", { cwd: project, model: "handoff-test" });
    assert.ok(thread.id);
    const first = await phone.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Phone fixture input" }] });
    const firstDone = await phone.waitFor("turn/completed", (params) => params.turn.id === first.turn.id);
    assert.equal(firstDone.turn.status, "completed", JSON.stringify(firstDone.turn.error));

    // Observe the real CLI's resume response while forwarding to the same
    // server the phone already owns. No transcript or credentials are logged.
    let resumed;
    const terminalResumed = new Promise((resolve, reject) => { resumed = { resolve, reject }; });
    proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(proxy, "listening");
    const upstreams = new Set();
    proxy.on("connection", (downstream) => {
      const upstream = new WebSocket(endpoint);
      upstreams.add(upstream);
      const queue = [];
      const methods = new Map();
      downstream.on("message", (data) => {
        const message = JSON.parse(data);
        if (message.method) methods.set(message.id, message.method);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
        else queue.push(data.toString());
      });
      upstream.on("open", () => { for (const message of queue) upstream.send(message); });
      upstream.on("message", (data) => {
        const message = JSON.parse(data);
        if (!message.method && methods.get(message.id) === "thread/resume") {
          if (message.error) resumed.reject(new Error(message.error.message));
          else resumed.resolve(message.result.thread.id);
        }
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data.toString());
      });
      upstream.on("error", (error) => resumed.reject(error));
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => upstreams.delete(upstream));
    });
    const remote = `ws://127.0.0.1:${proxy.address().port}`;
    // A dedicated tmux server supplies a real PTY, without touching any of
    // the operator's terminals, tmux configuration or existing sessions.
    tmux("new-session", "-d", "-s", "handoff", "-x", "120", "-y", "40", "-c", project,
      codex, "resume", thread.id, "--remote", remote, "--no-alt-screen");
    terminalStarted = true;
    tmux("set-option", "-w", "-t", "handoff", "remain-on-exit", "on");
    const resumedId = await deadline(terminalResumed, "terminal joins phone thread").catch((error) => {
      throw new Error(`${error.message}\n${tmux("capture-pane", "-p", "-t", "handoff")}`);
    });
    assert.equal(resumedId, thread.id);
    await pause(1000);
    tmux("send-keys", "-t", "handoff", "-l", "Terminal fixture input");
    // Codex groups rapid input as a paste; let that window settle so Enter
    // submits instead of becoming a newline in the synthetic paste.
    await pause(500);
    tmux("send-keys", "-t", "handoff", "Enter");
    const terminalTurn = await phone.waitFor("turn/completed", (params) => params.turn.id !== first.turn.id).catch((error) => {
      throw new Error(`${error.message}; local model responses=${responses}\n${tmux("capture-pane", "-p", "-t", "handoff")}`);
    });
    assert.equal(terminalTurn.turn.status, "completed", JSON.stringify(terminalTurn.turn.error));
    tmux("send-keys", "-t", "handoff", "-l", "/exit");
    await pause(500);
    tmux("send-keys", "-t", "handoff", "Enter");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (tmux("display-message", "-p", "-t", "handoff", "#{pane_dead}").trim() === "1") break;
      await pause(100);
    }
    assert.equal(tmux("display-message", "-p", "-t", "handoff", "#{pane_dead_status}").trim(), "0", "terminal exits normally");
    assert.equal(server.exitCode, null);
    assert.equal((await phone.request("thread/resume", { threadId: thread.id })).thread.id, thread.id);
    const back = await phone.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Back on phone" }] });
    assert.equal((await phone.waitFor("turn/completed", (params) => params.turn.id === back.turn.id)).turn.status, "completed");
    phone.close();
    const reopenedPhone = await client(endpoint);
    connections.push(reopenedPhone);
    const restored = (await reopenedPhone.request("thread/resume", { threadId: thread.id })).thread;
    assert.equal(restored.id, thread.id);
    assert.equal(restored.turns.length, 3);
    console.log("Real Codex: phone input -> terminal input -> terminal exit -> phone input/reconnect retains one thread and its three turns; local fake model only");
    for (const upstream of upstreams) upstream.close();
  } finally {
    for (const connection of connections) connection.close();
    if (terminalStarted) { try { tmux("kill-server"); } catch {} }
    if (proxy) {
      for (const ws of proxy.clients) ws.terminate();
      proxy.close();
    }
    if (server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGTERM");
      await deadline(stopped, "test server cleanup", 5000);
    }
    await new Promise((resolve) => model.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
