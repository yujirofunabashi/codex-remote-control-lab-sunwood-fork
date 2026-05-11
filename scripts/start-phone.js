const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { bridgeKeyForRequest, shouldDisposeIdleBridge, shouldPromoteBridgeKey } = require("./bridge-state");
const { isHistorySyncEnabled, runHistorySync } = require("./history-sync");
const { bridgeUrls, notifyBridgeUrls } = require("./phone-notify");

const root = path.resolve(__dirname, "..");

function normalizeProvider(input) {
  const value = String(input || "codex").trim().toLowerCase();
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported PHONE_AGENT_PROVIDER: ${value}`);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(root, ".env"));

function uploadLimitBytes() {
  const mb = Number(process.env.PHONE_MAX_UPLOAD_MB || 256);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
}

const codexBin = path.join(root, "node_modules", ".bin", "codex");
const claudeBin = process.env.CLAUDE_BIN || "claude";
const envPath = path.join(root, ".env");
const uiPort = Number(process.env.PHONE_UI_PORT || 45214);
const uiHost = process.env.PHONE_UI_HOST || "0.0.0.0";
const agentProvider = normalizeProvider(process.env.PHONE_AGENT_PROVIDER || process.env.AGENT_PROVIDER || process.env.PHONE_AGENT_PROVIDER_DEFAULT || "codex");
const isCodexProvider = agentProvider === "codex";
const isClaudeProvider = agentProvider === "claude";
const codexPort = Number(process.env.CODEX_APP_SERVER_PORT || 45213);
const codexSocketPath = process.env.CODEX_APP_SERVER_SOCK || "";
const codexUrl = process.env.CODEX_APP_SERVER_URL || (codexSocketPath ? "ws://codex-app-server/rpc" : `ws://127.0.0.1:${codexPort}`);
const shouldStartCodexServer = isCodexProvider && !process.env.CODEX_APP_SERVER_URL && !codexSocketPath;
const modelEnvKey = isClaudeProvider ? "CLAUDE_MODEL" : "CODEX_MODEL";
const workdirEnvKey = isClaudeProvider ? "CLAUDE_WORKDIR" : "CODEX_WORKDIR";
const historySyncEnvKey = isClaudeProvider ? "CLAUDE_HISTORY_SYNC" : "CODEX_HISTORY_SYNC";
const workdir = process.env.PHONE_WORKDIR || process.env[workdirEnvKey] || process.env.CODEX_WORKDIR || root;
const model = process.env.PHONE_MODEL || process.env[modelEnvKey] || (isClaudeProvider ? "sonnet" : process.env.CODEX_MODEL || "gpt-5.4");
const historySyncEnabled = isCodexProvider && isHistorySyncEnabled(process.env);
const tokenPath = path.join(root, ".phone-token");
const workspacePrefsPath = path.join(root, ".phone-workspaces.json");
const uploadDir = path.join(root, ".uploads");
const maxUploadBytes = uploadLimitBytes();
const codexModelOptions = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];
const claudeModelOptions = ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-5"];
const modelOptions = isClaudeProvider ? claudeModelOptions : codexModelOptions;
const bridges = new Map();
const historyLimit = 80;
const imageExtensions = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);
const staticMimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

function modelEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_MODEL" : "CODEX_MODEL";
}

function workdirEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_WORKDIR" : "CODEX_WORKDIR";
}

function defaultModelForProvider(provider) {
  return provider === "claude" ? "sonnet" : "gpt-5.4";
}

function modelOptionsForProvider(provider) {
  return provider === "claude" ? claudeModelOptions : codexModelOptions;
}

function modelFromEnv(env, provider, fallback = defaultModelForProvider(provider)) {
  return env.PHONE_MODEL || env[modelEnvKeyForProvider(provider)] || (provider === "codex" ? env.CODEX_MODEL : undefined) || fallback;
}

function workdirFromEnv(env, provider, fallback = workdir) {
  return env.PHONE_WORKDIR || env[workdirEnvKeyForProvider(provider)] || env.CODEX_WORKDIR || fallback;
}

function getToken() {
  if (process.env.PHONE_TOKEN) return process.env.PHONE_TOKEN;
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function parseEnvValues(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function encodeEnvValue(value) {
  const text = String(value ?? "");
  if (/[\n\r]/.test(text)) throw new Error("Environment values cannot contain newlines");
  if (!text || /[\s#"'\\]/.test(text)) return JSON.stringify(text);
  return text;
}

function writeEnvValues(updates) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates).filter(([, value]) => value !== undefined));
  const lines = existing.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${encodeEnvValue(value)}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${encodeEnvValue(value)}`);
  const output = `${lines.filter((line, index) => line || index < lines.length - 1).join("\n")}\n`;
  fs.writeFileSync(envPath, output, { mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Best effort: the bridge still works if the filesystem refuses chmod.
  }
}

function isUnderHome(target) {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(target);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`);
}

function validateWorkdir(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Workdir is required");
  const target = path.resolve(raw);
  if (!path.isAbsolute(target) || !isUnderHome(target)) throw new Error("Workdir must be an absolute path under the home folder");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error("Workdir does not exist");
  return target;
}

function validateModel(input) {
  const nextModel = String(input || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(nextModel)) throw new Error("Invalid model name");
  return nextModel;
}

function readWorkspacePrefs() {
  if (!fs.existsSync(workspacePrefsPath)) return { recent: [] };
  try {
    const prefs = JSON.parse(fs.readFileSync(workspacePrefsPath, "utf8"));
    return { recent: Array.isArray(prefs.recent) ? prefs.recent : [] };
  } catch {
    return { recent: [] };
  }
}

function writeWorkspacePrefs(prefs) {
  fs.writeFileSync(workspacePrefsPath, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(workspacePrefsPath, 0o600);
  } catch {
    // Best effort only.
  }
}

function rememberWorkspace(workspacePath) {
  const target = validateWorkdir(workspacePath);
  const prefs = readWorkspacePrefs();
  const recent = [target, ...prefs.recent.filter((item) => path.resolve(item) !== target)]
    .filter((item) => fs.existsSync(item) && fs.statSync(item).isDirectory())
    .slice(0, 12);
  writeWorkspacePrefs({ recent });
  return target;
}

