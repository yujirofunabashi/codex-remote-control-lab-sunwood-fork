// A separate, token-protected Windows lab connection using the existing UI.
// Windows polls the relay; there is no new inbound listener on the Windows host.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { LabState, labPath, failure } = require("./lab-state");
const { redactSensitiveText } = require("./debug-log");
const { createBuildTracker } = require("./bridge-build");

const repository = path.resolve(__dirname, "..");
const publicDir = path.join(repository, "public");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function sameSecret(a, b) {
  const left = Buffer.from(String(a || "")), right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestToken(req, url) {
  const protocol = String(req.headers["sec-websocket-protocol"] || "").split(",").map(value => value.trim()).find(value => value.startsWith("phone-token."));
  return req.headers["x-phone-token"] || String(req.headers.authorization || "").replace(/^Bearer /i, "") || url.searchParams.get("token") || (protocol ? Buffer.from(protocol.slice(12), "base64url").toString() : "");
}

async function jsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512000) throw failure("Request too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw failure("Invalid JSON"); }
}

function validateConfig(config) {
  if (!config || !/^[a-z0-9-]+$/.test(config.id || "")) throw new Error("A dedicated lab id is required");
  if (!/^\/home\/[a-z0-9_-]+\/work$/.test(config.workRoot || "")) throw new Error("workRoot must be the lab user's work directory");
  for (const field of ["phoneToken", "workerToken"]) if (!/^[a-zA-Z0-9_-]{32,}$/.test(config[field] || "")) throw new Error(`${field} must be an independent random token`);
  if (config.phoneToken === config.workerToken) throw new Error("Phone and Windows credentials must be distinct");
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.some(value => new URL(value).origin !== value)) throw new Error("allowedOrigins must contain exact origins");
  if (!config.host || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error("Explicit listener host and port are required");
  const octets = config.host.split(".").map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)
    || !(config.host === "127.0.0.1" || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127))) throw new Error("Bind the relay only to loopback or its private Tailscale address");
  if (!config.model || !["high", "xhigh", "max"].includes(config.effort)) throw new Error("A validated model and reasoning effort are required");
  return config;
}

