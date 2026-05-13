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
const { bridgeUrls, notifyBridgeUrls, notifyTaskEvent } = require("./phone-notify");
const { findLiveBridge, readThreadSnapshot } = require("./thread-read");

const root = path.resolve(__dirname, "..");

function normalizeProvider(input) {
  const value = String(input || "codex").trim().toLowerCase();
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported PHONE_AGENT_PROVIDER: ${value}`);
}

function appIdSlug(input, fallback) {
  const value = String(input || fallback || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || "phone-bridge";
}

function defaultAppNameForProvider(provider) {
  return provider === "claude" ? "Claude Remote" : "Codex Remote";
}

function defaultAppShortNameForProvider(provider) {
  return provider === "claude" ? "Claude" : "Codex";
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

const launchEnvKeys = new Set(Object.keys(process.env));
loadEnvFile(path.join(root, ".env"));

function hasLaunchEnv(key) {
  return launchEnvKeys.has(key);
}

function uploadLimitBytes() {
  const mb = Number(process.env.PHONE_MAX_UPLOAD_MB || 256);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
}

function sanitizeRateLimitWindow(item) {
  const label = String(item?.label || item?.window || item?.name || "").trim();
  const resetsAt = String(item?.resetsAt || item?.resetAt || item?.reset || "").trim();
  const remainingPercent = Number(item?.remainingPercent ?? item?.remaining ?? item?.percent);
  if (!label && !resetsAt && !Number.isFinite(remainingPercent)) return null;
  return {
    label: label || "制限",
    remainingPercent: Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, Math.round(remainingPercent))) : null,
    resetsAt,
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatRateLimitResetAt(value) {
  const numeric = numberOrNull(value);
  let date = null;
  if (numeric !== null) {
    date = new Date((numeric > 1_000_000_000_000 ? numeric : numeric * 1000));
  } else if (value) {
    date = new Date(value);
  }
  if (!date || !Number.isFinite(date.getTime())) return "";
  const locale = process.env.PHONE_RATE_LIMIT_LOCALE || "ja-JP";
  const now = new Date();
  if (sameLocalDay(date, now)) return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function claudeRateLimitLabel(type, fallback = "制限") {
  const value = String(type || "").trim();
  if (value === "five_hour") return "5時間";
  if (value === "seven_day") return "週あたり";
  if (value === "seven_day_opus") return "週あたり Opus";
  if (value === "seven_day_sonnet") return "週あたり Sonnet";
  if (value === "overage") return "追加利用";
  return fallback;
}

function remainingFromUsedPercent(value) {
  const used = numberOrNull(value);
  return used === null ? null : clampPercent(100 - used);
}

function remainingFromUtilization(value) {
  const utilization = numberOrNull(value);
  if (utilization === null) return null;
  const usedPercent = utilization <= 1 ? utilization * 100 : utilization;
  return clampPercent(100 - usedPercent);
}

function claudeStatusLineWindow(rateLimits, type) {
  const camelType = type.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
  const item = rateLimits?.[type] || rateLimits?.[camelType];
  if (!item || typeof item !== "object") return null;
  return sanitizeRateLimitWindow({
    label: claudeRateLimitLabel(type),
    remainingPercent: remainingFromUsedPercent(item.used_percentage ?? item.usedPercentage),
    resetsAt: formatRateLimitResetAt(item.resets_at ?? item.resetsAt),
  });
}

function claudeEventWindow(info) {
  if (!info || typeof info !== "object") return null;
  const type = info.rate_limit_type || info.rateLimitType;
  return sanitizeRateLimitWindow({
    label: claudeRateLimitLabel(type),
    remainingPercent: remainingFromUtilization(info.utilization),
    resetsAt: formatRateLimitResetAt(info.resets_at ?? info.resetsAt),
  });
}

function normalizeClaudeRateLimitPayload(payload, fallbackSource = "claude") {
  const rateLimits = payload?.rate_limits || payload?.rateLimits;
  const windows = [];
  if (rateLimits && typeof rateLimits === "object") {
    for (const type of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]) {
      const window = claudeStatusLineWindow(rateLimits, type);
      if (window) windows.push(window);
    }
  }
  const info = payload?.rate_limit_info || payload?.rateLimitInfo || payload?.data?.rate_limit_info || payload?.data?.rateLimitInfo;
  const eventWindow = claudeEventWindow(info);
  if (eventWindow) windows.push(eventWindow);
  return {
    provider: "claude",
    source: String(payload?.source || fallbackSource),
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    windows,
  };
}

function normalizeRateLimitSnapshot(payload, fallbackSource = "unknown", provider = "") {
  const normalizedProvider = provider ? normalizeProvider(provider) : "";
  if (normalizedProvider === "claude") {
    const claudeSnapshot = normalizeClaudeRateLimitPayload(payload, fallbackSource);
    if (claudeSnapshot.windows.length) return claudeSnapshot;
  }
  const rawWindows = Array.isArray(payload) ? payload : payload?.windows || payload?.limits || [];
  const windows = (Array.isArray(rawWindows) ? rawWindows : []).map(sanitizeRateLimitWindow).filter(Boolean);
  return {
    provider: normalizedProvider || payload?.provider || undefined,
    source: String(payload?.source || fallbackSource),
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    windows,
  };
}

function providerEnvValue(provider, suffix, { legacyCodex = false } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const providerKey = normalizedProvider.toUpperCase();
  const phoneKey = `PHONE_${providerKey}_${suffix}`;
  const shortKey = `${providerKey}_${suffix}`;
  if (process.env[phoneKey] !== undefined) return process.env[phoneKey];
  if (process.env[shortKey] !== undefined) return process.env[shortKey];
  if (legacyCodex && normalizedProvider === "codex") {
    const legacyKey = `PHONE_${suffix}`;
    if (process.env[legacyKey] !== undefined) return process.env[legacyKey];
  }
  return undefined;
}

function envRateLimitSnapshot(provider) {
  const json = providerEnvValue(provider, "RATE_LIMITS_JSON", { legacyCodex: true });
  if (json) {
    try {
      const parsed = JSON.parse(json);
      return normalizeRateLimitSnapshot(parsed, "env", provider);
    } catch (error) {
      return { provider, source: "env", windows: [], error: error.message };
    }
  }
  const hasShortLimit = ["RATE_LIMIT_SHORT_LABEL", "RATE_LIMIT_SHORT_PERCENT", "RATE_LIMIT_SHORT_RESET"].some(
    (suffix) => providerEnvValue(provider, suffix, { legacyCodex: true }) !== undefined,
  );
  const hasWeeklyLimit = ["RATE_LIMIT_WEEKLY_LABEL", "RATE_LIMIT_WEEKLY_PERCENT", "RATE_LIMIT_WEEKLY_RESET"].some(
    (suffix) => providerEnvValue(provider, suffix, { legacyCodex: true }) !== undefined,
  );
  const windows = [
    hasShortLimit
      ? sanitizeRateLimitWindow({
          label: providerEnvValue(provider, "RATE_LIMIT_SHORT_LABEL", { legacyCodex: true }) || "5時間",
          remainingPercent: providerEnvValue(provider, "RATE_LIMIT_SHORT_PERCENT", { legacyCodex: true }),
          resetsAt: providerEnvValue(provider, "RATE_LIMIT_SHORT_RESET", { legacyCodex: true }),
        })
      : null,
    hasWeeklyLimit
      ? sanitizeRateLimitWindow({
          label: providerEnvValue(provider, "RATE_LIMIT_WEEKLY_LABEL", { legacyCodex: true }) || "週あたり",
          remainingPercent: providerEnvValue(provider, "RATE_LIMIT_WEEKLY_PERCENT", { legacyCodex: true }),
          resetsAt: providerEnvValue(provider, "RATE_LIMIT_WEEKLY_RESET", { legacyCodex: true }),
        })
      : null,
  ].filter(Boolean);
  return windows.length ? { provider, source: "env", updatedAt: new Date().toISOString(), windows } : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function rateLimitCachePathForProvider(provider) {
  const configured = providerEnvValue(provider, "RATE_LIMIT_CACHE_PATH", { legacyCodex: true });
  if (configured) return path.resolve(configured);
  return provider === "claude" ? path.join(root, ".phone-rate-limits.claude.json") : path.join(root, ".phone-rate-limits.json");
}

function readRateLimitCache(provider) {
  const cachePath = rateLimitCachePathForProvider(provider);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const snapshot = normalizeRateLimitSnapshot(JSON.parse(fs.readFileSync(cachePath, "utf8")), "cache", provider);
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (Number.isFinite(updatedAtMs)) snapshot.stale = Date.now() - updatedAtMs > rateLimitCacheTtlMs;
    return snapshot;
  } catch (error) {
    return { provider, source: "cache", windows: [], error: error.message };
  }
}

function writeRateLimitCache(provider, snapshot) {
  const cachePath = rateLimitCachePathForProvider(provider);
  fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cachePath, 0o600);
  } catch {
    // Best effort: cached rate-limit metadata is still usable if chmod fails.
  }
}

function runRateLimitRefreshCommand(provider, command) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, {
      cwd: root,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`rate limit command timed out after ${rateLimitRefreshTimeoutMs}ms`));
    }, rateLimitRefreshTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || `rate limit command exited with ${signal || code}`).trim()));
        return;
      }
      try {
        const snapshot = normalizeRateLimitSnapshot(JSON.parse(stdout), "command", provider);
        if (!snapshot.windows.length) throw new Error("rate limit command returned no windows");
        resolve(snapshot);
      } catch (error) {
        reject(new Error(`invalid rate limit command output: ${error.message}`));
      }
    });
  });
}

function mergeRateLimitSnapshots(previous, next, provider) {
  const merged = new Map();
  for (const window of previous?.windows || []) merged.set(window.label, window);
  for (const window of next?.windows || []) merged.set(window.label, window);
  return {
    provider,
    source: next?.source || previous?.source || "cache",
    updatedAt: next?.updatedAt || new Date().toISOString(),
    windows: Array.from(merged.values()),
  };
}

async function rateLimitSnapshot({ provider = agentProvider, refresh = false } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const envSnapshot = envRateLimitSnapshot(normalizedProvider);
  if (envSnapshot) return envSnapshot;
  const command = String(providerEnvValue(normalizedProvider, "RATE_LIMIT_REFRESH_COMMAND", { legacyCodex: true }) || "").trim();
  const cached = readRateLimitCache(normalizedProvider);
  if (refresh && command) {
    try {
      const snapshot = await runRateLimitRefreshCommand(normalizedProvider, command);
      writeRateLimitCache(normalizedProvider, snapshot);
      return snapshot;
    } catch (error) {
      if (cached && cached.windows?.length) return { ...cached, stale: true, error: error.message };
      return { provider: normalizedProvider, source: "command", windows: [], error: error.message };
    }
  }
  if (cached) return cached;
  return { provider: normalizedProvider, source: command ? "command" : "unavailable", windows: [] };
}

function persistClaudeRateLimitMessage(message) {
  const snapshot = normalizeClaudeRateLimitPayload(message, "claude-rate-limit-event");
  if (!snapshot.windows.length) return null;
  const cached = readRateLimitCache("claude");
  const merged = mergeRateLimitSnapshots(cached, snapshot, "claude");
  writeRateLimitCache("claude", merged);
  return merged;
}

const codexBin = path.join(root, "node_modules", ".bin", "codex");
const claudeBin = process.env.CLAUDE_BIN || "claude";
const envPath = path.join(root, ".env");
const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
const uiPort = Number(process.env.PHONE_UI_PORT || 45214);
const uiHost = process.env.PHONE_UI_HOST || "0.0.0.0";
const agentProvider = normalizeProvider(process.env.PHONE_AGENT_PROVIDER || process.env.AGENT_PROVIDER || process.env.PHONE_AGENT_PROVIDER_DEFAULT || "codex");
const isCodexProvider = agentProvider === "codex";
const isClaudeProvider = agentProvider === "claude";
const phoneAppId = appIdSlug(process.env.PHONE_APP_ID, `${agentProvider}-${uiPort}`);
const phoneAppName = process.env.PHONE_APP_NAME || `${defaultAppNameForProvider(agentProvider)} ${uiPort}`;
const phoneAppShortName = process.env.PHONE_APP_SHORT_NAME || `${defaultAppShortNameForProvider(agentProvider)} ${uiPort}`;
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
const rateLimitCacheTtlMs = positiveNumber(process.env.PHONE_RATE_LIMIT_CACHE_TTL_MS, 5 * 60 * 1000);
const rateLimitRefreshTimeoutMs = positiveNumber(process.env.PHONE_RATE_LIMIT_REFRESH_TIMEOUT_MS, 6000);
const uploadDir = path.join(root, ".uploads");
const maxUploadBytes = uploadLimitBytes();
const codexModelOptions = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];
const claudeModelOptions = ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-5"];
const modelOptions = isClaudeProvider ? claudeModelOptions : codexModelOptions;
const bridges = new Map();
let notificationBridgeUrls = [];
let codexProcess = null;
let codexStartPromise = null;
const historyLimit = 80;
const idleBridgeTtlMs = Number(process.env.PHONE_IDLE_BRIDGE_TTL_MS || 60 * 60 * 1000);
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

function historySyncEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_HISTORY_SYNC" : "CODEX_HISTORY_SYNC";
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
  const providerPinned = ["PHONE_AGENT_PROVIDER", "AGENT_PROVIDER", "PHONE_AGENT_PROVIDER_DEFAULT"].some(hasLaunchEnv);
  const settingsProvider = providerPinned ? agentProvider : savedProvider;
  const modelPinned = ["PHONE_MODEL", modelEnvKeyForProvider(settingsProvider), ...(settingsProvider === "codex" ? ["CODEX_MODEL"] : [])].some(hasLaunchEnv);
  const workdirPinned = ["PHONE_WORKDIR", workdirEnvKeyForProvider(settingsProvider), "CODEX_WORKDIR"].some(hasLaunchEnv);
  const historyPinned = historySyncEnvKeyForProvider(settingsProvider) ? hasLaunchEnv(historySyncEnvKeyForProvider(settingsProvider)) : false;
  const portPinned = hasLaunchEnv("PHONE_UI_PORT");
  const hostPinned = hasLaunchEnv("PHONE_UI_HOST");
  const savedHistorySyncEnabled = settingsProvider === "codex" ? isHistorySyncEnabled({ CODEX_HISTORY_SYNC: envValues.CODEX_HISTORY_SYNC }) : false;
  const savedPort = Number(envValues.PHONE_UI_PORT || uiPort);
  const savedHost = envValues.PHONE_UI_HOST || uiHost;
  const savedModel = modelFromEnv(envValues, settingsProvider, settingsProvider === agentProvider ? model : defaultModelForProvider(settingsProvider));
  const savedWorkdir = workdirFromEnv(envValues, settingsProvider, workdir);
  const settingsModel = modelPinned && settingsProvider === agentProvider ? model : savedModel;
  const settingsWorkdir = workdirPinned && settingsProvider === agentProvider ? workdir : savedWorkdir;
  const settingsHistorySyncEnabled = historyPinned && settingsProvider === agentProvider ? historySyncEnabled : savedHistorySyncEnabled;
  const settingsPort = portPinned ? uiPort : savedPort;
  const settingsHost = hostPinned ? uiHost : savedHost;
  return {
    settings: {
      provider: settingsProvider,
      model: settingsModel,
      workdir: settingsWorkdir,
      historySyncEnabled: settingsHistorySyncEnabled,
      uiPort: settingsPort,
      uiHost: settingsHost,
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
      (!providerPinned && savedProvider !== agentProvider) ||
      (!modelPinned && settingsProvider === agentProvider && savedModel !== model) ||
      (!workdirPinned && settingsProvider === agentProvider && savedWorkdir !== workdir) ||
      (!historyPinned && settingsProvider === agentProvider && savedHistorySyncEnabled !== historySyncEnabled),
    networkRestartRequired: (!portPinned && savedPort !== uiPort) || (!hostPinned && savedHost !== uiHost),
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

function preferredBridgeUrl(urls = notificationBridgeUrls) {
  return urls.find((item) => {
    try {
      return new URL(item).hostname.startsWith("100.");
    } catch {
      return false;
    }
  }) || urls[0] || "";
}

function bridgeUrlForThread(threadId) {
  const base = preferredBridgeUrl();
  if (!base) return "";
  try {
    const url = new URL(base);
    if (threadId) url.searchParams.set("thread", threadId);
    return url.toString();
  } catch {
    return base;
  }
}

function logNotifyResults(context, results) {
  if (!results.length) return;
  for (const result of results) {
    if (result.ok) console.log(`[notify] ${context} sent via ${result.type}`);
    else console.warn(`[notify] ${context} ${result.type} failed: ${result.error}`);
  }
}

function notifyRunEvent(status, { threadId, turnId, message } = {}) {
  notifyTaskEvent({
    status,
    provider: agentProvider,
    threadId,
    turnId,
    model,
    workdir,
    message,
    url: bridgeUrlForThread(threadId),
  }).then((results) => logNotifyResults(`task ${status}`, results));
}

function waitForReady(timeoutMs = 10_000) {
  const url = `http://127.0.0.1:${codexPort}/readyz`;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error("Codex app-server did not become ready"));
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

function isCodexReady() {
  const url = `http://127.0.0.1:${codexPort}/readyz`;
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
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

function isManagedCodexProcessAlive() {
  return codexProcess && codexProcess.exitCode === null && !codexProcess.killed;
}

function startCodexServer() {
  if (isManagedCodexProcessAlive()) return codexProcess;
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
    if (codexProcess === child) {
      codexProcess = null;
      appServerClient.reset(new Error("Codex app-server exited"));
    }
  });
  codexProcess = child;
  return child;
}