function workspaceOptionFor(workspacePath, group) {
  const target = path.resolve(workspacePath);
  return {
    path: target,
    label: target.replace(`${os.homedir()}/`, "~/"),
    name: path.basename(target) || target,
    group,
    git: fs.existsSync(path.join(target, ".git")),
  };
}

function collectGitWorkspaces(baseDir, maxDepth = 4, seen = new Set()) {
  const base = path.resolve(baseDir);
  if (!fs.existsSync(base) || seen.has(base)) return [];
  seen.add(base);

  const results = [];
  if (fs.existsSync(path.join(base, ".git"))) results.push(base);
  if (maxDepth <= 0) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    results.push(...collectGitWorkspaces(path.join(base, entry.name), maxDepth - 1, seen));
  }
  return results;
}

function collectProjectFolders(baseDir, maxDepth = 3, seen = new Set()) {
  const base = path.resolve(baseDir);
  if (!fs.existsSync(base) || seen.has(base)) return [];
  seen.add(base);
  if (maxDepth <= 0) return [];

  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const target = path.join(base, entry.name);
    const hasProjectMarker = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md", "AGENTS.md"].some((name) =>
      fs.existsSync(path.join(target, name)),
    );
    if (hasProjectMarker) results.push(target);
    results.push(...collectProjectFolders(target, maxDepth - 1, seen));
  }
  return results;
}

function workspaceOptions() {
  const home = os.homedir();
  const devRoot = path.join(home, "WORK_LOCAL", "00_WORKSPACE", "開発");
  const miniRoot = path.join(home, "WORK_LOCAL", "00_MINI_WORKSPACE");
  const groups = [
    { group: "最近使ったフォルダ", items: readWorkspacePrefs().recent, preserveOrder: true },
    { group: "Gitリポ", items: [...collectGitWorkspaces(devRoot, 5), ...collectGitWorkspaces(miniRoot, 3)] },
    { group: "プロジェクト候補", items: [...collectProjectFolders(devRoot, 5), ...collectProjectFolders(miniRoot, 3)] },
    { group: "基本フォルダ", items: [workdir, root, path.join(home, "WORK_LOCAL"), devRoot, miniRoot] },
  ];
  const seen = new Set();
  const options = [];
  for (const group of groups) {
    const items = group.preserveOrder ? group.items : Array.from(new Set(group.items)).sort((a, b) => a.localeCompare(b, "ja"));
    for (const candidate of items) {
      const target = path.resolve(candidate);
      if (seen.has(target) || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) continue;
      seen.add(target);
      options.push(workspaceOptionFor(target, group.group));
    }
  }
  return options;
}