function createLabServer(config, { store = new LabState({ file: config.stateFile, workRoot: config.workRoot }) } = {}) {
  validateConfig(config);
  const startedAt = Date.now();
  const build = createBuildTracker(repository);
  const clients = new Map();
  const shell = Object.fromEntries(["main.js", "style.css"].map(file => [file === "main.js" ? "main" : "style", `${file}?v=${crypto.createHash("sha256").update(fs.readFileSync(path.join(publicDir, file))).digest("hex").slice(0, 12)}`]));
  const workspace = cwd => ({ workdir: cwd, cwd, workspaceLocation: cwd, repoName: path.posix.basename(cwd), gitBranch: "" });
  const info = () => ({ id: config.id, label: "Windows実験室", machineLabel: "Windows", hostName: config.targetHost,
    group: "windows-lab", provider: "codex", providers: ["codex"], model: config.model, modelsByProvider: { codex: config.model },
    effort: config.effort, modelChoices: { codex: [config.model] }, reasoningChoices: { codex: [config.effort], byModel: { [config.model]: [config.effort] } },
    ...workspace(config.workRoot), repoRoot: config.workRoot, uiPort: config.port, startedAt,
    app: { id: config.id, name: "Windows実験室", shortName: "Windows" }, shell,
    build: build.status(),
    capabilities: { threads: true, terminalHistory: false, artifacts: true, approvals: false, fleet: true, lab: true },
    lab: store.target(), color: "#3f7f4b" });
  const threadPayload = thread => ({ type: "ready", provider: "codex", threadId: thread.id, threadTitle: thread.name,
    model: config.model, ...workspace(thread.cwd), history: thread.history, run: store.run(thread), clients: clients.get(thread.id)?.size || 1, slashCommands: [], lab: store.target() });
  const emit = (id, message) => {
    for (const socket of clients.get(id) || []) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...message, threadId: id }));
  };
  store.on("message", emit);
  store.on("target", target => {
    for (const [id] of clients) emit(id, { type: "labState", lab: target });
  });
  store.on("operation", ({ op, result }) => {
    for (const [id] of clients) emit(id, { type: result.ok ? "status" : "error", text: result.ok ? (op === "start" ? "実験室の起動を確認しました。" : "実験室の停止を依頼しました。") : result.error });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const origin = req.headers.origin;
    const allowed = !origin || config.allowedOrigins.includes(origin);
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!allowed) return reply(403, { error: "Origin not allowed" });
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-headers", "content-type, authorization, x-phone-token");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    try {
      if (url.pathname === "/healthz") return reply(200, { ok: true, service: "lab-bridge" });
      if (url.pathname.startsWith("/worker/")) {
        if (origin || req.method !== "POST" || !sameSecret(req.headers["x-lab-worker-token"], config.workerToken)) return reply(401, { error: "Unauthorized" });
        // The worker cannot read registry tokens, issue owner operations, or
        // retrieve anything beyond its assigned, bounded lab requests.
        const body = await jsonBody(req);
        if (url.pathname === "/worker/poll") {
          store.heartbeat(body.target);
          return reply(200, { command: store.lease() });
        }
        if (url.pathname === "/worker/result") { store.complete(body.id, body.result); return reply(200, { ok: true }); }
        if (url.pathname === "/worker/event") { store.event(body.id, body.event || {}); return reply(200, { ok: true }); }
        return reply(404, { error: "Unknown worker operation" });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!sameSecret(requestToken(req, url), config.phoneToken)) return reply(401, { error: "Unauthorized" });
        const provider = url.searchParams.get("provider");
        if (provider && provider !== "codex") return reply(400, { error: "この実験室はCodexだけを使用します。" });
        if (req.method === "GET") {
          if (url.pathname === "/api/bridge/info" || url.pathname === "/api/info") return reply(200, info());
          if (url.pathname === "/api/health") return reply(200, { ok: true, ...info() });
          if (url.pathname === "/api/status") return reply(200, { provider: "codex", ...workspace(config.workRoot), lab: store.target(), bridges: Object.values(store.state.threads).map(thread => ({ threadId: thread.id, provider: "codex", model: config.model, ...workspace(thread.cwd), run: store.run(thread) })) });
          if (url.pathname === "/api/threads") return reply(200, { provider: "codex", activeProvider: "codex", data: store.threadRecords(), hiddenProjects: [] });
          if (url.pathname === "/api/thread") { const thread = store.thread(url.searchParams.get("thread")); return reply(200, { provider: "codex", threadId: thread.id, history: thread.history, ...workspace(thread.cwd), lab: store.target() }); }
          if (url.pathname === "/api/workspaces") return reply(200, { data: Object.values(store.state.folders).map(folder => ({ path: folder.path, name: path.posix.basename(folder.path), label: folder.path, group: "Windows実験室", git: false })) });
          if (url.pathname === "/api/workspaces/browse") {
            const target = labPath(url.searchParams.get("path"), config.workRoot);
            const folder = store.target().ready ? await store.request("browse", { path: target }) : store.state.folders[target];
            if (!folder) throw failure("実験室を起動してフォルダを取得してください。", 409);
            return reply(200, { ...folder, fetchedAt: store.state.folders[target]?.fetchedAt, home: config.workRoot, displayPath: folder.path,
              parent: target === config.workRoot ? null : path.posix.dirname(target), machineLabel: "Windows", hostName: config.targetHost,
              stale: !store.target().ready, readOnly: !store.target().ready });
          }
          if (url.pathname === "/api/artifacts") {
            if (store.target().ready) await store.request("snapshot");
            return reply(200, { data: store.state.artifacts.map(item => ({ ...item, name: path.posix.basename(item.path), kind: item.path.endsWith(".md") ? "markdown" : "text", stale: !store.target().ready })), lab: store.target() });
          }
          if (url.pathname === "/api/file") {
            const filename = labPath(url.searchParams.get("path"), config.workRoot);
            const file = store.target().ready ? await store.request("read", { path: filename }) : store.state.files[filename];
            if (!file) throw failure("停止中です。このファイルの保存済み表示はありません。", 409);
            return reply(200, { ...file, lab: true, stale: !store.target().ready, fetchedAt: store.state.files[filename]?.fetchedAt });
          }
          if (url.pathname === "/api/bridge/registry") return reply(200, { version: 2, revision: 0, bridges: [], tokens: {}, deleted: [] });
          if (["/api/local-settings", "/api/config"].includes(url.pathname)) return reply(200, { ...info(), readOnly: true, workdir: config.workRoot, workspaces: [], lab: store.target() });
          if (["/api/models", "/api/skills", "/api/plugins", "/api/automations"].includes(url.pathname)) return reply(200, { data: [] });
          if (url.pathname === "/api/rate-limits") return reply(200, { provider: "codex", source: "unavailable", windows: [] });
          return reply(404, { error: "この操作は実験室では使用できません。" });
        }
        if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
        const body = await jsonBody(req);
        if (url.pathname === "/api/workspaces") {
          const target = labPath(body.path, config.workRoot);
          const folder = await store.request("browse", { path: target });
          return reply(200, { ok: true, workspace: { path: folder.path, name: path.posix.basename(folder.path), group: "Windows実験室" } });
        }
        if (url.pathname === "/api/lab/start" || url.pathname === "/api/lab/shutdown") {
          const job = store.enqueue(url.pathname.endsWith("/start") ? "start" : "shutdown");
          return reply(202, { ok: true, requestId: job.id });
        }
        if (url.pathname === "/api/bridge/registry") return reply(200, { version: 2, revision: 0, bridges: [], tokens: {}, deleted: [] });
        return reply(403, { error: "実験室で許可されていない操作です。" });
      }
      if (req.method !== "GET") return reply(405, { error: "Method not allowed" });
      let filename = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
      const target = path.resolve(publicDir, filename);
      if (!target.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return reply(404, { error: "Not found" });
      if (!Object.hasOwn(mime, path.extname(target))) return reply(404, { error: "Not found" });
      let bytes = fs.readFileSync(target);
      if (filename === "index.html") bytes = Buffer.from(bytes.toString().replace("<title>Codex Remote</title>", "<title>Windows実験室</title>").replace('href="style.css"', `href="${shell.style}"`).replace('src="main.js"', `src="${shell.main}"`));
      res.writeHead(200, { "content-type": mime[path.extname(target)], "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(bytes);
    } catch (error) { reply(error.statusCode || 500, { error: redactSensitiveText(error.message) }); }
  });

  const wss = new WebSocket.Server({ noServer: true, maxPayload: 100000, handleProtocols: protocols => protocols.has("phone-bridge-v1") ? "phone-bridge-v1" : false });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/bridge" || (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) || !sameSecret(requestToken(req, url), config.phoneToken)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const sendError = error => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", text: redactSensitiveText(error.message) })); };
      try {
        if (url.searchParams.get("provider") && url.searchParams.get("provider") !== "codex") throw failure("この実験室はCodexだけを使用します。");
        const existing = url.searchParams.get("thread");
        const thread = existing ? store.thread(existing) : url.searchParams.get("fresh") === "1" ? store.createThread(url.searchParams.get("workdir") || config.workRoot) : Object.values(store.state.threads)[0];
        if (!thread) throw failure("実験室を起動して、新規セッションから作業フォルダを選んでください。", 409);
        if (!clients.has(thread.id)) clients.set(thread.id, new Set());
        clients.get(thread.id).add(ws);
        ws.send(JSON.stringify(threadPayload(thread)));
        ws.on("close", () => { clients.get(thread.id)?.delete(ws); if (!clients.get(thread.id)?.size) clients.delete(thread.id); });
        ws.on("message", raw => {
          try {
            const message = JSON.parse(String(raw));
            if (message.type === "prompt") {
              const options = message.options || {};
              if (message.attachments?.length || message.images?.length || (options.model && options.model !== config.model) || (options.effort && options.effort !== config.effort)
                || (options.serviceTier && options.serviceTier !== "standard") || (options.sandboxMode && options.sandboxMode !== "workspace-write") || (options.approvalPolicy && options.approvalPolicy !== "never")) throw failure("実験室では確認済みのモデル・検討設定、専用フォルダ内の操作、文章の指示だけを使います。");
              const clientMessageId = String(message.clientMessageId || "");
              if (!/^[a-zA-Z0-9_-]{1,160}$/.test(clientMessageId)) throw failure("送信識別番号が必要です。画面を更新してください。");
              store.enqueue("run", { prompt: message.text }, { threadId: thread.id, clientMessageId });
              ws.send(JSON.stringify({ type: "promptAccepted", threadId: thread.id, clientMessageId }));
            } else if (message.type === "interrupt") {
              const current = thread.run.turnId;
              if (current && ["running", "streaming", "interrupting"].includes(thread.run.state)) {
                store.enqueue("interrupt", { taskId: current });
                thread.run = { ...thread.run, state: "interrupting", label: "Windowsへ中断を依頼しています" };
                store.save();
                emit(thread.id, { type: "runState", ...store.run(thread) });
              }
            } else if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
            else throw failure("実験室で許可されていない操作です。");
          } catch (error) { sendError(error); }
        });
      } catch (error) { sendError(error); ws.close(); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const [id] of clients) {
      emit(id, { type: "labState", lab: store.target() });
      emit(id, { type: "runState", ...store.run(store.thread(id)) });
    }
  }, 5000);
  heartbeat.unref();
  server.on("close", () => { clearInterval(heartbeat); for (const peers of clients.values()) for (const ws of peers) ws.close(); wss.close(); });
  return { server, store };
}

if (require.main === module) {
  try {
    const file = path.resolve(process.argv[2] || ".phone-lab.local.json");
    if (fs.lstatSync(file).isSymbolicLink() || (fs.statSync(file).mode & 0o077)) throw new Error("Lab config must be an owner-only regular file");
    const config = validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    const { server } = createLabServer(config);
    server.listen(config.port, config.host, () => process.stdout.write(`Windows lab relay ready on ${config.host}:${config.port}; credentials are not printed.\n`));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { createLabServer, validateConfig, sameSecret };