function stopCodexServer(signal = "SIGTERM") {
  if (isManagedCodexProcessAlive()) codexProcess.kill(signal);
}

function shutdown(signal) {
  stopCodexServer();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function isCodexConnectionFailure(error) {
  const message = String(error?.message || error || "");
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("app-server connection") ||
    message.includes("WebSocket was closed") ||
    message.includes("socket hang up")
  );
}

async function ensureCodexServerRunning() {
  if (!shouldStartCodexServer) return false;
  if (await isCodexReady()) return false;
  if (codexStartPromise) return codexStartPromise;

  codexStartPromise = (async () => {
    if (await isCodexReady()) return false;
    if (isManagedCodexProcessAlive()) {
      try {
        await waitForReady(3_000);
        return false;
      } catch {
        codexProcess.kill("SIGINT");
        codexProcess = null;
      }
    }
    startCodexServer();
    await waitForReady();
    return true;
  })().finally(() => {
    codexStartPromise = null;
  });

  return codexStartPromise;
}

async function appServerRequest(method, params) {
  if (shouldStartCodexServer) await ensureCodexServerRunning();
  try {
    return await appServerClient.request(method, params);
  } catch (error) {
    if (!shouldStartCodexServer || !isCodexConnectionFailure(error)) throw error;
    appServerClient.reset(error);
    await ensureCodexServerRunning();
    return appServerClient.request(method, params);
  }
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

function parseJsonish(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text || !/^[{[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compactCodexError(raw) {
  const text = String(raw || "").trim();
  const parsed = parseJsonish(text);
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const error = root.error && typeof root.error === "object" ? root.error : root;
  const message = String(error.message || root.message || text || "Codex error");
  const info = error.codexErrorInfo || root.codexErrorInfo || {};
  const code = Object.keys(info)[0] || "";
  const additional = String(error.additionalDetails || root.additionalDetails || "");
  const requestId = (additional.match(/request ID\s+([a-f0-9-]+)/i) || text.match(/request ID\s+([a-f0-9-]+)/i))?.[1] || "";
  const willRetry = root.willRetry === true || /reconnecting/i.test(message);
  const streamDisconnected =
    code === "responseStreamDisconnected" || /responseStreamDisconnected|stream disconnected before completion/i.test(text);
  if (!streamDisconnected) return { text, retrying: false };
  const lines = [willRetry ? "Codex stream disconnected. Reconnecting." : "Codex stream disconnected."];
  if (message && !/^reconnecting/i.test(message)) lines.push(message);
  if (requestId) lines.push(`Request ID: ${requestId}`);
  return { text: lines.join("\n"), retrying: willRetry };
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

function skillDiscoveryRoots() {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  return [
    path.join(codexHome, "skills"),
    path.join(home, ".agents", "skills"),
    path.join(root, ".agents", "skills"),
    path.join(codexHome, "plugins", "cache"),
  ];
}

function shouldSkipSkillPath(filePath) {
  return filePath.split(path.sep).some((part) => /\.backup-\d{8}/.test(part));
}

function findSkillFiles(base, { maxDepth = 7, limit = 180, seen = new Set(), files = [] } = {}) {
  const resolved = path.resolve(base);
  if (files.length >= limit || maxDepth < 0 || seen.has(resolved) || !fs.existsSync(resolved)) return files;
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return files;
  }
  if (!stat.isDirectory()) return files;
  seen.add(resolved);
  let entries = [];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (files.length >= limit) break;
    const target = path.join(resolved, entry.name);
    if (shouldSkipSkillPath(target)) continue;
    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(target);
    } else if (entry.isDirectory()) {
      findSkillFiles(target, { maxDepth: maxDepth - 1, limit, seen, files });
    }
  }
  return files;
}

function parseSkillFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    values[field[1]] = field[2].replace(/^["']|["']$/g, "").trim();
  }
  return values;
}

function skillSourceLabel(filePath) {
  const parts = filePath.split(path.sep);
  const pluginIndex = parts.indexOf("plugins");
  const cacheIndex = parts.indexOf("cache");
  if (pluginIndex >= 0 && cacheIndex >= 0 && cacheIndex > pluginIndex) {
    const pluginName = parts[cacheIndex + 2] || parts[cacheIndex + 1];
    return pluginName ? `plugin: ${pluginName}` : "plugin";
  }
  if (filePath.startsWith(path.join(os.homedir(), ".agents"))) return "user";
  if (filePath.startsWith(path.join(root, ".agents"))) return "project";
  return "codex";
}

function readSkills() {
  const found = new Set();
  const skills = [];
  for (const base of skillDiscoveryRoots()) {
    for (const skillFile of findSkillFiles(base)) {
      const resolved = path.resolve(skillFile);
      if (found.has(resolved)) continue;
      found.add(resolved);
      let raw = "";
      try {
        raw = fs.readFileSync(resolved, "utf8");
      } catch {
        continue;
      }
      const frontmatter = parseSkillFrontmatter(raw);
      const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const id = path.basename(path.dirname(resolved));
      skills.push({
        id,
        name: frontmatter.name || heading || id,
        description: frontmatter.description || "",
        source: skillSourceLabel(resolved),
        path: resolved,
      });
    }
  }
  return skills.sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`));
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

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    return "&gt;";
  });
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeProxyBasePath(basePath) {
  const value = String(basePath || "");
  return /^\/(?:abs)?proxy\/\d+$/.test(value) ? value : "";
}

function manifestHrefForRequest(req, phoneToken) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safeBasePath = safeProxyBasePath(url.searchParams.get("base"));
  const params = new URLSearchParams();
  if (phoneToken) params.set("token", phoneToken);
  if (safeBasePath) params.set("base", safeBasePath);
  const query = params.toString();
  return `site.webmanifest${query ? `?${query}` : ""}`;
}

function staticAssetHref(fileName) {
  const assetPath = path.join(root, "public", fileName);
  const version = fs.existsSync(assetPath) ? `${Math.round(fs.statSync(assetPath).mtimeMs).toString(36)}-${phoneAppId}` : phoneAppId;
  return `${fileName}?v=${encodeURIComponent(version)}`;
}

function bookmarkIconFileName() {
  return agentProvider === "claude" ? "bookmark-claude.png" : "bookmark-codex.png";
}

function bookmarkIcon512FileName() {
  return agentProvider === "claude" ? "bookmark-claude-512.png" : "bookmark-codex-512.png";
}

function iconHrefForRequest() {
  return staticAssetHref(bookmarkIconFileName());
}

function serveIndex(req, res, { includeManifest = true, standalone = true, phoneToken = "" } = {}) {
  const indexPath = path.join(root, "public", "index.html");
  const pageTitle = standalone ? phoneAppName : phoneAppShortName;
  let html = fs.readFileSync(indexPath, "utf8");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`)
    .replace(
      /<link rel="icon" type="image\/png" sizes="192x192" href="icon-192\.png" \/>/,
      `<link rel="icon" type="image/png" sizes="180x180" href="${escapeHtmlAttribute(iconHrefForRequest())}" />`,
    )
    .replace(
      /<link rel="apple-touch-icon" href="apple-touch-icon\.png" \/>/,
      `<link rel="apple-touch-icon" sizes="180x180" href="${escapeHtmlAttribute(iconHrefForRequest())}" />`,
    )
    .replace(/<link rel="stylesheet" href="style\.css" \/>/, `<link rel="stylesheet" href="${escapeHtmlAttribute(staticAssetHref("style.css"))}" />`)
    .replace(/<script src="main\.js"><\/script>/, `<script src="${escapeHtmlAttribute(staticAssetHref("main.js"))}"></script>`)
    .replace(
      /<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttribute(phoneAppShortName)}" />`,
    );
  if (!standalone) {
    html = html
      .replace(/\n\s*<meta name="apple-mobile-web-app-capable" content="yes" \/>/, "")
      .replace(/\n\s*<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/, "")
      .replace(/\n\s*<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/, "");
  }
  if (!includeManifest) {
    html = html.replace(/\n\s*<link rel="manifest" href="site\.webmanifest" \/>/, "");
  } else {
    html = html.replace(
      /<link rel="manifest" href="site\.webmanifest" \/>/,
      `<link rel="manifest" href="${escapeHtmlAttribute(manifestHrefForRequest(req, phoneToken))}" />`,
    );
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function serveStatic(req, res, phoneToken) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (requestPath === "/") {
    serveIndex(req, res, { phoneToken });
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
  const safeBasePath = safeProxyBasePath(url.searchParams.get("base"));
  manifest.name = phoneAppName;
  manifest.short_name = phoneAppShortName;
  manifest.id = `${safeBasePath}/codex-remote-${phoneAppId}`;
  manifest.scope = `${safeBasePath}/`;
  manifest.description = `${phoneAppName} local phone bridge (${agentProvider}:${uiPort}).`;
  manifest.icons = [
    {
      src: `${safeBasePath}/${staticAssetHref(bookmarkIconFileName())}`,
      sizes: "180x180",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `${safeBasePath}/${staticAssetHref(bookmarkIcon512FileName())}`,
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ];
  if (url.searchParams.get("token") === phoneToken) {
    manifest.start_url = `${safeBasePath}/?token=${encodeURIComponent(phoneToken)}`;
  } else {
    manifest.start_url = `${safeBasePath}/`;
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

function recentJsonlRows(filePath, maxBytes = 1024 * 1024) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return [];
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function runStateFromSessionFile(thread) {
  const rows = recentJsonlRows(thread?.path);
  let latestStarted = null;
  let latestCompleted = null;
  for (const row of rows) {
    if (row.type !== "event_msg") continue;
    const payload = row.payload || {};
    if (payload.type === "task_started") latestStarted = { turnId: payload.turn_id || null, timestamp: row.timestamp || "" };
    if (payload.type === "task_complete") latestCompleted = { turnId: payload.turn_id || null, timestamp: row.timestamp || "" };
  }
  if (latestStarted && (!latestCompleted || latestCompleted.timestamp < latestStarted.timestamp)) {
    return { state: "streaming", label: "回答生成中", turnId: latestStarted.turnId };
  }
  if (latestCompleted) {
    return { state: "done", label: "前回完了・送信できます", turnId: latestCompleted.turnId };
  }
  return null;
}

function idleRunStateFromHistory(history = []) {
  const lastConversationEntry = [...history].reverse().find((entry) => entry.type === "user" || entry.type === "assistant");
  if (!lastConversationEntry) return { state: "ready", label: "未実行・送信できます", turnId: null };
  if (lastConversationEntry.type === "assistant") {
    return { state: "done", label: "前回完了・送信できます", turnId: lastConversationEntry.outputGroup || null };
  }
  return { state: "ready", label: "前回送信済み・応答未確認", turnId: lastConversationEntry.outputGroup || null };
}

function capHistory(history) {
  return history.slice(-historyLimit);
}

function claudeProjectDirFor(cwd = workdir) {
  return path.join(claudeProjectsRoot, path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

function textFromClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function claudeSessionFilePath(sessionId) {
  const id = String(sessionId || "").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  const base = path.resolve(claudeProjectDirFor());
  const target = path.resolve(base, `${id}.jsonl`);
  if (!target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}

function readClaudeSessionFile(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const sessionId = path.basename(filePath, ".jsonl");
  const stat = fs.statSync(filePath);
  const history = [];
  let title = "";
  let firstUserText = "";
  let lastUserText = "";
  let cwd = workdir;
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = stat.mtimeMs;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.cwd) cwd = item.cwd;
    if (item.type === "ai-title" && item.aiTitle) title = String(item.aiTitle);
    const timestamp = Date.parse(item.timestamp || "");
    if (Number.isFinite(timestamp)) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }
    if (item.type !== "user" && item.type !== "assistant") continue;
    const text = textFromClaudeContent(item.message?.content);
    if (!text.trim()) continue;
    const role = item.message?.role === "assistant" || item.type === "assistant" ? "assistant" : "user";
    if (role === "user") {
      if (!firstUserText) firstUserText = text;
      lastUserText = text;
    }
    history.push({
      type: role === "assistant" ? "assistant" : "user",
      text,
      outputGroup: item.uuid || item.requestId || sessionId,
    });
  }

  const fallbackTitle = firstUserText || sessionId;
  const firstTimestamp = Number.isFinite(createdAt) ? createdAt : stat.birthtimeMs;
  return {
    summary: {
      id: sessionId,
      name: title || fallbackTitle,
      preview: lastUserText || fallbackTitle,
      cwd,
      provider: "claude",
      updatedAt,
      updated_at: updatedAt,
      createdAt: firstTimestamp,
      created_at: firstTimestamp,
    },
    history: capHistory(history),
  };
}

function readClaudeSession(sessionId) {
  return readClaudeSessionFile(claudeSessionFilePath(sessionId));
}

function claudeHistoryForSession(sessionId) {
  return readClaudeSession(sessionId)?.history || [];
}

function claudeThreadListPayload() {
  const byId = new Map();
  const dir = claudeProjectDirFor();
  if (fs.existsSync(dir)) {
    for (const fileName of fs.readdirSync(dir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const session = readClaudeSessionFile(path.join(dir, fileName));
      if (session) byId.set(session.summary.id, session.summary);
    }
  }
  for (const thread of localThreadList()) {
    const existing = byId.get(thread.id);
    byId.set(thread.id, {
      ...existing,
      ...thread,
      name: thread.name === thread.id && existing?.name ? existing.name : thread.name,
      preview: thread.preview === thread.id && existing?.preview ? existing.preview : thread.preview,
    });
  }
  return {
    provider: "claude",
    activeProvider: agentProvider,
    data: Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  };
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
    this.startupFailed = false;
    this.history = [];
    this.turnQueue = [];
    this.runState = { state: "connecting", label: "接続中", turnId: null, updatedAt: Date.now() };
    this.streamingStarted = false;
    this.interruptRequested = false;
    this.idleDisposeTimer = null;
    this.upstream = createUpstreamWebSocket();
    this.bindUpstream();
  }

  addClient(browser) {
    this.cancelIdleDispose();
    this.clients.add(browser);
    this.emitTo(browser, "status", { text: "共有Codexブリッジに参加しました。" });
    if (this.ready) {
      this.emitTo(browser, "ready", this.readyPayload());
    }
    browser.on("close", () => {
      this.clients.delete(browser);
      this.scheduleIdleDispose();
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
      run: this.runPayload(),
    };
  }

  runPayload() {
    if (this.activeTurnId) {
      if (this.runState?.state === "interrupting") return this.runState;
      return {
        state: this.streamingStarted ? "streaming" : "running",
        label: this.streamingStarted ? "回答生成中" : "Agent 処理中",
        turnId: this.activeTurnId,
        updatedAt: Date.now(),
      };
    }
    return this.runState || { state: "ready", label: "未実行・送信できます", turnId: null, updatedAt: Date.now() };
  }

  setBridgeRunState(state, label, turnId = this.activeTurnId || null) {
    const next = { state, label, turnId, updatedAt: Date.now() };
    const previous = this.runState || {};
    this.runState = next;
    if (previous.state !== state || previous.label !== label || previous.turnId !== turnId) {
      this.emit("runState", next);
    }
  }

  hasActiveWork() {
    return Boolean(this.activeTurnId || this.hasPendingTurnStart() || this.turnQueue.length);
  }

  cancelIdleDispose() {
    if (!this.idleDisposeTimer) return;
    clearTimeout(this.idleDisposeTimer);
    this.idleDisposeTimer = null;
  }

  scheduleIdleDispose() {
    this.cancelIdleDispose();
    if (
      !shouldDisposeIdleBridge({
        clientCount: this.clients.size,
        ready: this.ready,
        active: this.hasActiveWork(),
      })
    ) {
      return;
    }
    this.idleDisposeTimer = setTimeout(() => {
      this.idleDisposeTimer = null;
      if (this.clients.size || this.hasActiveWork()) return;
      this.dispose();
      if (bridges.get(this.bridgeKey) === this) bridges.delete(this.bridgeKey);
    }, idleBridgeTtlMs);
    this.idleDisposeTimer.unref?.();
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
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server connection is not open");
    }
    const id = this.nextId++;
    this.upstream.send(JSON.stringify({ id, method, params }));
    return id;
  }

  isReusable() {
    return (
      !this.startupFailed &&
      this.upstream &&
      (this.upstream.readyState === WebSocket.CONNECTING || this.upstream.readyState === WebSocket.OPEN)
    );
  }

  dispose() {
    this.cancelIdleDispose();
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      this.upstream.close();
    }
    for (const pending of this.pending.keys()) this.pending.delete(pending);
  }

  hasPendingTurnStart() {
    return Array.from(this.pending.values()).includes("turn/start");
  }

  hasPendingTurnInterrupt() {
    return Array.from(this.pending.values()).includes("turn/interrupt");
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
          const compact = compactCodexError(msg.error.message || JSON.stringify(msg.error));
          const error = new Error(compact.text);
          if (pendingMethod === "thread/resume" && isMissingThreadError(error)) {
            this.fallbackToNewThread(error);
            return;
          }
          this.startupFailed = true;
          this.emit(compact.retrying ? "status" : "error", { text: compact.text });
          return;
        }
        this.threadId = msg.result.thread.id;
        this.startupFailed = false;
        this.promoteBridgeKey();
        this.ready = true;
        this.history = historyFromThread(msg.result.thread);
        const idleState = runStateFromSessionFile(msg.result.thread) || idleRunStateFromHistory(this.history);
        this.setBridgeRunState(idleState.state, idleState.label, idleState.turnId);
        this.emit("ready", this.readyPayload());
        if (this.requestedThreadId) this.emit("status", { text: `既存threadを再開しました: ${this.threadId}` });
        return;
      }

      if (pendingMethod === "turn/start") {
        this.pending.delete(msg.id);
        if (msg.error) {
          this.interruptRequested = false;
          const error = compactCodexError(msg.error.message || JSON.stringify(msg.error));
          this.emit(error.retrying ? "status" : "error", { text: error.text });
          this.setBridgeRunState(error.retrying ? "running" : "error", error.retrying ? "再試行中" : "開始に失敗");
          if (!error.retrying) {
            notifyRunEvent("failed", {
              threadId: this.threadId,
              message: error.text,
            });
          }
          this.startNextQueuedTurn();
        } else {
          this.activeTurnId = msg.result.turn.id;
          this.streamingStarted = false;
          this.setBridgeRunState("running", "Agent 処理中", this.activeTurnId);
          this.emit("turn", { status: "started", turnId: this.activeTurnId, run: this.runPayload() });
          if (this.interruptRequested) {
            this.interruptRequested = false;
            this.sendTurnInterrupt(this.activeTurnId);
          }
        }
        return;
      }

      if (pendingMethod === "turn/interrupt") {
        this.pending.delete(msg.id);
        if (msg.error) {
          const error = compactCodexError(msg.error.message || JSON.stringify(msg.error));
          this.emit("error", { text: `中断に失敗しました: ${error.text}` });
          this.setBridgeRunState("error", "中断に失敗", this.activeTurnId);
        } else {
          this.setBridgeRunState("interrupting", "中断中", this.activeTurnId);
        }
        return;
      }

      if (msg.method === "item/agentMessage/delta") {
        if (!this.streamingStarted) {
          this.streamingStarted = true;
          this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
        }
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
        const completedTurn = msg.params.turn || {};
        const completedTurnId = msg.params.turnId || completedTurn.id || this.activeTurnId;
        const wasInterrupted = completedTurn.status === "interrupted";
        this.interruptRequested = false;
        this.activeTurnId = null;
        this.streamingStarted = false;
        this.setBridgeRunState(wasInterrupted ? "interrupted" : "done", wasInterrupted ? "中断しました" : "完了しました", completedTurnId);
        this.emit("turn", { status: "completed", turnId: completedTurnId, run: this.runPayload() });
        notifyRunEvent(wasInterrupted ? "interrupted" : "completed", { threadId: this.threadId, turnId: completedTurnId });
        this.syncHistory("turn completed");
        this.startNextQueuedTurn();
        this.scheduleIdleDispose();
        return;
      }

      if (msg.method && msg.method.endsWith("/requestApproval")) {
        this.setBridgeRunState("approval", "承認待ち", this.activeTurnId);
        this.emit("approval", { request: msg });
        notifyRunEvent("approval", {
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: msg.method,
        });
        return;
      }

      if (msg.method === "error") {
        const error = compactCodexError(msg.params.message || JSON.stringify(msg.params));
        if (error.retrying) {
          this.setBridgeRunState("running", "再試行中", this.activeTurnId);
          this.emit("status", { text: error.text });
          return;
        }
        this.interruptRequested = false;
        this.setBridgeRunState("error", "エラー", this.activeTurnId);
        this.emit("error", { text: error.text });
        notifyRunEvent("failed", {
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: error.text,
        });
        return;
      }

      this.emit("event", { event: msg });
    });

    this.upstream.on("error", (error) => {
      if (!this.ready) this.startupFailed = true;
      this.interruptRequested = false;
      this.emit("error", { text: error.message });
      if (this.activeTurnId) this.setBridgeRunState("error", "接続エラー", this.activeTurnId);
      if (shouldStartCodexServer && isCodexConnectionFailure(error)) {
        ensureCodexServerRunning().catch((restartError) => {
          this.emit("error", { text: `Codex app-serverを再起動できませんでした: ${restartError.message}` });
        });
      }
      if (this.activeTurnId) {
        notifyRunEvent("failed", {
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: error.message,
        });
      }
    });
    this.upstream.on("close", () => {
      if (!this.ready) this.startupFailed = true;
      this.interruptRequested = false;
      this.emit("status", { text: "Codex接続が閉じました" });
      if (this.activeTurnId) this.setBridgeRunState("error", "接続が閉じました", this.activeTurnId);
      if (shouldStartCodexServer) {
        ensureCodexServerRunning().catch((error) => {
          this.emit("error", { text: `Codex app-serverを再起動できませんでした: ${error.message}` });
        });
      }
    });
  }

  sendTurnInterrupt(turnId = this.activeTurnId) {
    if (!this.threadId || !turnId || this.hasPendingTurnInterrupt()) return false;
    const id = this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
    this.pending.set(id, "turn/interrupt");
    this.setBridgeRunState("interrupting", "中断中", turnId);
    this.emit("status", { text: "処理の中断を要求しました。" });
    return true;
  }

  interrupt() {
    const queuedCount = this.turnQueue.length;
    this.turnQueue = [];
    if (queuedCount) this.emit("status", { text: `待機中の送信を破棄しました（${queuedCount}件）。` });

    if (this.activeTurnId) {
      try {
        this.interruptRequested = false;
        if (!this.sendTurnInterrupt(this.activeTurnId)) {
          this.emit("status", { text: "中断要求はすでに送信済みです。" });
        }
      } catch (error) {
        this.setBridgeRunState("error", "中断に失敗", this.activeTurnId);
        this.emit("error", { text: `中断要求の送信に失敗しました: ${error.message}` });
      }
      return;
    }

    if (this.hasPendingTurnStart()) {
      this.interruptRequested = true;
      this.setBridgeRunState("interrupting", "開始後に中断します");
      this.emit("status", { text: "開始待ちの処理を中断予約しました。" });
      return;
    }

    if (!queuedCount) this.emit("status", { text: "中断できる処理はありません。" });
  }

  prompt(text, attachments = [], options = {}, clientMessageId = null) {
    if (!this.threadId) {
      this.emit("error", { text: "Thread is not ready yet" });
      return;
    }
    if (this.activeTurnId || this.hasPendingTurnStart()) {
      this.turnQueue.push({ text, attachments, options, clientMessageId });
      if (clientMessageId) this.emit("promptAccepted", { clientMessageId, queued: true });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options, clientMessageId);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
    }
  }

  startNextQueuedTurn() {
    if (!this.ready || this.activeTurnId || this.hasPendingTurnStart() || !this.turnQueue.length) return;
    const next = this.turnQueue.shift();
    this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
    try {
      this.startPrompt(next.text, next.attachments, next.options, next.clientMessageId);
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

  startPrompt(text, attachments = [], options = {}, clientMessageId = null) {
    this.interruptRequested = false;
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
    this.setBridgeRunState("running", "送信済み・開始待ち");
    const savedAttachments = [...savedImages, ...savedFiles];
    const displayText = savedAttachments.length ? `${text}\n\n添付: ${savedAttachments.map((file) => file.name).join(", ")}` : text;
    this.appendHistory({ type: "user", text: displayText, attachments: savedImages });
    this.emit("user", { text: displayText, attachments: savedImages, clientMessageId });
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
    this.history = this.claudeSessionId ? claudeHistoryForSession(this.claudeSessionId) : [];
    this.turnQueue = [];
    this.activeProcess = null;
    const idleState = idleRunStateFromHistory(this.history);
    this.runState = { ...idleState, updatedAt: Date.now() };
    this.streamingStarted = false;
    this.interruptRequested = false;
    this.idleDisposeTimer = null;
  }

  addClient(browser) {
    this.cancelIdleDispose();
    this.clients.add(browser);
    this.emitTo(browser, "status", { text: "共有Claudeブリッジに参加しました。" });
    this.emitTo(browser, "ready", this.readyPayload());
    browser.on("close", () => {
      this.clients.delete(browser);
      this.scheduleIdleDispose();
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
      run: this.runPayload(),
    };
  }

  runPayload() {
    if (this.activeTurnId || this.activeProcess) {
      if (this.runState?.state === "interrupting") return this.runState;
      return {
        state: this.streamingStarted ? "streaming" : "running",
        label: this.streamingStarted ? "回答生成中" : "Agent 処理中",
        turnId: this.activeTurnId,
        updatedAt: Date.now(),
      };
    }
    return this.runState || { state: "ready", label: "未実行・送信できます", turnId: null, updatedAt: Date.now() };
  }

  setBridgeRunState(state, label, turnId = this.activeTurnId || null) {
    const next = { state, label, turnId, updatedAt: Date.now() };
    const previous = this.runState || {};
    this.runState = next;
    if (previous.state !== state || previous.label !== label || previous.turnId !== turnId) {
      this.emit("runState", next);
    }
  }

  hasActiveWork() {
    return Boolean(this.activeTurnId || this.activeProcess || this.turnQueue.length);
  }

  cancelIdleDispose() {
    if (!this.idleDisposeTimer) return;
    clearTimeout(this.idleDisposeTimer);
    this.idleDisposeTimer = null;
  }

  scheduleIdleDispose() {
    this.cancelIdleDispose();
    if (
      !shouldDisposeIdleBridge({
        clientCount: this.clients.size,
        ready: this.ready,
        active: this.hasActiveWork(),
      })
    ) {
      return;
    }
    this.idleDisposeTimer = setTimeout(() => {
      this.idleDisposeTimer = null;
      if (this.clients.size || this.hasActiveWork()) return;
      if (bridges.get(this.bridgeKey) === this) bridges.delete(this.bridgeKey);
    }, idleBridgeTtlMs);
    this.idleDisposeTimer.unref?.();
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

  interrupt() {
    const queuedCount = this.turnQueue.length;
    this.turnQueue = [];
    if (queuedCount) this.emit("status", { text: `待機中の送信を破棄しました（${queuedCount}件）。` });

    if (!this.activeProcess) {
      if (!queuedCount) this.emit("status", { text: "中断できる処理はありません。" });
      return;
    }

    const child = this.activeProcess;
    this.interruptRequested = true;
    this.setBridgeRunState("interrupting", "中断中", this.activeTurnId);
    this.emit("status", { text: "Claude processへ中断信号を送信しました。" });
    child.kill("SIGINT");
    const forceTimer = setTimeout(() => {
      if (this.activeProcess === child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }, 1500);
    forceTimer.unref?.();
  }

  prompt(text, attachments = [], options = {}, clientMessageId = null) {
    if (this.activeTurnId || this.activeProcess) {
      this.turnQueue.push({ text, attachments, options, clientMessageId });
      if (clientMessageId) this.emit("promptAccepted", { clientMessageId, queued: true });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options, clientMessageId);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
    }
  }

  startNextQueuedTurn() {
    if (this.activeTurnId || this.activeProcess || !this.turnQueue.length) return;
    const next = this.turnQueue.shift();
    this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
    this.startPrompt(next.text, next.attachments, next.options, next.clientMessageId);
  }

  startPrompt(text, attachments = [], options = {}, clientMessageId = null) {
    this.interruptRequested = false;
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
    this.streamingStarted = false;
    this.setBridgeRunState("running", "Agent 処理中", turnId);
    this.appendHistory({ type: "user", text: displayText, attachments: savedImages });
    this.emit("user", { text: displayText, attachments: savedImages, clientMessageId });
    this.emit("turn", { status: "started", turnId, run: this.runPayload() });

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
      const rateLimitUpdate = persistClaudeRateLimitMessage(msg);
      if (rateLimitUpdate) {
        this.emit("rateLimits", { rateLimits: rateLimitUpdate });
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
        if (!this.streamingStarted) {
          this.streamingStarted = true;
          this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
        }
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
          if (!this.streamingStarted) {
            this.streamingStarted = true;
            this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
          }
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
      this.interruptRequested = false;
      this.setBridgeRunState("error", "起動に失敗", this.activeTurnId);
      this.emit("error", { text: `Claudeを起動できませんでした: ${error.message}` });
      notifyRunEvent("failed", {
        threadId: this.threadId,
        turnId,
        message: error.message,
      });
    });
    child.on("exit", (code, signal) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      const wasInterrupted = this.interruptRequested || signal === "SIGINT" || signal === "SIGTERM";
      this.interruptRequested = false;
      this.activeProcess = null;
      this.activeTurnId = null;
      this.streamingStarted = false;
      if (code === 0 && !wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        this.setBridgeRunState("done", "完了しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        notifyRunEvent("completed", { threadId: this.threadId, turnId });
      } else if (wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        this.setBridgeRunState("interrupted", "中断しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        notifyRunEvent("interrupted", { threadId: this.threadId, turnId });
      } else {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        const message = `Claude process exited (${reason})${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-1000)}` : ""}`;
        this.setBridgeRunState("error", "エラー", turnId);
        this.emit("error", { text: message });
        notifyRunEvent("failed", {
          threadId: this.threadId,
          turnId,
          message,
        });
      }
      this.startNextQueuedTurn();
      this.scheduleIdleDispose();
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
    for (const [key, bridge] of bridges.entries()) {
      if (bridge.requestedThreadId) continue;
      if (typeof bridge.isReusable !== "function" || bridge.isReusable()) return bridge;
      if (typeof bridge.dispose === "function") bridge.dispose();
      bridges.delete(key);
    }
  }
  const key = bridgeKeyForRequest(threadId, connectionId);
  const existing = bridges.get(key);
  if (existing && typeof existing.isReusable === "function" && !existing.isReusable()) {
    existing.dispose();
    bridges.delete(key);
  }
  if (!bridges.has(key)) bridges.set(key, isClaudeProvider ? new ClaudeBridge(threadId, key) : new SharedBridge(threadId, key));
  return bridges.get(key);
}

async function bindBrowser(browser, phoneToken, threadId) {
  browser.isAlive = true;
  browser.on("pong", () => {
    browser.isAlive = true;
  });
  if (shouldStartCodexServer) {
    try {
      await ensureCodexServerRunning();
    } catch (error) {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "error", text: `Codex app-serverを起動できませんでした: ${error.message}` }));
        browser.close();
      }
      return;
    }
  }
  if (browser.readyState !== WebSocket.OPEN) return;
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
    if (msg.type === "prompt") bridge.prompt(msg.text, msg.attachments, msg.options, msg.clientMessageId);
    if (msg.type === "interrupt") bridge.interrupt();
    if (msg.type === "approval") bridge.approval(msg.request, msg.decision);
  });
}

function bridgeSummaries() {
  return Array.from(bridges.values()).map((bridge) => ({
    threadId: bridge.threadId,
    clients: bridge.clients.size,
    ready: bridge.ready,
    provider: agentProvider,
    run: typeof bridge.runPayload === "function" ? bridge.runPayload() : null,
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

async function codexThreadListPayload(requestedProvider) {
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
  return { ...result, provider: requestedProvider, activeProvider: agentProvider, data };
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
  const managedCodexServer = shouldStartCodexServer;
  if (isCodexProvider) {
    await appServerRequest("thread/loaded/list", { cursor: null, limit: 1 });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/info") {
      sendJson(res, 200, {
        provider: agentProvider,
        model,
        workdir,
        app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
        codexUrl: isCodexProvider ? codexUrl : null,
        codexSocketPath: isCodexProvider ? codexSocketPath || null : null,
        managedCodexServer,
        tokenRequired: true,
      });
      return;
    }
    if (url.pathname === "/site.webmanifest") {
      serveManifest(url, phoneToken, res);
      return;
    }
    if (url.pathname === "/bookmark") {
      serveIndex(req, res, { includeManifest: false, standalone: false, phoneToken });
      return;
    }
    if (url.pathname === "/api/threads") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = normalizeProvider(url.searchParams.get("provider") || agentProvider);
      if (requestedProvider === "claude") {
        sendJson(res, 200, claudeThreadListPayload());
        return;
      }
      try {
        sendJson(res, 200, await codexThreadListPayload(requestedProvider));
      } catch (error) {
        if (requestedProvider !== agentProvider) {
          sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, data: [], unavailable: error.message });
          return;
        }
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
    if (url.pathname === "/api/skills") {
      if (!requireToken(url, phoneToken, res)) return;
      try {
        sendJson(res, 200, { data: readSkills() });
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
          auth: { authMethod: "claude-cli" },
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
        stopCodexServer();
        process.exit(42);
      }, 200);
      return;
    }
    if (url.pathname === "/api/status") {
      if (!requireToken(url, phoneToken, res)) return;
      const refreshRateLimits = url.searchParams.get("refreshRateLimits") === "1";
      sendJson(res, 200, {
        provider: agentProvider,
        workdir,
        model,
        app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
        codexUrl: isCodexProvider ? codexUrl : null,
        codexSocketPath: isCodexProvider ? codexSocketPath || null : null,
        managedCodexServer,
        historySyncEnabled,
        rateLimits: await rateLimitSnapshot({ provider: agentProvider, refresh: refreshRateLimits }),
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
      if (requestedProvider === "claude") {
        const bridge = findBridgeByThreadId(threadId);
        sendJson(res, 200, {
          provider: requestedProvider,
          activeProvider: agentProvider,
          threadId,
          history: bridge?.history?.length ? bridge.history : claudeHistoryForSession(threadId),
        });
        return;
      }
      try {
        const snapshot = await readThreadSnapshot({
          threadId,
          liveBridge: findLiveBridge(bridges, threadId),
          request: appServerRequest,
          model,
          workdir,
          historyFromThread,
        });
        sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, ...snapshot });
      } catch (error) {
        if (requestedProvider !== agentProvider) {
          sendJson(res, 200, { provider: requestedProvider, activeProvider: agentProvider, threadId, history: [], unavailable: error.message });
          return;
        }
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
    serveStatic(req, res, phoneToken);
  });

  const wss = new WebSocket.Server({ noServer: true });
  const browserHeartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  server.on("close", () => clearInterval(browserHeartbeat));

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
    wss.handleUpgrade(req, socket, head, (ws) => {
      bindBrowser(ws, phoneToken, threadId).catch((error) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", text: error.message }));
          ws.close();
        }
      });
    });
  });

  server.listen(uiPort, uiHost, () => {
    const advertisedAddresses = uiHost === "0.0.0.0" ? lanAddresses() : [uiHost];
    const urls = bridgeUrls(advertisedAddresses, uiPort, phoneToken);
    notificationBridgeUrls = urls;
    console.log("");
    console.log("Codex shared browser bridge is ready.");
    for (const url of urls) console.log(`  ${url}`);
    console.log("");
    console.log(`Workdir: ${workdir}`);
    console.log(`Provider: ${agentProvider}`);
    console.log(`Model:   ${model}`);
    console.log(`App:     ${phoneAppName} (${phoneAppId})`);
    console.log(`Bridge:  ${uiHost}:${uiPort}`);
    if (isCodexProvider) console.log(`Codex:   ${managedCodexServer ? codexUrl : codexSocketPath || codexUrl}`);
    else console.log(`Claude:  ${claudeBin}`);
    console.log("Open the same URL from PC and phone to share one bridge thread.");
    console.log("Press Ctrl+C to stop.");

    notifyBridgeUrls(urls).then((results) => {
      logNotifyResults("startup", results);
    });
  });

  process.on("exit", () => {
    stopCodexServer();
  });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