function localSettingsPayload() {
  const envValues = parseEnvValues(envPath);
  const savedProvider = normalizeProvider(envValues.PHONE_AGENT_PROVIDER || agentProvider);
  const savedHistorySyncEnabled = savedProvider === "codex" ? isHistorySyncEnabled({ CODEX_HISTORY_SYNC: envValues.CODEX_HISTORY_SYNC }) : false;
  const savedPort = Number(envValues.PHONE_UI_PORT || uiPort);
  const savedHost = envValues.PHONE_UI_HOST || uiHost;
  const savedModel = modelFromEnv(envValues, savedProvider, savedProvider === agentProvider ? model : defaultModelForProvider(savedProvider));
  const savedWorkdir = workdirFromEnv(envValues, savedProvider, workdir);
  return {
    settings: {
      provider: savedProvider,
      model: savedModel,
      workdir: savedWorkdir,
      historySyncEnabled: savedHistorySyncEnabled,
      uiPort: savedPort,
      uiHost: savedHost,
    },
    active: {
      provider: agentProvider,
      model,
      workdir,
      historySyncEnabled,
      uiPort,
      uiHost,
    },
    options: {
      providers: ["codex", "claude"],
      models: modelOptions,
      modelsByProvider: {
        codex: codexModelOptions,
        claude: claudeModelOptions,
      },
      defaultModels: {
        codex: modelFromEnv(envValues, "codex", defaultModelForProvider("codex")),
        claude: modelFromEnv(envValues, "claude", defaultModelForProvider("claude")),
      },
      workspaces: workspaceOptions(),
    },
    restartRequired:
      savedProvider !== agentProvider ||
      savedModel !== model ||
      savedWorkdir !== workdir ||
      savedHistorySyncEnabled !== historySyncEnabled ||
      savedPort !== uiPort ||
      savedHost !== uiHost,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function waitForReady() {
  const url = `http://127.0.0.1:${codexPort}/readyz`;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => {
      if (Date.now() - started > 10_000) reject(new Error("Codex app-server did not become ready"));
      else setTimeout(tick, 250);
    };
    const tick = () => {
      http
        .get(url, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .on("error", retry);
    };
    tick();
  });
}

function createUpstreamWebSocket() {
  if (!codexSocketPath) return new WebSocket(codexUrl);
  return new WebSocket(codexUrl, {
    perMessageDeflate: false,
    createConnection: () => net.createConnection(codexSocketPath),
  });
}

class AppServerRpcClient {
  constructor() {
    this.upstream = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.connecting = null;
  }

  request(method, params) {
    return this.ensureReady().then(() => this.sendRequest(method, params));
  }

  ensureReady() {
    if (this.ready && this.upstream?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.upstream = createUpstreamWebSocket();
    this.ready = false;
    this.connecting = new Promise((resolve, reject) => {
      const fail = (error) => {
        this.connecting = null;
        reject(error);
      };

      this.upstream.on("open", () => {
        this.sendRequest("initialize", {
          clientInfo: { name: "codex-phone-bridge-api", title: "Codex Phone Bridge API", version: "0.1.0" },
        })
          .then(() => {
            if (this.upstream?.readyState === WebSocket.OPEN) {
              this.upstream.send(JSON.stringify({ method: "initialized", params: {} }));
            }
            this.ready = true;
            this.connecting = null;
            resolve();
          })
          .catch(fail);
      });

      this.upstream.on("message", (data) => this.handleMessage(data));
      this.upstream.on("error", fail);
      this.upstream.on("close", () => this.reset(new Error("Codex app-server connection closed")));
    });

    return this.connecting;
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
        reject(new Error("Codex app-server connection is not open"));
        return;
      }
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 8000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.upstream.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(data) {
    const msg = JSON.parse(data.toString());
    if (!msg.id || !this.pending.has(msg.id)) return;
    const pending = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else pending.resolve(msg.result);
  }

  reset(error) {
    this.ready = false;
    this.connecting = null;
    this.upstream = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const appServerClient = new AppServerRpcClient();

function startCodexServer() {
  const child = spawn(codexBin, ["app-server", "--listen", codexUrl], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, "node_modules", ".bin")}:${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[codex] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[codex] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.error(`[codex] exited code=${code} signal=${signal}`);
  });
  process.on("SIGINT", () => {
    child.kill("SIGINT");
    process.exit(0);
  });
  return child;
}

function appServerRequest(method, params) {
  return appServerClient.request(method, params);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function requireToken(url, phoneToken, res) {
  if (url.searchParams.get("token") === phoneToken) return true;
  sendJson(res, 401, { error: "invalid token" });
  return false;
}

function safeRelativePath(input) {
  const raw = String(input || "");
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw.replace(/^[/\\]+/, ""));
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) return null;
  return target;
}

function safeUploadPath(input) {
  const clean = String(input || "").replace(/^[/\\]+/, "");
  const target = path.resolve(uploadDir, clean);
  if (!target.startsWith(`${uploadDir}${path.sep}`) && target !== uploadDir) return null;
  return target;
}

function mimeForPath(filePath) {
  return imageExtensions.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function isImagePath(filePath) {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

function isMissingThreadError(error) {
  return /no rollout found for thread id/i.test(error?.message || "");
}

function isAudioUpload(name, mime) {
  return String(mime || "").startsWith("audio/") || /\.(m4a|mp3|wav|aac|flac|ogg|webm|mp4)$/i.test(String(name || ""));
}

function createUploadRecord(originalName, mime) {
  const cleanMime = String(mime || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
  const sourceName = String(originalName || "upload");
  const originalExtension = path.extname(sourceName).replace(/[^a-z0-9.]/gi, "").slice(0, 12);
  const isImage = cleanMime.startsWith("image/");
  const isAudio = isAudioUpload(sourceName, cleanMime);
  if (!isImage && !isAudio) throw new Error("Unsupported attachment type");

  fs.mkdirSync(uploadDir, { recursive: true });
  const extension = originalExtension || `.${cleanMime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || (isImage ? "png" : "dat")}`;
  const safeName = sourceName
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
  const nameWithExtension = path.extname(safeName) ? safeName : `${safeName || (isImage ? "image" : "audio")}${extension}`;
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${nameWithExtension}`;
  const target = path.join(uploadDir, fileName);
  return uploadRecordForTarget(target, sourceName, cleanMime);
}

function uploadRecordForTarget(target, originalName, mime) {
  const fileName = path.basename(target);
  const cleanMime = String(mime || mimeForPath(target) || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
  const isImage = cleanMime.startsWith("image/") || isImagePath(target);
  const isAudio = isAudioUpload(originalName || fileName, cleanMime);
  if (!isImage && !isAudio) return null;
  return {
    input: isImage ? { type: "localImage", path: target } : null,
    preview: {
      name: originalName || fileName,
      path: fileName,
      absolutePath: target,
      kind: isImage ? "image" : "audio",
      mimeType: cleanMime,
      url: isImage ? `/api/uploaded?name=${encodeURIComponent(fileName)}` : null,
    },
  };
}

function uploadedAttachmentRecord(attachment) {
  const absolute = String(attachment.absolutePath || "").trim();
  const target = absolute ? path.resolve(absolute) : safeUploadPath(attachment.path);
  if (!target || (!target.startsWith(`${uploadDir}${path.sep}`) && target !== uploadDir)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return uploadRecordForTarget(target, attachment.name || path.basename(target), attachment.mimeType || attachment.type);
}

function errorWithStatus(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function writeUploadStream(req, target) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const out = fs.createWriteStream(target, { mode: 0o600 });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rm(target, { force: true }, () => reject(error));
    };

    req.on("data", (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxUploadBytes) {
        req.pause();
        fail(errorWithStatus(`Attachment is too large. Limit is ${Math.round(maxUploadBytes / 1024 / 1024)}MB.`, 413));
        req.resume();
      }
    });
    req.on("aborted", () => fail(errorWithStatus("Upload was aborted", 400)));
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });
    req.pipe(out);
  });
}

function discoverArtifacts() {
  const files = ["README.md", "AGENTS.md"];
  const assetsDir = path.join(root, "docs", "assets");
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir).sort()) {
      const relative = path.join("docs", "assets", name);
      const full = path.join(root, relative);
      if (fs.statSync(full).isFile() && (isImagePath(full) || /\.md(?:own)?$/i.test(name))) files.push(relative);
    }
  }
  return files.map((file) => ({
    path: file,
    name: path.basename(file),
    kind: isImagePath(file) ? "image" : /\.md(?:own)?$/i.test(file) ? "markdown" : "file",
  }));
}

function readAutomations() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const automationsDir = path.join(home, "automations");
  if (!fs.existsSync(automationsDir)) return [];
  return fs
    .readdirSync(automationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const automationToml = path.join(automationsDir, entry.name, "automation.toml");
      const raw = fs.existsSync(automationToml) ? fs.readFileSync(automationToml, "utf8") : "";
      const name = raw.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || entry.name;
      const status = raw.match(/^status\s*=\s*"([^"]+)"/m)?.[1] || "UNKNOWN";
      return { id: entry.name, name, status };
    });
}

function saveDataUrlAttachment(attachment) {
  const uploaded = uploadedAttachmentRecord(attachment);
  if (uploaded) return uploaded;
  const match = String(attachment.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > maxUploadBytes) throw errorWithStatus(`Attachment is too large. Limit is ${Math.round(maxUploadBytes / 1024 / 1024)}MB.`, 413);
  const record = createUploadRecord(attachment.name || "upload", mime);
  fs.writeFileSync(record.preview.absolutePath, buffer, { mode: 0o600 });
  return record;
}

function sandboxPolicyForMode(mode) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: true };
  return {
    type: "workspaceWrite",
    writableRoots: [workdir],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function serveIndex(req, res, { includeManifest = true } = {}) {
  const indexPath = path.join(root, "public", "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  if (!includeManifest) {
    html = html.replace(/\n\s*<link rel="manifest" href="site\.webmanifest" \/>/, "");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (requestPath === "/") {
    serveIndex(req, res);
    return;
  }
  const file = requestPath.slice(1);
  const target = path.join(root, "public", file);
  if (!target.startsWith(path.join(root, "public")) || !fs.existsSync(target)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const type = staticMimeTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  fs.createReadStream(target).pipe(res);
}

function serveManifest(url, phoneToken, res) {
  const manifestPath = path.join(root, "public", "site.webmanifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const basePath = String(url.searchParams.get("base") || "");
  const safeBasePath = /^\/(?:abs)?proxy\/\d+$/.test(basePath) ? basePath : "";
  if (safeBasePath) {
    manifest.id = `${safeBasePath}/codex-remote`;
    manifest.scope = `${safeBasePath}/`;
  }
  if (url.searchParams.get("token") === phoneToken) {
    manifest.start_url = `${safeBasePath}/?token=${encodeURIComponent(phoneToken)}`;
  }
  res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(manifest, null, 2));
}

function stripUiDirectives(text) {
  return String(text || "")
    .replace(/(?:^|\n)::[a-z0-9-]+\{[^\n]*\}(?=\n|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeItem(item) {
  if (item.type === "userMessage") {
    const textParts = [];
    const attachments = [];
    for (const part of item.content) {
      if (part.type === "text") {
        textParts.push(part.text);
        continue;
      }
      if (part.type === "localImage" && part.path) {
        const absolutePath = path.resolve(part.path);
        if (absolutePath.startsWith(`${uploadDir}${path.sep}`)) {
          attachments.push({
            name: path.basename(absolutePath),
            url: `/api/uploaded?name=${encodeURIComponent(path.basename(absolutePath))}`,
          });
        } else if (absolutePath.startsWith(`${root}${path.sep}`) && isImagePath(absolutePath)) {
          const relative = path.relative(root, absolutePath);
          attachments.push({ name: path.basename(absolutePath), url: `/api/file/raw?path=${encodeURIComponent(relative)}` });
        }
      }
    }
    return {
      type: "user",
      text: textParts.join("\n") || (attachments.length ? "添付画像" : ""),
      attachments,
    };
  }
  if (item.type === "agentMessage") return { type: "assistant", text: stripUiDirectives(item.text) };
  if (item.type === "commandExecution") return { type: "status", text: `$ ${item.command}` };
  if (item.type === "fileChange") return { type: "status", text: `file changes: ${item.status}` };
  return null;
}

function summarizeLiveItem(item, phase = "completed") {
  if (!item) return null;
  if (item.type === "commandExecution") {
    return phase === "started" ? `$ ${item.command}` : null;
  }
  if (item.type === "fileChange") {
    return `file changes: ${item.status}`;
  }
  return null;
}

function historyFromThread(thread) {
  const history = [];
  for (const [turnIndex, turn] of (thread.turns || []).entries()) {
    const outputGroup = turn.id || `turn-${turnIndex}`;
    for (const item of turn.items || []) {
      const entry = summarizeItem(item);
      if (entry && entry.text) history.push({ ...entry, outputGroup });
    }
  }
  return capHistory(history);
}

function capHistory(history) {
  return history.slice(-historyLimit);
}

class SharedBridge {
  constructor(requestedThreadId, bridgeKey) {
    this.requestedThreadId = requestedThreadId;
    this.bridgeKey = bridgeKey;
    this.clients = new Set();
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = null;
    this.activeTurnId = null;
    this.ready = false;
    this.history = [];
    this.turnQueue = [];
    this.upstream = createUpstreamWebSocket();
    this.bindUpstream();
  }

  addClient(browser) {
    this.clients.add(browser);
    this.emitTo(browser, "status", { text: "共有Codexブリッジに参加しました。" });
    if (this.ready) {
      this.emitTo(browser, "ready", this.readyPayload());
    }
    browser.on("close", () => {
      this.clients.delete(browser);
      if (shouldDisposeIdleBridge({ clientCount: this.clients.size, ready: this.ready })) {
        this.upstream.close();
        bridges.delete(this.bridgeKey);
      }
    });
  }

  readyPayload() {
    return {
      provider: agentProvider,
      threadId: this.threadId,
      model,
      workdir,
      shared: true,
      clients: this.clients.size,
      history: this.history,
    };
  }

  emit(type, payload = {}) {
    const body = JSON.stringify({ type, ...payload });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    }
  }

  emitTo(client, type, payload = {}) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type, ...payload }));
  }

  request(method, params) {
    const id = this.nextId++;
    this.upstream.send(JSON.stringify({ id, method, params }));
    return id;
  }

  hasPendingTurnStart() {
    return Array.from(this.pending.values()).includes("turn/start");
  }

  promoteBridgeKey() {
    if (!shouldPromoteBridgeKey({ bridgeKey: this.bridgeKey, threadId: this.threadId })) return;
    const previousKey = this.bridgeKey;
    if (bridges.has(this.threadId) && bridges.get(this.threadId) !== this) return;
    if (bridges.get(previousKey) !== this) return;
    this.bridgeKey = this.threadId;
    bridges.delete(previousKey);
    bridges.set(this.bridgeKey, this);
  }

  requestNewThread(statusText = "新しいthreadを開始中...") {
    const id = this.request("thread/start", {
      model,
      cwd: workdir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    this.pending.set(id, "thread/start");
    this.emit("status", { text: statusText });
  }

  fallbackToNewThread(error) {
    this.emit("status", { text: `既存threadが見つからないため新しいthreadを開始します: ${error.message}` });
    this.requestedThreadId = null;
    const previousKey = this.bridgeKey;
    if (bridges.get(previousKey) === this) bridges.delete(previousKey);
    this.bridgeKey = `new:${crypto.randomUUID()}`;
    bridges.set(this.bridgeKey, this);
    this.requestNewThread("新しいthreadを開始中...");
  }

  bindUpstream() {
    this.upstream.on("open", () => {
      this.request("initialize", {
        clientInfo: { name: "codex-phone-bridge", title: "Codex Phone Bridge", version: "0.1.0" },
      });
      this.upstream.send(JSON.stringify({ method: "initialized", params: {} }));
      if (!this.requestedThreadId) {
        this.requestNewThread();
        return;
      }
      const id = this.request("thread/resume", {
        threadId: this.requestedThreadId,
        model,
        cwd: workdir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      this.pending.set(id, "thread/resume");
      this.emit("status", { text: "既存threadを再開中..." });
    });

    this.upstream.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const pendingMethod = this.pending.get(msg.id);

      if (pendingMethod === "thread/start" || pendingMethod === "thread/resume") {
        this.pending.delete(msg.id);
        if (msg.error) {
          const error = new Error(msg.error.message || JSON.stringify(msg.error));
          if (pendingMethod === "thread/resume" && isMissingThreadError(error)) {
            this.fallbackToNewThread(error);
            return;
          }
          this.emit("error", { text: msg.error.message || JSON.stringify(msg.error) });
          return;
        }
        this.threadId = msg.result.thread.id;
        this.promoteBridgeKey();
        this.ready = true;
        this.history = historyFromThread(msg.result.thread);
        this.emit("ready", this.readyPayload());
        if (this.requestedThreadId) this.emit("status", { text: `既存threadを再開しました: ${this.threadId}` });
        return;
      }

      if (pendingMethod === "turn/start") {
        this.pending.delete(msg.id);
        if (msg.error) {
          this.emit("error", { text: msg.error.message || JSON.stringify(msg.error) });
          this.startNextQueuedTurn();
        } else {
          this.activeTurnId = msg.result.turn.id;
          this.emit("turn", { status: "started", turnId: this.activeTurnId });
        }
        return;
      }

      if (msg.method === "item/agentMessage/delta") {
        this.emit("assistantDelta", { text: msg.params.delta });
        return;
      }

      if (msg.method === "item/started") {
        const text = summarizeLiveItem(msg.params.item, "started");
        if (text) this.emit("status", { text });
        return;
      }

      if (msg.method === "item/completed") {
        const entry = summarizeItem(msg.params.item);
        if (entry && entry.type !== "user") this.appendHistory({ ...entry, outputGroup: this.activeTurnId || null });
        const text = summarizeLiveItem(msg.params.item, "completed");
        if (text) this.emit("status", { text });
        this.emit("event", { event: msg });
        return;
      }

      if (msg.method === "turn/completed") {
        this.activeTurnId = null;
        this.emit("turn", { status: "completed", turnId: msg.params.turnId });
        this.syncHistory("turn completed");
        this.startNextQueuedTurn();
        return;
      }

      if (msg.method && msg.method.endsWith("/requestApproval")) {
        this.emit("approval", { request: msg });
        return;
      }

      if (msg.method === "error") {
        this.emit("error", { text: msg.params.message || JSON.stringify(msg.params) });
        return;
      }

      this.emit("event", { event: msg });
    });

    this.upstream.on("error", (error) => this.emit("error", { text: error.message }));
    this.upstream.on("close", () => this.emit("status", { text: "Codex接続が閉じました" }));
  }

  prompt(text, attachments = [], options = {}) {
    if (!this.threadId) {
      this.emit("error", { text: "Thread is not ready yet" });
      return;
    }
    if (this.activeTurnId || this.hasPendingTurnStart()) {
      this.turnQueue.push({ text, attachments, options });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
    }
  }

  startNextQueuedTurn() {
    if (!this.ready || this.activeTurnId || this.hasPendingTurnStart() || !this.turnQueue.length) return;
    const next = this.turnQueue.shift();
    this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
    try {
      this.startPrompt(next.text, next.attachments, next.options);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
      this.startNextQueuedTurn();
    }
  }

  syncHistory(reason) {
    if (!this.threadId || !historySyncEnabled) return;
    runHistorySync({
      threadId: this.threadId,
      workdir,
      request: appServerRequest,
      enabled: historySyncEnabled,
    })
      .then((result) => {
        if (!result.skipped) this.emit("status", { text: `履歴同期を更新しました (${reason})` });
      })
      .catch((error) => {
        this.emit("status", { text: `履歴同期に失敗しました: ${error.message}` });
      });
  }

  startPrompt(text, attachments = [], options = {}) {
    const input = [{ type: "text", text, text_elements: [] }];
    const savedImages = [];
    const savedFiles = [];
    for (const attachment of attachments || []) {
      const saved = saveDataUrlAttachment(attachment);
      if (saved) {
        if (saved.input) {
          input.push(saved.input);
          savedImages.push(saved.preview);
        } else {
          savedFiles.push(saved.preview);
        }
      }
    }
    if (savedFiles.length) {
      input[0].text = `${text}\n\n添付ファイルはMac側に保存済みです。必要ならこのパスを読み取って処理してください:\n${savedFiles
        .map((file) => `- ${file.name}: ${file.absolutePath}`)
        .join("\n")}`;
    }
    const params = {
      threadId: this.threadId,
      input,
    };
    if (options.model) params.model = options.model;
    if (options.approvalPolicy) params.approvalPolicy = options.approvalPolicy;
    if (options.sandboxMode) params.sandboxPolicy = sandboxPolicyForMode(options.sandboxMode);
    const id = this.request("turn/start", {
      ...params,
    });
    this.pending.set(id, "turn/start");
    const savedAttachments = [...savedImages, ...savedFiles];
    const displayText = savedAttachments.length ? `${text}\n\n添付: ${savedAttachments.map((file) => file.name).join(", ")}` : text;
    this.appendHistory({ type: "user", text: displayText, attachments: savedImages });
    this.emit("user", { text: displayText, attachments: savedImages });
  }

  appendHistory(entry) {
    this.history.push(entry);
    this.history = capHistory(this.history);
  }

  approval(requestMsg, decision) {
    if (!requestMsg || !requestMsg.id || !requestMsg.method) return;
    const accept = decision === "accept";
    let result;
    if (requestMsg.method === "item/commandExecution/requestApproval") {
      result = { decision: accept ? "accept" : "decline" };
    } else if (requestMsg.method === "item/fileChange/requestApproval") {
      result = { decision: accept ? "accept" : "decline" };
    } else {
      result = accept ? { decision: "accept" } : { decision: "decline" };
    }
    this.upstream.send(JSON.stringify({ id: requestMsg.id, result }));
    this.emit("status", { text: accept ? "承認しました" : "拒否しました" });
  }
}

function claudePermissionMode(options = {}) {
  if (options.permissionMode) return options.permissionMode;
  if (options.sandboxMode === "danger-full-access" || options.approvalPolicy === "never") return "bypassPermissions";
  if (options.sandboxMode === "read-only") return "plan";
  return process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";
}

function summarizeClaudeAttachmentPrompt(text, savedAttachments) {
  if (!savedAttachments.length) return text;
  const lines = savedAttachments.map((file) => `- ${file.name}: ${file.absolutePath}`);
  return `${text || "添付ファイルを確認してください。"}\n\n添付ファイルはMac側に保存済みです。必要ならこのパスを読み取って処理してください:\n${lines.join("\n")}`;
}

class ClaudeBridge {
  constructor(requestedThreadId, bridgeKey) {
    this.requestedThreadId = requestedThreadId;
    this.bridgeKey = bridgeKey;
    this.clients = new Set();
    this.threadId = requestedThreadId || `claude:${crypto.randomUUID()}`;
    this.claudeSessionId = requestedThreadId && !requestedThreadId.startsWith("claude:") ? requestedThreadId : null;
    this.activeTurnId = null;
    this.ready = true;
    this.history = [];
    this.turnQueue = [];
    this.activeProcess = null;
  }

  addClient(browser) {
    this.clients.add(browser);
    this.emitTo(browser, "status", { text: "共有Claudeブリッジに参加しました。" });
    this.emitTo(browser, "ready", this.readyPayload());
    browser.on("close", () => {
      this.clients.delete(browser);
      if (shouldDisposeIdleBridge({ clientCount: this.clients.size, ready: this.ready })) {
        bridges.delete(this.bridgeKey);
      }
    });
  }

  readyPayload() {
    return {
      provider: agentProvider,
      threadId: this.threadId,
      model,
      workdir,
      shared: true,
      clients: this.clients.size,
      history: this.history,
    };
  }

  emit(type, payload = {}) {
    const body = JSON.stringify({ type, ...payload });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    }
  }

  emitTo(client, type, payload = {}) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type, ...payload }));
  }

  promoteBridgeKey() {
    if (!this.claudeSessionId || this.bridgeKey === this.claudeSessionId) return;
    const previousKey = this.bridgeKey;
    if (bridges.has(this.claudeSessionId) && bridges.get(this.claudeSessionId) !== this) return;
    if (bridges.get(previousKey) !== this) return;
    this.threadId = this.claudeSessionId;
    this.bridgeKey = this.claudeSessionId;
    bridges.delete(previousKey);
    bridges.set(this.bridgeKey, this);
    this.emit("ready", this.readyPayload());
  }

  prompt(text, attachments = [], options = {}) {
    if (this.activeTurnId || this.activeProcess) {
      this.turnQueue.push({ text, attachments, options });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
    }
  }

  startNextQueuedTurn() {
    if (this.activeTurnId || this.activeProcess || !this.turnQueue.length) return;
    const next = this.turnQueue.shift();
    this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
    this.startPrompt(next.text, next.attachments, next.options);
  }

  startPrompt(text, attachments = [], options = {}) {
    const savedAttachments = [];
    const savedImages = [];
    for (const attachment of attachments || []) {
      const saved = saveDataUrlAttachment(attachment);
      if (!saved) continue;
      savedAttachments.push(saved.preview);
      if (saved.preview.kind === "image") savedImages.push(saved.preview);
    }

    const promptText = summarizeClaudeAttachmentPrompt(text, savedAttachments);
    const displayText = savedAttachments.length ? `${text || "添付ファイルを確認してください。"}\n\n添付: ${savedAttachments.map((file) => file.name).join(", ")}` : text;
    const turnId = `claude-turn:${crypto.randomUUID()}`;
    this.activeTurnId = turnId;
    this.appendHistory({ type: "user", text: displayText, attachments: savedImages });
    this.emit("user", { text: displayText, attachments: savedImages });
    this.emit("turn", { status: "started", turnId });

    const args = [
      "-p",
      promptText,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      options.model || model,
      "--permission-mode",
      claudePermissionMode(options),
    ];
    if (this.claudeSessionId) args.push("--resume", this.claudeSessionId);

    const child = spawn(claudeBin, args, {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeProcess = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let assistantText = "";

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("status", { text: line.slice(0, 500) });
        return;
      }
      if (msg.session_id) {
        this.claudeSessionId = msg.session_id;
        this.promoteBridgeKey();
      }
      if (msg.type === "system" && msg.subtype === "init") {
        this.emit("status", { text: `Claude session ready: ${msg.session_id || this.threadId}` });
        return;
      }
      if (msg.type === "system" && msg.subtype === "api_retry") {
        this.emit("status", { text: `Claude API retry ${msg.attempt}/${msg.max_retries}` });
        return;
      }
      const delta = msg.type === "stream_event" && msg.event?.delta?.type === "text_delta" ? msg.event.delta.text : "";
      if (delta) {
        assistantText += delta;
        this.emit("assistantDelta", { text: delta });
        return;
      }
      if (msg.type === "result") {
        if (msg.session_id) {
          this.claudeSessionId = msg.session_id;
          this.promoteBridgeKey();
        }
        if (!assistantText && msg.result) {
          assistantText = String(msg.result);
          this.emit("assistantDelta", { text: assistantText });
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this.emit("status", { text: line.slice(0, 500) });
      }
    });
    child.on("error", (error) => {
      this.emit("error", { text: `Claudeを起動できませんでした: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      this.activeProcess = null;
      this.activeTurnId = null;
      if (code === 0) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        this.emit("turn", { status: "completed", turnId });
      } else {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        this.emit("error", { text: `Claude process exited (${reason})${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-1000)}` : ""}` });
      }
      this.startNextQueuedTurn();
    });
  }

  appendHistory(entry) {
    this.history.push(entry);
    this.history = capHistory(this.history);
  }

  approval(_requestMsg, _decision) {
    this.emit("status", { text: "Claude headless providerでは実行中の承認応答は未対応です。" });
  }
}

function getBridge(threadId, connectionId = crypto.randomUUID()) {
  if (!threadId) {
    for (const bridge of bridges.values()) {
      if (!bridge.requestedThreadId) return bridge;
    }
  }
  const key = bridgeKeyForRequest(threadId, connectionId);
  if (!bridges.has(key)) bridges.set(key, isClaudeProvider ? new ClaudeBridge(threadId, key) : new SharedBridge(threadId, key));
  return bridges.get(key);
}

function bindBrowser(browser, phoneToken, threadId) {
  const bridge = getBridge(threadId);
  bridge.addClient(browser);

  browser.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (error) {
      bridge.emitTo(browser, "error", { text: `Invalid browser message: ${error.message}` });
      return;
    }
    if (msg.token !== phoneToken) {
      bridge.emitTo(browser, "error", { text: "Invalid token" });
      browser.close();
      return;
    }
    if (msg.type === "prompt") bridge.prompt(msg.text, msg.attachments, msg.options);
    if (msg.type === "approval") bridge.approval(msg.request, msg.decision);
  });
}

function bridgeSummaries() {
  return Array.from(bridges.values()).map((bridge) => ({
    threadId: bridge.threadId,
    clients: bridge.clients.size,
    ready: bridge.ready,
    provider: agentProvider,
  }));
}

function localThreadList() {
  return Array.from(bridges.values()).map((bridge) => {
    const userEntry = [...bridge.history].reverse().find((entry) => entry.type === "user");
    const preview = userEntry?.text || bridge.threadId;
    const updatedAt = Date.now();
    return {
      id: bridge.threadId,
      name: preview.split("\n").find(Boolean) || bridge.threadId,
      preview,
      cwd: workdir,
      provider: agentProvider,
      updatedAt,
      updated_at: updatedAt,
    };
  });
}

function findBridgeByThreadId(threadId) {
  return Array.from(bridges.values()).find((bridge) => bridge.threadId === threadId || bridge.bridgeKey === threadId);
}

function localModelList() {
  return {
    data: modelOptions.map((item) => ({
      id: item,
      model: item,
      displayName: item,
    })),
  };
}

async function main() {
  const phoneToken = getToken();
  const codex = shouldStartCodexServer ? startCodexServer() : null;
  if (isCodexProvider) {
    if (shouldStartCodexServer) {
      await waitForReady();
    } else {
      await appServerRequest("thread/loaded/list", { cursor: null, limit: 1 });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/info") {
      sendJson(res, 200, {
        provider: agentProvider,
        model,
        workdir,
        codexUrl: isCodexProvider ? codexUrl : null,
        codexSocketPath: isCodexProvider ? codexSocketPath || null : null,
        managedCodexServer: shouldStartCodexServer,
        tokenRequired: true,
      });
      return;
    }
    if (url.pathname === "/site.webmanifest") {
      serveManifest(url, phoneToken, res);
      return;
    }
    if (url.pathname === "/bookmark") {
      serveIndex(req, res, { includeManifest: false });
      return;
    }
    if (url.pathname === "/api/threads") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = normalizeProvider(url.searchParams.get("provider") || agentProvider);
      if (requestedProvider !== agentProvider) {
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, data: [] });
        return;
      }
      if (requestedProvider === "claude") {
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, data: localThreadList() });
        return;
      }
      try {
        const result = await appServerRequest("thread/list", {
          limit: 30,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          useStateDbOnly: false,
        });
        const data = Array.isArray(result.data)
          ? result.data.map((thread) => ({ ...thread, provider: requestedProvider }))
          : result.data;
        sendJson(res, 200, { ...result, provider: requestedProvider, activeProvider: agentProvider, data });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/models") {
      if (!requireToken(url, phoneToken, res)) return;
      if (isClaudeProvider) {
        sendJson(res, 200, localModelList());
        return;
      }
      try {
        const result = await appServerRequest("model/list", { limit: 80, includeHidden: false });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/plugins") {
      if (!requireToken(url, phoneToken, res)) return;
      if (isClaudeProvider) {
        sendJson(res, 200, { data: [] });
        return;
      }
      try {
        const result = await appServerRequest("plugin/list", { cwds: [workdir] });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/config") {
      if (!requireToken(url, phoneToken, res)) return;
      if (isClaudeProvider) {
        sendJson(res, 200, {
          config: { config: { model, cwd: workdir, provider: agentProvider } },
          auth: null,
          errors: [],
        });
        return;
      }
      try {
        const [config, auth] = await Promise.allSettled([
          appServerRequest("config/read", { includeLayers: false, cwd: workdir }),
          appServerRequest("getAuthStatus", {}),
        ]);
        sendJson(res, 200, {
          config: config.status === "fulfilled" ? config.value : null,
          auth: auth.status === "fulfilled" ? auth.value : null,
          errors: [config, auth]
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason.message),
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/workspaces") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method === "GET") {
        sendJson(res, 200, { data: workspaceOptions() });
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const target = rememberWorkspace(body.path || body.workdir);
          sendJson(res, 200, {
            ok: true,
            workspace: workspaceOptionFor(target, "最近使ったフォルダ"),
            options: workspaceOptions(),
          });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/local-settings") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method === "GET") {
        sendJson(res, 200, localSettingsPayload());
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const updates = {};
          const requestedProvider = Object.prototype.hasOwnProperty.call(body, "provider") ? normalizeProvider(body.provider) : agentProvider;
          if (Object.prototype.hasOwnProperty.call(body, "provider")) updates.PHONE_AGENT_PROVIDER = requestedProvider;
          if (Object.prototype.hasOwnProperty.call(body, "model")) updates[modelEnvKeyForProvider(requestedProvider)] = validateModel(body.model);
          if (Object.prototype.hasOwnProperty.call(body, "workdir")) updates[workdirEnvKeyForProvider(requestedProvider)] = rememberWorkspace(body.workdir);
          if (requestedProvider === "codex" && Object.prototype.hasOwnProperty.call(body, "historySyncEnabled")) {
            updates.CODEX_HISTORY_SYNC = body.historySyncEnabled ? "1" : "0";
          }
          writeEnvValues(updates);
          sendJson(res, 200, { ok: true, ...localSettingsPayload() });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/upload") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > maxUploadBytes) {
        req.resume();
        sendJson(res, 413, { error: `Attachment is too large. Limit is ${Math.round(maxUploadBytes / 1024 / 1024)}MB.` });
        return;
      }
      try {
        const originalName = decodeURIComponent(String(req.headers["x-file-name"] || url.searchParams.get("name") || "upload"));
        const mime = String(req.headers["content-type"] || "application/octet-stream");
        const record = createUploadRecord(originalName, mime);
        const size = await writeUploadStream(req, record.preview.absolutePath);
        sendJson(res, 200, { ok: true, attachment: { ...record.preview, size } });
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/restart") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      sendJson(res, 200, { ok: true, message: "Restarting phone bridge" });
      setTimeout(() => {
        if (codex) codex.kill("SIGINT");
        process.exit(42);
      }, 200);
      return;
    }
    if (url.pathname === "/api/status") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, {
        provider: agentProvider,
        workdir,
        model,
        codexUrl: isCodexProvider ? codexUrl : null,
        codexSocketPath: isCodexProvider ? codexSocketPath || null : null,
        managedCodexServer: shouldStartCodexServer,
        historySyncEnabled,
        uiPort,
        codexPort,
        bridges: bridgeSummaries(),
      });
      return;
    }
    if (url.pathname === "/api/history-sync") {
      if (!requireToken(url, phoneToken, res)) return;
      if (isClaudeProvider) {
        sendJson(res, 200, { skipped: true, reason: "history sync is only available for the Codex provider" });
        return;
      }
      const threadId = url.searchParams.get("thread");
      if (!threadId) {
        sendJson(res, 400, { error: "thread is required" });
        return;
      }
      try {
        const result = await runHistorySync({
          threadId,
          workdir,
          request: appServerRequest,
          enabled: historySyncEnabled,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/thread") {
      if (!requireToken(url, phoneToken, res)) return;
      const threadId = url.searchParams.get("thread");
      const requestedProvider = normalizeProvider(url.searchParams.get("provider") || agentProvider);
      if (!threadId) {
        sendJson(res, 400, { error: "thread is required" });
        return;
      }
      if (requestedProvider !== agentProvider) {
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, threadId, history: [] });
        return;
      }
      if (requestedProvider === "claude") {
        const bridge = findBridgeByThreadId(threadId);
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, threadId, history: bridge?.history || [] });
        return;
      }
      try {
        let thread;
        try {
          const result = await appServerRequest("thread/read", {
            threadId,
            includeTurns: true,
          });
          thread = result.thread || result;
        } catch (readError) {
          const result = await appServerRequest("thread/resume", {
            threadId,
            model,
            cwd: workdir,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
          });
          thread = result.thread;
        }
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, threadId: thread.id || threadId, history: historyFromThread(thread) });
      } catch (error) {
        if (isMissingThreadError(error)) {
          sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, threadId, history: [] });
          return;
        }
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/automations") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, { data: readAutomations() });
      return;
    }
    if (url.pathname === "/api/artifacts") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, { data: discoverArtifacts() });
      return;
    }
    if (url.pathname === "/api/uploaded") {
      if (!requireToken(url, phoneToken, res)) return;
      const target = safeUploadPath(url.searchParams.get("name"));
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile() || !isImagePath(target)) {
        sendJson(res, 404, { error: "image not found" });
        return;
      }
      res.writeHead(200, { "content-type": mimeForPath(target), "cache-control": "no-store" });
      fs.createReadStream(target).pipe(res);
      return;
    }
    if (url.pathname === "/api/file/raw") {
      if (!requireToken(url, phoneToken, res)) return;
      const target = safeRelativePath(url.searchParams.get("path"));
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile() || !isImagePath(target)) {
        sendJson(res, 404, { error: "image not found" });
        return;
      }
      res.writeHead(200, { "content-type": mimeForPath(target), "cache-control": "no-store" });
      fs.createReadStream(target).pipe(res);
      return;
    }
    if (url.pathname === "/api/file") {
      if (!requireToken(url, phoneToken, res)) return;
      const target = safeRelativePath(url.searchParams.get("path"));
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      if (isImagePath(target)) {
        sendJson(res, 200, {
          path: path.relative(root, target),
          kind: "image",
          mimeType: mimeForPath(target),
          imageUrl: `/api/file/raw?path=${encodeURIComponent(path.relative(root, target))}`,
        });
        return;
      }
      sendJson(res, 200, {
        path: path.relative(root, target),
        kind: /\.md(?:own)?$/i.test(target) ? "markdown" : "text",
        text: fs.readFileSync(target, "utf8").slice(0, 80_000),
      });
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocket.Server({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/bridge") {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("token") !== phoneToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const threadId = url.searchParams.get("thread") || null;
    wss.handleUpgrade(req, socket, head, (ws) => bindBrowser(ws, phoneToken, threadId));
  });

  server.listen(uiPort, uiHost, () => {
    const advertisedAddresses = uiHost === "0.0.0.0" ? lanAddresses() : [uiHost];
    const urls = bridgeUrls(advertisedAddresses, uiPort, phoneToken);
    console.log("");
    console.log("Codex shared browser bridge is ready.");
    for (const url of urls) console.log(`  ${url}`);
    console.log("");
    console.log(`Workdir: ${workdir}`);
    console.log(`Provider: ${agentProvider}`);
    console.log(`Model:   ${model}`);
    console.log(`Bridge:  ${uiHost}:${uiPort}`);
    if (isCodexProvider) console.log(`Codex:   ${shouldStartCodexServer ? codexUrl : codexSocketPath || codexUrl}`);
    else console.log(`Claude:  ${claudeBin}`);
    console.log("Open the same URL from PC and phone to share one bridge thread.");
    console.log("Press Ctrl+C to stop.");

    notifyBridgeUrls(urls).then((results) => {
      for (const result of results) {
        if (result.ok) console.log(`[notify] sent via ${result.type}`);
        else console.warn(`[notify] ${result.type} failed: ${result.error}`);
      }
    });
  });

  process.on("exit", () => {
    if (codex) codex.kill("SIGINT");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
