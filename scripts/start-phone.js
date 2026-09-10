const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const WebSocket = require("ws");
const { createBuildTracker } = require("./bridge-build");
const { bridgeKeyForRequest, bridgeMatchesWorkdir, shouldDisposeIdleBridge, shouldPromoteBridgeKey, shouldReplaceBridgeForWorkdir } = require("./bridge-state");
const {
  RegistryConflictError,
  RegistryUnreadableError,
  readRegistry: readBridgeRegistryBackup,
  registryKeyPath,
  registryPathForPort,
  writeRegistry: writeBridgeRegistryBackup,
} = require("./bridge-registry-store");
const { debugLog, debugLogPath, debugTimer, isDebugEnabled, redactSensitiveText } = require("./debug-log");
const { isHistorySyncEnabled, runHistorySync } = require("./history-sync");
const {
  approvalDetail,
  bridgeUrls,
  notificationTargets,
  notifyBridgeUrls,
  notifyEvent,
  notifyTaskEvent,
  startupTokenUrlsEnabled,
  stripTokenFromUrl,
  tokenNeedsUrlEncoding,
} = require("./phone-notify");
const { servedHttpsEndpoint, tailscaleServeStatus } = require("./remote-url");
const { defaultCodexAppServerPort, settingEnvKeysForSlot, slotEnvKey, slotSettingValue } = require("./phone-slot-settings");
const { slashCommandCatalog } = require("./slash-commands");
const { findLiveBridge, readThreadSnapshot } = require("./thread-read");
const { isUnavailableHistoryError, emptyCodexThreadWorkdir, hasSavedCodexThread } = require("./codex-empty-thread");
const { recentTurnsOptions, withRecentTurns } = require("./codex-history");
const { latestAssistantQuestion, idleRunStateFromHistory } = require("./question-state");
const operationContext = require("../public/operation-context");

const root = path.resolve(__dirname, "..");
let bridgeBuildTracker;

function normalizeProvider(input) {
  const value = String(input || "codex").trim().toLowerCase();
  if (value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported PHONE_AGENT_PROVIDER: ${value}`);
}

function normalizeServiceTier(input) {
  if (input === null) return null;
  const value = String(input || "").trim().toLowerCase();
  if (!value || value === "standard" || value === "normal" || value === "flex") return null;
  if (value === "fast") return "fast";
  throw new Error(`Unsupported service tier: ${value}`);
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

// Claude Code's live rate_limit_event carries no utilization, only which window
// is in play, when it resets, and how the account currently stands against it.
// A percentage needs the statusLine payload; see docs/guide/phone-bridge.md.
// Without one, the state belongs in the label — a window rendering nothing but
// "--" reads as a broken display rather than a working one with less to say.
function claudeEventWindowLabel(info, type) {
  const base = claudeRateLimitLabel(type);
  if (info.is_using_overage ?? info.isUsingOverage) return `${base}（追加利用中）`;
  const status = String(info.status || "").trim().toLowerCase();
  if (status && status !== "allowed") return `${base}（${status}）`;
  return base;
}

function claudeEventWindow(info) {
  if (!info || typeof info !== "object") return null;
  const type = info.rate_limit_type || info.rateLimitType;
  return sanitizeRateLimitWindow({
    label: claudeEventWindowLabel(info, type),
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

// Same as above except `0` is a value, not a miss: it is how an operator turns
// one stage of the stall watchdog off without turning the other off with it.
function stallThresholdMs(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
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
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) child.kill("SIGTERM");
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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

const codexBin = process.env.CODEX_BIN || path.join(root, "node_modules", ".bin", "codex");
const claudeBin = process.env.CLAUDE_BIN || "claude";
const envPath = path.join(root, ".env");
const fleetConfigPath = process.env.PHONE_FLEET_CONFIG_PATH ? path.resolve(process.env.PHONE_FLEET_CONFIG_PATH) : "";
const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
const uiPort = Number(process.env.PHONE_UI_PORT || 45214);
const uiHost = process.env.PHONE_UI_HOST || "0.0.0.0";
const agentProvider = normalizeProvider(
  slotSettingValue(process.env, "PHONE_AGENT_PROVIDER", uiPort, {
    launchEnvKeys,
    fallbackKeys: ["AGENT_PROVIDER", "PHONE_AGENT_PROVIDER_DEFAULT"],
    fallback: "codex",
  }),
);
const isCodexProvider = agentProvider === "codex";
const isClaudeProvider = agentProvider === "claude";
const launchSettings = launchSettingsFromFleetOrEnv(process.env, {
  filePath: fleetConfigPath,
  port: uiPort,
  bridgeId: process.env.PHONE_FLEET_BRIDGE_ID || process.env.PHONE_BRIDGE_ID || "",
  provider: agentProvider,
  fallbackWorkdir: root,
  fallbackModel: defaultModelForProvider(agentProvider),
  launchEnvKeys,
});
const initialFleetSettings = launchSettings.fleetSettings;
const phoneAppId = appIdSlug(process.env.PHONE_APP_ID, `${agentProvider}-${uiPort}`);
const phoneAppName = process.env.PHONE_APP_NAME || `${defaultAppNameForProvider(agentProvider)} ${uiPort}`;
const phoneAppShortName = process.env.PHONE_APP_SHORT_NAME || `${defaultAppShortNameForProvider(agentProvider)} ${uiPort}`;
const codexPort = Number(
  slotSettingValue(process.env, "CODEX_APP_SERVER_PORT", uiPort, {
    launchEnvKeys,
    fallback: defaultCodexAppServerPort(uiPort),
  }),
);
const codexSocketPath = process.env.CODEX_APP_SERVER_SOCK || "";
const codexUrl = process.env.CODEX_APP_SERVER_URL || (codexSocketPath ? "ws://codex-app-server/rpc" : `ws://127.0.0.1:${codexPort}`);
// The Codex app-server is started on demand, not at boot. A Claude-default
// bridge only reaches for it once a request names the codex provider, so the
// bridge does not depend on the codex binary until someone actually asks for
// Codex. A configured URL or socket means an external server owns it instead.
const shouldStartCodexServer = !process.env.CODEX_APP_SERVER_URL && !codexSocketPath;
// Set by the `phone:loop*` supervisor scripts. Exiting 42 only restarts the
// bridge when something is watching for that code.
const bridgeIsSupervised = /^(1|true|yes|on)$/i.test(process.env.PHONE_SUPERVISED || "");
const workdir = launchSettings.workdir;
const providerModels = {
  // The active provider takes the fleet-resolved model; the other still needs a
  // value so the UI can show it without a fleet entry of its own.
  codex: isCodexProvider
    ? launchSettings.model
    : modelFromEnv(process.env, "codex", defaultModelForProvider("codex"), { launchEnvKeys }),
  claude: isClaudeProvider
    ? launchSettings.model
    : modelFromEnv(process.env, "claude", defaultModelForProvider("claude"), { launchEnvKeys }),
};
const model = providerModels[agentProvider] || defaultModelForProvider(agentProvider);
const historySyncEnabled = historySyncEnabledFromEnv(process.env, { launchEnvKeys });
const tokenPath = path.join(root, ".phone-token");
const workspacePrefsPath = path.join(root, ".phone-workspaces.json");
// Keyed by port, not by anything the phone holds: a reinstalled PWA has no
// surviving id of its own to ask for its backup with.
const bridgeRegistryPath = registryPathForPort(root, uiPort);
const bridgeRegistryKeyPath = registryKeyPath(root);
const rateLimitCacheTtlMs = positiveNumber(process.env.PHONE_RATE_LIMIT_CACHE_TTL_MS, 5 * 60 * 1000);
const rateLimitRefreshTimeoutMs = positiveNumber(process.env.PHONE_RATE_LIMIT_REFRESH_TIMEOUT_MS, 6000);
const uploadDir = path.join(root, ".uploads");
const maxUploadBytes = uploadLimitBytes();
// Only the fallback for when the app-server has never been asked. The list the
// phone is shown comes from `model/list`, so a model that reaches this account
// appears the next time Codex runs, without a release of this bridge.
const codexModelOptions = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"];
// Aliases rather than pinned full names: they follow the current generation, so
// the list cannot rot into offering models that no longer exist.
const claudeModelOptions = ["sonnet", "opus", "haiku", "fable"];
// Every reasoning level Codex has a name for. Used only to sanity-check a level
// for a model whose own list has not been fetched yet; a model that advertises
// its levels is always checked against those instead.
const codexEffortNames = ["low", "medium", "high", "xhigh", "max", "ultra"];
// What to offer for a Codex model the account has not described yet. Deliberately
// the conservative set every current model shares: offering a level the model
// does not have is what makes a menu look like it applied when it did not.
const codexEffortOptions = ["low", "medium", "high", "xhigh"];

// The last `model/list` answer, kept on disk so a bridge that has not run Codex
// since it started still offers the models the account actually has.
const codexModelCachePath = process.env.PHONE_CODEX_MODELS_CACHE_PATH || path.join(root, ".phone-codex-models.json");

function codexModelIdsFromList(list) {
  const ids = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || item.hidden) continue;
    const id = String(item.id || item.model || item.slug || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// `model/list` names the levels each model actually accepts, and they differ:
// GPT-6-Astra has `max` and `ultra`, GPT-5.6-Luna stops at `xhigh`. Keeping the
// real list per model is what lets the phone offer the levels by their own
// names rather than a fixed four-step guess.
function codexEffortsFromList(list) {
  const efforts = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || item.hidden) continue;
    const id = String(item.id || item.model || item.slug || "").trim();
    if (!id) continue;
    const supported = [];
    for (const entry of Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []) {
      const name = String(entry?.reasoningEffort || entry?.effort || entry || "").trim().toLowerCase();
      if (name && !supported.includes(name)) supported.push(name);
    }
    if (supported.length) efforts[id] = supported;
  }
  return efforts;
}

function readCodexModelCache(cachePath = codexModelCachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models.map((item) => String(item || "").trim()).filter(Boolean) : [];
    // A cache written before the bridge recorded levels has no `efforts`; an
    // empty map falls back rather than failing to load the models beside it.
    const efforts = parsed?.efforts && typeof parsed.efforts === "object" ? parsed.efforts : {};
    return { models, efforts, updatedAt: parsed?.updatedAt || null };
  } catch {
    return { models: [], efforts: {}, updatedAt: null };
  }
}

let codexModelCache = readCodexModelCache();

function rememberCodexModels(list, { cachePath = codexModelCachePath } = {}) {
  const models = codexModelIdsFromList(list);
  if (!models.length) return codexModelCache.models;
  const efforts = codexEffortsFromList(list);
  const changed =
    JSON.stringify(models) !== JSON.stringify(codexModelCache.models) ||
    JSON.stringify(efforts) !== JSON.stringify(codexModelCache.efforts || {});
  codexModelCache = { models, efforts, updatedAt: new Date().toISOString() };
  if (changed) {
    try {
      fs.writeFileSync(cachePath, `${JSON.stringify(codexModelCache, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // The in-memory copy still serves this run; the next answer tries again.
    }
  }
  return models;
}

// Live models first, in the order the app-server lists them, then any fallback
// the account has not confirmed. A configured default is always offered even if
// no list has named it, so a model chosen ahead of its release can be kept.
function codexModelChoices({ cache = codexModelCache, fallback = codexModelOptions, configured = "" } = {}) {
  const choices = [];
  for (const id of [...(cache?.models || []), ...(configured ? [configured] : []), ...fallback]) {
    if (id && !choices.includes(id)) choices.push(id);
  }
  return choices;
}
// The levels a given Codex model really accepts, by its own names. The phone
// menu is built from this, so "max" on the menu is the model's max rather than
// a label pinned to a fixed step.
function codexReasoningChoices({ cache = codexModelCache, model = "", fallback = codexEffortOptions } = {}) {
  const known = cache?.efforts?.[String(model || "").trim()];
  return Array.isArray(known) && known.length ? [...known] : [...fallback];
}

// `turn/start` takes `effort` and the app-server ignores an unknown one the same
// way `claude --effort` does, so a level is only forwarded once it is known to
// belong to the model. When the account has not described the model yet, any
// name Codex has is still forwarded: dropping a correct level because the list
// is cold is the same silent miss this validation exists to prevent.
function codexEffortLevel(options = {}, model = "", { cache = codexModelCache } = {}) {
  const requested = String(options.effort || "").trim().toLowerCase();
  if (!requested) return "";
  const known = cache?.efforts?.[String(model || "").trim()];
  if (Array.isArray(known) && known.length) return known.includes(requested) ? requested : "";
  return codexEffortNames.includes(requested) ? requested : "";
}

// What the phone needs to draw the menu: the real levels per model, plus a
// per-provider fallback for a model no list has described.
function reasoningChoicePayload({ cache = codexModelCache } = {}) {
  return {
    byModel: { ...(cache?.efforts || {}) },
    codex: [...codexEffortOptions],
    claude: [...claudeEffortLevels],
  };
}

// `claude --effort` accepts any string without complaining, so an unknown value
// is silently ignored rather than rejected. Validate here or a typo looks like
// it applied.
const claudeEffortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);

function claudeEffortLevel(options = {}) {
  const requested = String(options.effort || "").trim().toLowerCase();
  if (claudeEffortLevels.has(requested)) return requested;
  const configured = String(process.env.CLAUDE_EFFORT || "").trim().toLowerCase();
  return claudeEffortLevels.has(configured) ? configured : "";
}

// `claude --name` is what labels a session in the /resume picker, the prompt
// box, and the terminal title. Without it a bridge session shows up there as a
// bare uuid, which is why work started from the phone was impossible to
// recognise on the desktop. The prefix marks where the session came from.
const claudeSessionNamePrefix =
  process.env.PHONE_SESSION_NAME_PREFIX === undefined ? "📱" : process.env.PHONE_SESSION_NAME_PREFIX;

function claudeSessionName(text, prefix = claudeSessionNamePrefix) {
  const body = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  // The marker alone would label every session identically, which is no more
  // findable than the uuid it replaces. An attachment-only turn lands here.
  if (!body) return "";
  return [String(prefix || "").trim(), body].filter(Boolean).join(" ").slice(0, 80);
}

// Older CLIs reject an unknown option outright, so guessing wrong would break
// every turn rather than merely lose the label. Ask once and remember.
let claudeSupportsNameFlag = null;

function claudeAcceptsNameFlag(probe) {
  // A supplied probe is the test seam, so it always runs; the cache only exists
  // to keep the real binary from being asked once per turn.
  if (!probe && claudeSupportsNameFlag !== null) return claudeSupportsNameFlag;
  let supported = false;
  try {
    const help = probe
      ? probe()
      : execFileSync(claudeBin, ["--help"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    supported = /(^|\s)--name[\s<,=]/.test(String(help || ""));
  } catch {
    supported = false;
  }
  if (!probe) claudeSupportsNameFlag = supported;
  return supported;
}
const bridges = new Map();
const bridgeStartedAt = Date.now();
const phoneBridgeId = appIdSlug(process.env.PHONE_BRIDGE_ID, `${path.basename(workdir)}-${uiPort}`);
const phoneBridgeLabel = String(process.env.PHONE_BRIDGE_LABEL || process.env.PHONE_BRIDGE_REGISTRY_NAME || path.basename(workdir) || phoneAppShortName).trim();
const phoneBridgeGroup = String(process.env.PHONE_BRIDGE_GROUP || "").trim();
// What to call this Mac in the phone UI. The hostname carries the model and the
// phone reads it, so this is only needed where that guess is wrong or too long.
function machineLabelForEnvironment(configuredLabel = process.env.PHONE_MACHINE_LABEL, hostName = os.hostname()) {
  return String(configuredLabel || hostName || "").trim();
}
const phoneMachineLabel = machineLabelForEnvironment();
const phoneBridgeColor = String(process.env.PHONE_BRIDGE_COLOR || "").trim();
let notificationBridgeUrls = [];
let codexProcess = null;
let codexStartPromise = null;
let lastBridgeEventAt = 0;
let lastHistorySync = { enabled: historySyncEnabled, lastSuccessAt: null, lastFailureAt: null, lastError: "" };
const historyLimit = 80;
const idleBridgeTtlMs = Number(process.env.PHONE_IDLE_BRIDGE_TTL_MS || 60 * 60 * 1000);
const longRunningNotifyMs = positiveNumber(process.env.PHONE_NOTIFY_LONG_RUNNING_MS, 10 * 60 * 1000);
// A turn is only ever ended by the CLI process exiting. A CLI that stops
// emitting without exiting therefore leaves 「処理中」 on the phone forever, and
// the phone cannot tell that from work still in progress - the one question it
// exists to answer. These thresholds are what turns that silence into a
// statement. `0` switches a stage off.
const claudeStallWarnMs = stallThresholdMs(process.env.PHONE_CLAUDE_STALL_WARN_MS, 90 * 1000);
const claudeStallKillMs = stallThresholdMs(process.env.PHONE_CLAUDE_STALL_KILL_MS, 5 * 60 * 1000);
const claudeStallCheckMs = positiveNumber(process.env.PHONE_CLAUDE_STALL_CHECK_MS, 15 * 1000);
// Observed on a hung turn: SIGTERM was ignored outright, three times over. A
// stage that cannot be refused has to follow it.
const claudeStallKillGraceMs = positiveNumber(process.env.PHONE_CLAUDE_STALL_KILL_GRACE_MS, 2000);
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

function gitOutputFromCwd(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return "";
  }
}

function gitOutput(args) {
  return gitOutputFromCwd(workdir, args);
}

function currentGitBranch(cwd = workdir) {
  const branch = gitOutputFromCwd(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") return branch;
  const commit = gitOutputFromCwd(cwd, ["rev-parse", "--short", "HEAD"]);
  return commit ? `detached:${commit}` : "";
}

function gitStatusSummary(cwd = workdir) {
  const output = gitOutputFromCwd(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const summary = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 };
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const index = line[0] || " ";
    const worktreeStatus = line[1] || " ";
    if (line.startsWith("??")) {
      summary.untracked += 1;
      continue;
    }
    if (index === "A" || worktreeStatus === "A") summary.added += 1;
    if (index === "D" || worktreeStatus === "D") summary.deleted += 1;
    if (index === "R" || worktreeStatus === "R") summary.renamed += 1;
    if (index === "M" || worktreeStatus === "M") summary.modified += 1;
  }
  return summary;
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function bridgeInfoPayload() {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]) || workdir;
  const summary = gitStatusSummary(workdir);
  const dirty = Object.values(summary).some((count) => count > 0);
  return {
    id: phoneBridgeId,
    label: phoneBridgeLabel,
    group: phoneBridgeGroup,
    version: readPackageVersion(),
    startedAt: bridgeStartedAt,
    uiPort,
    hostName: os.hostname(),
    codexUrl,
    codexSocketPath: codexSocketPath || null,
    machineLabel: phoneMachineLabel || null,
    operationContext: { version: 1 },
    workdir,
    cwd: workdir,
    repoRoot,
    branch: currentGitBranch() || null,
    head: gitOutput(["rev-parse", "--short", "HEAD"]) || null,
    dirty,
    dirtySummary: summary,
    // Application code, not the repository selected for this conversation.
    build: bridgeBuildTracker?.status() || { schema: 1, available: false, restartRequired: null },
    provider: agentProvider,
    providers: ["codex", "claude"],
    model,
    modelsByProvider: providerModels,
    modelChoices: { codex: codexModelChoices({ configured: modelForProvider("codex") }), claude: claudeModelOptions },
    reasoningChoices: reasoningChoicePayload(),
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    color: phoneBridgeColor || null,
    // The build this bridge serves. A page compares it with the one it is
    // running and reloads itself when they differ.
    shell: { main: staticAssetHref("main.js"), style: staticAssetHref("style.css") },
    app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
    capabilities: {
      threads: true,
      terminalHistory: true,
      artifacts: true,
      approvals: true,
      fleet: true,
    },
  };
}

function displayPath(value) {
  return String(value || "").split(path.sep).join("/");
}

const workspaceMetaCacheTtlMs = 5000;
let workspaceMetaCache = null;
let workspaceMetaCacheAt = 0;

function readWorkspaceMeta(cwd = workdir) {
  const gitRoot = gitOutputFromCwd(cwd, ["rev-parse", "--show-toplevel"]);
  const repoName = path.basename(gitRoot || cwd);
  const relative = gitRoot ? displayPath(path.relative(gitRoot, cwd)) : "";
  return {
    gitBranch: currentGitBranch(cwd),
    repoName,
    workspaceLocation: gitRoot ? relative || "." : displayPath(cwd),
  };
}

function currentWorkspaceMeta(cwd = workdir) {
  if (path.resolve(cwd) !== path.resolve(workdir)) return readWorkspaceMeta(cwd);
  const now = Date.now();
  if (workspaceMetaCache && now - workspaceMetaCacheAt < workspaceMetaCacheTtlMs) return workspaceMetaCache;
  workspaceMetaCache = readWorkspaceMeta(workdir);
  workspaceMetaCacheAt = now;
  return workspaceMetaCache;
}

function modelEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_MODEL" : "CODEX_MODEL";
}

function workdirEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_WORKDIR" : "CODEX_WORKDIR";
}

function defaultModelForProvider(provider) {
  return provider === "claude" ? "sonnet" : "gpt-5.6-sol";
}

function modelOptionsForProvider(provider) {
  return provider === "claude" ? claudeModelOptions : codexModelChoices();
}

// Asked after the app-server comes up and whenever the phone lists models, so
// the cache follows the account rather than a release of this bridge. Never
// starts a server just to ask: a Claude bridge that has not needed Codex keeps
// the last answer on disk instead.
async function refreshCodexModelList() {
  if (!appServerClient.ready && !(await isCodexReady())) return codexModelCache.models;
  try {
    const result = await appServerRequest("model/list", { limit: 80, includeHidden: false });
    return rememberCodexModels(result?.data);
  } catch {
    return codexModelCache.models;
  }
}

function modelForProvider(provider) {
  const normalizedProvider = normalizeProvider(provider);
  return providerModels[normalizedProvider] || defaultModelForProvider(normalizedProvider);
}

function historySyncEnabledForProvider(provider) {
  return normalizeProvider(provider) === "codex" && historySyncEnabled;
}

function modelFromEnv(env, provider, fallback = defaultModelForProvider(provider), options = {}) {
  const providerKey = modelEnvKeyForProvider(provider);
  // Claude must not inherit CODEX_MODEL; that legacy fallback is Codex-only.
  const fallbackKeys = provider === "codex" ? [providerKey, "CODEX_MODEL"] : [providerKey];
  return slotSettingValue(env, "PHONE_MODEL", options.uiPort || uiPort, {
    launchEnvKeys: options.launchEnvKeys,
    fallbackKeys,
    fallback,
  });
}

function workdirFromEnv(env, provider, fallback = workdir, options = {}) {
  return slotSettingValue(env, "PHONE_WORKDIR", options.uiPort || uiPort, {
    launchEnvKeys: options.launchEnvKeys,
    fallbackKeys: [workdirEnvKeyForProvider(provider), "CODEX_WORKDIR"],
    fallback,
  });
}

function historySyncEnabledFromEnv(env, options = {}) {
  return isHistorySyncEnabled({
    CODEX_HISTORY_SYNC: slotSettingValue(env, "CODEX_HISTORY_SYNC", options.uiPort || uiPort, {
      launchEnvKeys: options.launchEnvKeys,
    }),
  });
}

function launchSettingsFromFleetOrEnv(
  env,
  { filePath = "", port = uiPort, bridgeId = "", provider = "codex", fallbackWorkdir = root, fallbackModel = defaultModelForProvider(provider), launchEnvKeys } = {},
) {
  const fleetSettings = readFleetConfigBridgeSettings(filePath, { port, bridgeId });
  return {
    fleetSettings,
    workdir: fleetSettings.workdir || workdirFromEnv(env, provider, fallbackWorkdir, { launchEnvKeys, uiPort: port }),
    model: fleetSettings.model || modelFromEnv(env, provider, fallbackModel, { launchEnvKeys, uiPort: port }),
  };
}

function settingPinned(baseKey, fallbackKeys = []) {
  return settingEnvKeysForSlot(baseKey, uiPort, fallbackKeys).some(hasLaunchEnv);
}

function bridgeMapKey(provider, baseKey) {
  return `${normalizeProvider(provider)}:${baseKey}`;
}

function getToken() {
  if (process.env.PHONE_TOKEN) return process.env.PHONE_TOKEN;
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function maskTokenValue(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function tokenMetadata(phoneToken) {
  let createdAt = null;
  let ageMs = null;
  let source = "env";
  if (!process.env.PHONE_TOKEN && fs.existsSync(tokenPath)) {
    source = "file";
    const stat = fs.statSync(tokenPath);
    createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
    ageMs = Math.max(0, Date.now() - createdAt);
  }
  return {
    present: Boolean(phoneToken),
    masked: maskTokenValue(phoneToken),
    source,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    ageMs,
  };
}

function maskTokenInUrl(value) {
  return String(value || "").replace(/([?&](?:token|key)=)([^&\s]+)/gi, (_, prefix, raw) => `${prefix}${maskTokenValue(raw)}`);
}

function decodeBase64Url(value) {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function cookieValue(header, name) {
  const target = `${name}=`;
  for (const part of String(header || "").split(";")) {
    const item = part.trim();
    if (!item.startsWith(target)) continue;
    try {
      return decodeURIComponent(item.slice(target.length));
    } catch {
      return item.slice(target.length);
    }
  }
  return "";
}

function requestTokenFromHeaders(headers = {}) {
  const authorization = String(headers.authorization || headers.Authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const headerToken = headers["x-phone-token"] || headers["X-Phone-Token"];
  if (headerToken) return String(headerToken).trim();
  const cookieToken = cookieValue(headers.cookie || headers.Cookie, "codex_phone_token");
  if (cookieToken) return cookieToken;
  for (const protocol of String(headers["sec-websocket-protocol"] || "").split(",")) {
    const trimmed = protocol.trim();
    if (trimmed.startsWith("phone-token.")) return decodeBase64Url(trimmed.slice("phone-token.".length));
  }
  return "";
}

function requestToken(url) {
  return url.searchParams.get("token") || requestTokenFromHeaders(url._phoneHeaders || {});
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

function fleetBridgeMatches(entry = {}, targetPort = uiPort, bridgeId = "") {
  const entryPort = Number(entry.phonePort || entry.uiPort || entry.port);
  if (Number.isInteger(entryPort) && entryPort === Number(targetPort)) return true;
  return Boolean(bridgeId && String(entry.id || "").trim() === String(bridgeId).trim());
}

function readFleetConfigBridgeSettings(filePath, { port = uiPort, bridgeId = "" } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
  const bridge = Array.isArray(config.bridges) ? config.bridges.find((entry) => fleetBridgeMatches(entry, port, bridgeId)) : null;
  if (!bridge) return {};
  return {
    provider: bridge.provider ? normalizeProvider(bridge.provider) : "",
    model: bridge.model ? String(bridge.model).trim() : "",
    workdir: bridge.workdir ? path.resolve(String(bridge.workdir)) : "",
  };
}

function updateFleetConfigBridgeSettings(filePath, { port = uiPort, bridgeId = "", provider, model, workdir } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { updated: false, reason: "fleet config not found" };
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(config.bridges)) throw new Error("Fleet config bridges must be an array");
  const nextProvider = provider !== undefined ? normalizeProvider(provider) : undefined;
  const nextModel = model !== undefined ? validateModel(model) : undefined;
  const nextWorkdir = workdir !== undefined ? validateWorkdir(workdir) : undefined;
  let updated = false;
  const bridges = config.bridges.map((entry) => {
    if (!fleetBridgeMatches(entry, port, bridgeId)) return entry;
    updated = true;
    return {
      ...entry,
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextWorkdir !== undefined ? { workdir: nextWorkdir } : {}),
    };
  });
  if (!updated) return { updated: false, reason: "bridge entry not found" };
  fs.writeFileSync(filePath, `${JSON.stringify({ ...config, bridges }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: the bridge still works if the filesystem refuses chmod.
  }
  return { updated: true };
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
  if (!fs.existsSync(workspacePrefsPath)) return { recent: [], bookmarks: [], hiddenProjects: [] };
  try {
    const prefs = JSON.parse(fs.readFileSync(workspacePrefsPath, "utf8"));
    return {
      recent: Array.isArray(prefs.recent) ? prefs.recent : [],
      bookmarks: Array.isArray(prefs.bookmarks) ? prefs.bookmarks : [],
      hiddenProjects: Array.isArray(prefs.hiddenProjects) ? prefs.hiddenProjects : [],
    };
  } catch {
    return { recent: [], bookmarks: [], hiddenProjects: [] };
  }
}

function normalizeWorkspacePath(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

// Which projects the sidebar shows, not where work may run — so deliberately not
// validateWorkdir. A folder worth keeping out of the list can sit on an external
// volume, or be gone entirely, and the home folder is not a special case: it
// holds real work for some people and only tooling for others.
function setWorkspaceHidden(workspacePath, hidden) {
  const target = normalizeWorkspacePath(workspacePath);
  if (!target) throw new Error("Workspace path is required");
  const prefs = readWorkspacePrefs();
  const without = prefs.hiddenProjects.map(normalizeWorkspacePath).filter((item) => item && item !== target);
  const hiddenProjects = (hidden ? [target, ...without] : without).slice(0, 200);
  writeWorkspacePrefs({ ...prefs, hiddenProjects });
  return { path: target, hidden: hiddenProjects.includes(target) };
}

function hiddenWorkspaces() {
  return readWorkspacePrefs().hiddenProjects.map(normalizeWorkspacePath).filter(Boolean);
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
  writeWorkspacePrefs({ ...prefs, recent });
  return target;
}

// Recent is a rolling window of twelve, so a folder you return to every few
// weeks falls out of it. A bookmark is the way to say "keep this one".
function setWorkspaceBookmark(workspacePath, pinned) {
  const target = validateWorkdir(workspacePath);
  const prefs = readWorkspacePrefs();
  const without = prefs.bookmarks.filter((item) => path.resolve(item) !== target);
  const bookmarks = (pinned ? [target, ...without] : without)
    .filter((item) => fs.existsSync(item) && fs.statSync(item).isDirectory())
    .slice(0, 40);
  writeWorkspacePrefs({ ...prefs, bookmarks });
  return { path: target, pinned: bookmarks.some((item) => path.resolve(item) === target) };
}

function workspaceBookmarks() {
  return readWorkspacePrefs().bookmarks.filter((item) => {
    try {
      return isUnderHome(item) && fs.statSync(item).isDirectory();
    } catch {
      return false;
    }
  });
}

// Walking the filesystem from a phone means this endpoint is reachable over the
// LAN or a mesh VPN, so it stays inside the same boundary validateWorkdir
// enforces: below the home folder, directories only, no symlink escape.
function browseWorkspaceDirectories(input) {
  const raw = String(input || "").trim();
  const target = raw ? path.resolve(raw) : os.homedir();
  if (!isUnderHome(target)) throw errorWithStatus("参照できるのはホームフォルダ配下だけです。", 400);

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw errorWithStatus("フォルダが見つかりません。", 404);
  }
  if (!stat.isDirectory()) throw errorWithStatus("フォルダではありません。", 400);

  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    throw errorWithStatus("フォルダを読み取れません。", 403);
  }

  const pinned = new Set(workspaceBookmarks().map((item) => path.resolve(item)));
  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childPath = path.join(target, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      // Resolve before trusting it: a link can point anywhere.
      try {
        const resolved = fs.realpathSync(childPath);
        if (!isUnderHome(resolved) || !fs.statSync(resolved).isDirectory()) continue;
        isDirectory = true;
      } catch {
        continue;
      }
    }
    if (!isDirectory) continue;
    children.push({
      name: entry.name,
      path: childPath,
      isRepo: fs.existsSync(path.join(childPath, ".git")),
      pinned: pinned.has(childPath),
    });
    if (children.length >= 200) break;
  }
  children.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  const home = path.resolve(os.homedir());
  return {
    path: target,
    displayPath: displayPath(target),
    parent: target === home ? null : path.dirname(target),
    isRepo: fs.existsSync(path.join(target, ".git")),
    pinned: pinned.has(target),
    entries: children,
    // Which machine's tree this is. The two Macs keep the same folder names
    // under different home directories, so a listing that does not say whose
    // home it started from is a listing you can pick the wrong folder from.
    home,
    hostName: os.hostname(),
    machineLabel: phoneMachineLabel || null,
  };
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
    { group: "ブックマーク", items: workspaceBookmarks(), preserveOrder: true },
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

function localSettingsPayload(overrides = {}) {
  // The env values are injectable so this can be exercised without a bridge on
  // a port and a real .env on disk.
  const envValues = overrides.envValues || parseEnvValues(envPath);
  const fleetSettings = readFleetConfigBridgeSettings(fleetConfigPath, {
    port: uiPort,
    bridgeId: process.env.PHONE_FLEET_BRIDGE_ID || process.env.PHONE_BRIDGE_ID || phoneBridgeId,
  });
  const savedProvider = normalizeProvider(
    fleetSettings.provider ||
      slotSettingValue(envValues, "PHONE_AGENT_PROVIDER", uiPort, {
        fallbackKeys: ["AGENT_PROVIDER", "PHONE_AGENT_PROVIDER_DEFAULT"],
        fallback: agentProvider,
      }),
  );
  const providerPinned = settingPinned("PHONE_AGENT_PROVIDER", ["AGENT_PROVIDER", "PHONE_AGENT_PROVIDER_DEFAULT"]);
  const settingsProvider = providerPinned ? agentProvider : savedProvider;
  const modelPinned = settingPinned("PHONE_MODEL", [modelEnvKeyForProvider(settingsProvider), ...(settingsProvider === "codex" ? ["CODEX_MODEL"] : [])]);
  // History sync belongs to Codex, and its stored value is the same whichever
  // provider the sheet happens to be showing. Reporting it as off while the
  // sheet showed Claude made the checkbox draw unchecked, and switching the
  // sheet to Codex and saving then wrote that unchecked box back over the
  // stored value - a setting turned on by hand came back off after one save.
  const historyPinned = settingPinned("CODEX_HISTORY_SYNC");
  const portPinned = hasLaunchEnv("PHONE_UI_PORT");
  const hostPinned = hasLaunchEnv("PHONE_UI_HOST");
  const savedHistorySyncEnabled = historySyncEnabledFromEnv(envValues);
  const savedPort = Number(envValues.PHONE_UI_PORT || uiPort);
  const savedHost = envValues.PHONE_UI_HOST || uiHost;
  const savedModel = fleetSettings.model || modelFromEnv(envValues, settingsProvider, settingsProvider === agentProvider ? model : defaultModelForProvider(settingsProvider));
  const savedWorkdir = fleetSettings.workdir || workdirFromEnv(envValues, settingsProvider, workdir);
  const settingsModel = modelPinned && settingsProvider === agentProvider ? model : savedModel;
  const settingsWorkdir = savedWorkdir;
  const settingsHistorySyncEnabled = historyPinned ? historySyncEnabled : savedHistorySyncEnabled;
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
      historySyncEnabled: historySyncEnabledForProvider(agentProvider),
      uiPort,
      uiHost,
    },
    options: {
      providers: ["codex", "claude"],
      models: modelOptionsForProvider(agentProvider),
      modelsByProvider: {
        codex: codexModelChoices({ configured: modelForProvider("codex") }),
        claude: claudeModelOptions,
      },
      codexModelsUpdatedAt: codexModelCache.updatedAt,
      defaultModels: {
        codex: modelFromEnv(envValues, "codex", defaultModelForProvider("codex")),
        claude: modelFromEnv(envValues, "claude", defaultModelForProvider("claude")),
      },
      workspaces: workspaceOptions(),
    },
    restartRequired:
      (!modelPinned && settingsProvider === agentProvider && savedModel !== model) ||
      (settingsProvider === agentProvider && savedWorkdir !== workdir) ||
      (!historyPinned && savedHistorySyncEnabled !== historySyncEnabled),
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

// The address the phone was installed from, when `tailscale serve` publishes
// this bridge over HTTPS. A notification that links to the raw LAN or tailnet
// address opens a different origin, where the app's saved token does not exist,
// and the person tapping it is asked for a token they never see. Learned once,
// when the bridge starts listening.
let servedBridgeBaseUrl = "";

function servedBridgeUrl(port) {
  try {
    const served = servedHttpsEndpoint(tailscaleServeStatus(), port);
    if (!served) return "";
    return new URL(`https://${served.host}${Number(served.port) === 443 ? "" : `:${served.port}`}/`).toString();
  } catch {
    return "";
  }
}

function preferredBridgeUrl(urls = notificationBridgeUrls) {
  if (servedBridgeBaseUrl) return servedBridgeBaseUrl;
  return urls.find((item) => {
    try {
      return new URL(item).hostname.startsWith("100.");
    } catch {
      return false;
    }
  }) || urls[0] || "";
}

function bridgeUrlForThread(threadId, provider = agentProvider, { includeToken = false } = {}) {
  const base = preferredBridgeUrl();
  if (!base) return "";
  try {
    const url = new URL(base);
    if (!includeToken) {
      url.searchParams.delete("token");
      url.searchParams.delete("key");
    }
    if (threadId) url.searchParams.set("thread", threadId);
    url.searchParams.set("provider", normalizeProvider(provider));
    return url.toString();
  } catch {
    return includeToken ? base : stripTokenFromUrl(base);
  }
}

function logNotifyResults(context, results) {
  if (!results.length) return;
  for (const result of results) {
    if (result.ok) console.log(`[notify] ${context} sent via ${result.type}`);
    else console.warn(`[notify] ${context} ${result.type} failed: ${result.error}`);
  }
}

// The latest text of one kind in a bridge's history. With a `turnId`, only an
// entry that turn wrote counts: a completion notice that quoted the previous
// turn's answer, because this one said nothing, would be quoting the wrong
// thing with full confidence.
function latestHistoryText(bridge, type, turnId = "") {
  const entry = [...(bridge?.history || [])]
    .reverse()
    .find((item) => item?.type === type && item.text && (!turnId || !item.outputGroup || item.outputGroup === turnId));
  return redactSensitiveText(entry?.text || "");
}

// A notification is composed in phone-notify.js from facts, not from prose
// written here: which Mac, which folder, what was asked, what was answered,
// what went wrong. The bridge hands those over and nothing else, so every
// event reads the same way and the wording lives in one place.
function notifyRunEvent(status, {
  bridge = null,
  provider = bridge?.provider || agentProvider,
  threadId = bridge?.threadId || "",
  turnId,
  message,
  prompt,
  reply,
  model: eventModel = modelForProvider(provider),
  workdir: eventWorkdir = bridge?.workdir || workdir,
} = {}) {
  notifyTaskEvent({
    status,
    provider: normalizeProvider(provider),
    machine: phoneMachineLabel,
    color: phoneBridgeColor,
    threadId,
    turnId,
    model: eventModel,
    workdir: eventWorkdir,
    message,
    prompt: prompt ?? latestHistoryText(bridge, "user"),
    reply: reply ?? latestHistoryText(bridge, "assistant", turnId),
    url: bridgeUrlForThread(threadId, provider),
  }, {
    force: status === "completed" || status === "interrupted",
  })
    .then((results) => logNotifyResults(`task ${status}`, results))
    .catch((error) => console.warn(`[notify] task ${status} error: ${error.message}`));
}

function notifyBridgeEvent(type, payload = {}) {
  const bridge = payload.bridge || null;
  const provider = normalizeProvider(payload.provider || bridge?.provider || agentProvider);
  const threadId = payload.threadId || bridge?.threadId || "";
  const projectName = payload.projectName || path.basename(bridge?.workdir || workdir);
  const event = {
    type,
    provider,
    machine: phoneMachineLabel,
    color: phoneBridgeColor,
    title: payload.title || "",
    message: payload.message || "",
    detail: payload.detail || "",
    prompt: payload.prompt ?? latestHistoryText(bridge, "user"),
    questionCount: payload.questionCount || 0,
    minutes: payload.minutes || 0,
    deadlineMinutes: payload.deadlineMinutes || 0,
    threadId,
    threadTitle: payload.threadTitle || "",
    projectName,
    severity: payload.severity || "info",
    createdAt: new Date().toISOString(),
    url: payload.url || bridgeUrlForThread(threadId, provider),
    extra: {
      provider,
      model: payload.model || modelForProvider(provider),
      turnId: payload.turnId || "",
      ...payload.extra,
    },
  };
  notifyEvent(event, { force: Boolean(payload.force) })
    .then((results) => logNotifyResults(`event ${type}`, results))
    .catch((error) => console.warn(`[notify] event ${type} error: ${error.message}`));
}

// Silence alone does not say a turn died. A turn running `npm test` is silent
// for as long as the suite takes and is working the whole time, while a turn
// that has already been handed its tool result owes the phone tokens and is
// producing none. So the tools still in flight - not the clock alone - decide
// whether silence may be called a stall, and a turn waiting on a tool is never
// killed for waiting.
function claudeStallVerdict({
  now,
  lastOutputAt,
  pendingToolCount = 0,
  warned = false,
  warnMs = 0,
  killMs = 0,
}) {
  const silentMs = Math.max(0, Number(now) - Number(lastOutputAt || 0));
  const toolInFlight = Number(pendingToolCount) > 0;
  const verdict = { action: "none", silentMs, toolInFlight };
  if (!Number.isFinite(silentMs)) return verdict;
  if (!toolInFlight && killMs > 0 && silentMs >= killMs) return { ...verdict, action: "kill" };
  if (!warned && warnMs > 0 && silentMs >= warnMs) return { ...verdict, action: "warn" };
  return verdict;
}

function formatSilence(ms) {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分`;
}

function scheduleLongRunningNotification(bridge, turnId) {
  clearLongRunningNotification(bridge);
  if (!bridge || !turnId || !longRunningNotifyMs) return;
  bridge.longRunningTimer = setTimeout(() => {
    if (!bridge.activeTurnId && !bridge.activeProcess) return;
    notifyBridgeEvent("long_running", {
      bridge,
      turnId,
      severity: "warning",
      minutes: Math.round(longRunningNotifyMs / 60_000),
    });
  }, longRunningNotifyMs);
  bridge.longRunningTimer.unref?.();
}

function clearLongRunningNotification(bridge) {
  if (!bridge?.longRunningTimer) return;
  clearTimeout(bridge.longRunningTimer);
  bridge.longRunningTimer = null;
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
          capabilities: { experimentalApi: true },
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
    // The first thing a fresh app-server is asked is which models this account
    // has today, so a model that arrived since the last run is on the list
    // before anyone opens the menu.
    refreshCodexModelList().catch(() => {});
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

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-phone-token,x-file-name,x-file-size");
  res.setHeader("access-control-max-age", "600");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function browserOperationError(error, prefix) {
  return { text: `${prefix}${error.message}` };
}

function sendOperationJsonError(res, error, status = 400) {
  sendJson(res, status, { error: error.message });
}

function requireToken(url, phoneToken, res) {
  if (requestToken(url) === phoneToken) return true;
  sendJson(res, 401, { error: "invalid token" });
  return false;
}

function queryProvider(url, res, fallback = agentProvider) {
  try {
    return normalizeProvider(url.searchParams.get("provider") || fallback);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return null;
  }
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
  return /no rollout found for thread id|^thread not loaded:/i.test(error?.message || "");
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
  const text = redactSensitiveText(raw).trim();
  const parsed = parseJsonish(text);
  const root = parsed && typeof parsed === "object" ? parsed : {};
  const error = root.error && typeof root.error === "object" ? root.error : root;
  const message = String(error.message || root.message || text || "Codex error");
  if (/already has an active writer/i.test(message)) {
    return {
      text: "同じ会話を別のCodex画面が使用しています。作業の完了・保存後、そちらの会話を閉じてから「同じ会話に再接続」を試してください。画面を閉じても使用権が残る場合があります。直らないときは再接続を繰り返さず、元の画面で続けてください。履歴と下書きは残ります。",
      code: "thread_writer_conflict", retryable: false, retrying: false,
    };
  }
  if (/Max payload size exceeded/i.test(message)) {
    return {
      text: "通信データが大きすぎて接続できませんでした。履歴と下書きを残したまま「同じ会話に再接続」で読み込み直せます。繰り返す場合はMac側のアプリの更新が必要です。",
      code: "codex_payload_too_large", retryable: false, retrying: false,
    };
  }
  const info = error.codexErrorInfo || root.codexErrorInfo || {};
  const code = Object.keys(info)[0] || "";
  const additional = String(error.additionalDetails || root.additionalDetails || "");
  const requestId = (additional.match(/request ID\s+([a-f0-9-]+)/i) || text.match(/request ID\s+([a-f0-9-]+)/i))?.[1] || "";
  const willRetry = root.willRetry === true || /reconnecting/i.test(message);
  // Codex refreshes its own sign-in, answering a stale token with a burst of
  // 401s it then recovers from, so a turn only fails on one once that recovery
  // did not come. What arrives is a JSON envelope about bearer tokens and
  // request ids; the reader holding the phone can act on one thing, which is
  // signing in again on the Mac.
  const authExpired = /token_expired|authentication token is expired|401 Unauthorized/i.test(text);
  if (authExpired) {
    return {
      text: "Codexの認証が切れました。しばらく待っても直らないときは、Macで `codex login` を実行してください。",
      retrying: false,
    };
  }
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
  if (safeBasePath) params.set("base", safeBasePath);
  const provider = requestedAppProvider(url);
  if (provider) params.set("provider", provider);
  // A Home Screen web app has storage isolated from Safari. On the protected
  // install page, give iOS an explicit start_url that can seed that isolated
  // storage. Normal manifests remain public and token-free.
  if (url.pathname === "/install" && phoneToken && requestToken(url) === phoneToken) {
    params.set("install", "1");
    params.set("token", phoneToken);
  }
  const query = params.toString();
  return `site.webmanifest${query ? `?${query}` : ""}`;
}

function staticAssetHref(fileName) {
  const assetPath = path.join(root, "public", fileName);
  // Any UI file changing (including CSS, HTML or helpers) changes main.js's
  // URL too, so an already-open phone can detect more than a main.js edit.
  const clientBuild = bridgeBuildTracker?.status().clientFingerprint;
  const version = clientBuild ? `${clientBuild}-${phoneAppId}`
    : fs.existsSync(assetPath) ? `${Math.round(fs.statSync(assetPath).mtimeMs).toString(36)}-${phoneAppId}` : phoneAppId;
  return `${fileName}?v=${encodeURIComponent(version)}`;
}

const bridgeIconFiles = {
  codex: {
    default: {
      icon180: "bridge-icons/codex-default-180.png",
      icon512: "bridge-icons/codex-default-512.png",
    },
    air: {
      icon180: "bridge-icons/codex-air-180.png",
      icon512: "bridge-icons/codex-air-512.png",
    },
    mini: {
      icon180: "bridge-icons/codex-mini-180.png",
      icon512: "bridge-icons/codex-mini-512.png",
    },
    windows: {
      icon180: "bridge-icons/codex-windows-180.png",
      icon512: "bridge-icons/codex-windows-512.png",
    },
  },
  claude: {
    air: {
      icon180: "bridge-icons/claude-air-180.png",
      icon512: "bridge-icons/claude-air-512.png",
    },
    mini: {
      icon180: "bridge-icons/claude-mini-180.png",
      icon512: "bridge-icons/claude-mini-512.png",
    },
  },
};

function bridgeIconVariant({ provider = agentProvider, machineLabel = "", appId = "", appName = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const identity = [machineLabel, appId, appName]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (normalizedProvider === "codex" && /windows|win32|win64/.test(identity)) return "windows";
  if (/(?:^|[^a-z])mini(?:[^a-z]|$)|mac.?mini|mini.?codex|claude.?mini/.test(identity)) return "mini";
  if (/(?:^|[^a-z])air(?:[^a-z]|$)|macbook.?air|air.?codex|claude.?air/.test(identity)) return "air";
  return "default";
}

function bookmarkIconFiles({
  provider = agentProvider,
  machineLabel = phoneMachineLabel,
  appId = phoneAppId,
  appName = phoneAppName,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const variant = bridgeIconVariant({ provider: normalizedProvider, machineLabel, appId, appName });
  return (
    bridgeIconFiles[normalizedProvider]?.[variant] ||
    (normalizedProvider === "claude"
      ? { icon180: "bookmark-claude.png", icon512: "bookmark-claude-512.png" }
      : { icon180: "bookmark-codex.png", icon512: "bookmark-codex-512.png" })
  );
}

// `/install?token=...&provider=codex` on a Claude-default bridge (or the other
// way round) makes a Home Screen icon that opens in the other provider. The
// page title, the icon and the manifest all follow that parameter; without it
// the bridge's own default provider and names are used, as before.
function requestedAppProvider(url) {
  const value = String(url?.searchParams?.get("provider") || "")
    .trim()
    .toLowerCase();
  return value === "codex" || value === "claude" ? value : "";
}

function appIdentityForProvider(provider = "") {
  if (!provider) return { provider: agentProvider, appId: phoneAppId, name: phoneAppName, shortName: phoneAppShortName };
  const normalizedProvider = normalizeProvider(provider);
  const machine = phoneMachineLabel || String(uiPort);
  return {
    provider: normalizedProvider,
    appId: appIdSlug("", `${normalizedProvider}-${uiPort}`),
    name: `${defaultAppNameForProvider(normalizedProvider)} ${machine}`,
    shortName: `${defaultAppShortNameForProvider(normalizedProvider)} ${machine}`,
  };
}

function bookmarkIconFileName(provider = "") {
  return bookmarkIconFiles(provider ? { provider } : {}).icon180;
}

function bookmarkIcon512FileName(provider = "") {
  return bookmarkIconFiles(provider ? { provider } : {}).icon512;
}

function iconHrefForRequest(provider = "") {
  return staticAssetHref(bookmarkIconFileName(provider));
}

function serveIndex(req, res, { includeManifest = true, standalone = true, phoneToken = "" } = {}) {
  const indexPath = path.join(root, "public", "index.html");
  const identity = appIdentityForProvider(requestedAppProvider(new URL(req.url, `http://${req.headers.host}`)));
  const pageTitle = standalone ? identity.name : identity.shortName;
  const iconHref = iconHrefForRequest(identity.provider);
  let html = fs.readFileSync(indexPath, "utf8");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`)
    .replace(
      /<link rel="icon" type="image\/png" sizes="192x192" href="icon-192\.png" \/>/,
      `<link rel="icon" type="image/png" sizes="180x180" href="${escapeHtmlAttribute(iconHref)}" />`,
    )
    .replace(
      /<link rel="apple-touch-icon" href="apple-touch-icon\.png" \/>/,
      `<link rel="apple-touch-icon" sizes="180x180" href="${escapeHtmlAttribute(iconHref)}" />`,
    )
    .replace(/<link rel="stylesheet" href="style\.css" \/>/, `<link rel="stylesheet" href="${escapeHtmlAttribute(staticAssetHref("style.css"))}" />`)
    .replace(/<script src="main\.js"><\/script>/, `<script src="${escapeHtmlAttribute(staticAssetHref("main.js"))}"></script>`)
    .replace(/<script src="phone-ui-utils\.js"><\/script>/, `<script src="${escapeHtmlAttribute(staticAssetHref("phone-ui-utils.js"))}"></script>`)
    .replace(/<script src="operation-context\.js"><\/script>/, `<script src="${escapeHtmlAttribute(staticAssetHref("operation-context.js"))}"></script>`)
    .replace(
      /<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttribute(identity.shortName)}" />`,
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

function manifestPayloadForRequest(url, phoneToken = "") {
  const manifestPath = path.join(root, "public", "site.webmanifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const safeBasePath = safeProxyBasePath(url.searchParams.get("base"));
  const requestedProvider = requestedAppProvider(url);
  const identity = appIdentityForProvider(requestedProvider);
  manifest.name = identity.name;
  manifest.short_name = identity.shortName;
  manifest.id = `${safeBasePath}/codex-remote-${identity.appId}`;
  manifest.scope = `${safeBasePath}/`;
  manifest.description = `${identity.name} local phone bridge (${identity.provider}:${uiPort}).`;
  manifest.icons = [
    {
      src: `${safeBasePath}/${staticAssetHref(bookmarkIconFileName(identity.provider))}`,
      sizes: "180x180",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `${safeBasePath}/${staticAssetHref(bookmarkIcon512FileName(identity.provider))}`,
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ];
  // The start_url keeps the provider so the icon opens in the AI it was made
  // for; the token still travels in the fragment, never in the query.
  const providerQuery = requestedProvider ? `?provider=${requestedProvider}` : "";
  const authenticatedInstall = url.searchParams.get("install") === "1" && phoneToken && requestToken(url) === phoneToken;
  manifest.start_url = authenticatedInstall
    ? `${safeBasePath}/install${providerQuery}#token=${encodeURIComponent(phoneToken)}`
    : `${safeBasePath}/${providerQuery}`;
  return manifest;
}

function serveManifest(url, phoneToken, res) {
  if (url.searchParams.get("install") === "1" && !requireToken(url, phoneToken, res)) return;
  const manifest = manifestPayloadForRequest(url, phoneToken);
  res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(manifest, null, 2));
}

function stripUiDirectives(text, preserveWhitespace = false) {
  const cleaned = String(text || "")
    .replace(/(?:^|\n)::[a-z0-9-]+\{[^\n]*\}(?=\n|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  return preserveWhitespace ? cleaned : cleaned.trim();
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
  if (item.type === "agentMessage") return { type: "assistant", text: stripUiDirectives(item.text, true), ...(item.phase ? { phase: item.phase } : {}) };
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

const terminalHistoryLimit = 300;

function redactTerminalText(value) {
  return redactSensitiveText(value).slice(0, 1200);
}

function terminalKindForStatus(text) {
  if (/^\$\s/.test(text)) return "command";
  if (/file changes|ファイル/i.test(text)) return "file";
  if (/approval|承認/i.test(text)) return "approval";
  if (/error|failed|失敗|エラー/i.test(text)) return "error";
  if (/turn |接続|再接続|ready|completed|完了|切断/i.test(text)) return "lifecycle";
  return "status";
}

function terminalEntryForBridgeMessage(type, payload = {}, bridge = {}) {
  const now = Date.now();
  if (type === "status") {
    const message = redactTerminalText(payload.text || "");
    if (!message) return null;
    return { ts: now, kind: terminalKindForStatus(message), message, turnId: bridge.activeTurnId || null };
  }
  if (type === "error") {
    return { ts: now, kind: "error", message: redactTerminalText(payload.text || "エラー"), turnId: bridge.activeTurnId || null };
  }
  if (type === "approval") {
    return {
      ts: now,
      kind: "approval",
      message: redactTerminalText(`approval requested: ${payload.request?.method || "request"}`),
      turnId: bridge.activeTurnId || null,
    };
  }
  if (type === "turn") {
    return {
      ts: now,
      kind: "lifecycle",
      message: redactTerminalText(`turn ${payload.status || "updated"}${payload.turnId ? `: ${payload.turnId}` : ""}`),
      turnId: payload.turnId || bridge.activeTurnId || null,
    };
  }
  if (type === "user") {
    const count = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
    return {
      ts: now,
      kind: "user",
      message: `user prompt sent${count ? ` (${count} attachments)` : ""}`,
      turnId: bridge.activeTurnId || null,
    };
  }
  if (type === "event" && payload.event?.method) {
    const method = payload.event.method;
    const item = payload.event.params?.item;
    const liveText = summarizeLiveItem(item, method === "item/started" ? "started" : "completed");
    return {
      ts: now,
      kind: liveText ? terminalKindForStatus(liveText) : "status",
      message: redactTerminalText(liveText || `event: ${method}`),
      turnId: bridge.activeTurnId || null,
    };
  }
  return null;
}

function terminalHistoryFromChatHistory(history = []) {
  return (history || [])
    .map((entry, index) => {
      const text = redactTerminalText(entry.text || "");
      if (!text) return null;
      if (entry.type === "error") return { id: `history-error-${index}`, ts: Date.now(), kind: "error", message: text };
      if (entry.type !== "status") return null;
      return { id: `history-status-${index}`, ts: Date.now(), kind: terminalKindForStatus(text), message: text };
    })
    .filter(Boolean)
    .slice(-terminalHistoryLimit);
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

function capHistory(history) {
  return history.slice(-historyLimit);
}

// 作業ログ is the cheap half of a history: a retry storm is ten lines in a row,
// and cutting the tail would push out the messages those lines are notes about.
// So the overflow comes off the oldest status lines first, and only what is
// still over the limit after that comes off the front.
function capHistoryWithStatus(history, limit = historyLimit) {
  if (history.length <= limit) return history;
  let excess = history.length - limit;
  const kept = [];
  for (const entry of history) {
    if (excess > 0 && entry?.type === "status") {
      excess -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept.slice(-limit);
}

// A transcript holds far more than the conversation. System reminders, hook
// prompts and the observer chatter a memory plugin injects are all written as
// `user` records with isMeta set; a subagent's whole exchange lands on a
// sidechain; the compact summary arrives as a user turn; and when a second
// process resumes a session that is still being worked on, Claude Code writes a
// synthetic "Continue from where you left off." / "No response requested." pair
// to bridge the gap. None of it was typed by this user or answered to them, and
// showing it put words in both their mouths - most visibly by parking a
// synthetic non-answer under a real one, which read as the newest answer having
// been lost.
function isClaudeConversationRecord(item) {
  if (item.isMeta === true || item.isSidechain === true || item.isCompactSummary === true) return false;
  if (item.isApiErrorMessage === true) return false;
  return item.message?.model !== "<synthetic>";
}

// Two views of one session agree about content without agreeing about shape: a
// turn the bridge streamed as a single answer is written to the transcript as
// the separate messages it was made of, and only the transcript keeps the system
// reminders a user record can carry. Both are read as one whitespace-free
// string, so the comparisons below are about what was said.
function packedHistoryText(history = []) {
  return history
    .map((entry) => String(entry.text || ""))
    .join("")
    .replace(/\s+/g, "");
}

// Whether the file still holds the conversation the phone is already showing.
//
// Counting entries cannot answer that. Both views are capped at `historyLimit`,
// so a session past that cap grows without ever getting longer: `length <=
// length` stayed true for every later write, and the phone stopped following
// exactly the long chats it was opened to follow, while the sidebar went on
// listing them as active.
function claudeHistoryHoldsSameConversation(a = [], b = []) {
  return packedHistoryText(a) === packedHistoryText(b);
}

// The newest answer is the one the phone is looking at. A transcript that does
// not carry it - because the file is mid-write, or because something appended a
// turn of its own between our two reads - must not be allowed to redraw it off
// the screen.
function historyKeepsLatestAnswer(nextHistory = [], previousHistory = []) {
  const latest = [...previousHistory].reverse().find((entry) => entry.type === "assistant" && String(entry.text || "").trim());
  if (!latest) return true;
  const tail = String(latest.text).replace(/\s+/g, "").slice(-60);
  return !tail || packedHistoryText(nextHistory).includes(tail);
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

// Every workdir that has transcripts, the active one first. Sessions are filed
// per directory, so looking only at the active one is what made earlier work
// disappear from the sidebar the moment the workdir changed.
function claudeProjectDirs() {
  const current = path.resolve(claudeProjectDirFor());
  let names = [];
  try {
    names = fs.readdirSync(claudeProjectsRoot);
  } catch {
    return [current];
  }
  const others = [];
  for (const name of names) {
    const dir = path.resolve(claudeProjectsRoot, name);
    if (dir === current) continue;
    try {
      if (fs.statSync(dir).isDirectory()) others.push(dir);
    } catch {
      // Raced with a delete; nothing to list.
    }
  }
  return [current, ...others];
}

function claudeSessionFilePath(sessionId) {
  const id = String(sessionId || "").trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  const dirs = claudeProjectDirs();
  for (const base of dirs) {
    const target = path.resolve(base, `${id}.jsonl`);
    if (!target.startsWith(`${base}${path.sep}`)) continue;
    if (fs.existsSync(target)) return target;
  }
  // Nothing on disk yet: keep pointing at the active workdir so a new session
  // is filed where the bridge is working.
  const base = dirs[0];
  const target = path.resolve(base, `${id}.jsonl`);
  return target.startsWith(`${base}${path.sep}`) ? target : null;
}

function parseClaudeSessionFile(filePath, stat, text) {
  const sessionId = path.basename(filePath, ".jsonl");
  const history = [];
  let title = "";
  // `claude --name` and a desktop rename both write this. It is deliberate, so
  // it outranks the title Claude generated on its own.
  let customTitle = "";
  let firstUserText = "";
  let lastUserText = "";
  // The folder the session was started in, not the last one a turn happened to
  // run in. Claude Code files a transcript under the directory `claude` was
  // launched from and never re-files it, so `--resume` finds the session from
  // there and nowhere else. Taking the newest cwd instead put a long session
  // that had cd'd into a subfolder under that subfolder's heading, and opening
  // it from there resumed in a directory whose project slug holds no transcript
  // by that id — the CLI exits, and the chat the phone had just opened is left
  // showing an error instead of its own history.
  let cwd = "";
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = stat.mtimeMs;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && item.cwd) cwd = item.cwd;
    if (item.type === "ai-title" && item.aiTitle) title = String(item.aiTitle);
    if (item.type === "custom-title" && item.customTitle) customTitle = String(item.customTitle);
    const timestamp = Date.parse(item.timestamp || "");
    if (Number.isFinite(timestamp)) {
      createdAt = Math.min(createdAt, timestamp);
      updatedAt = Math.max(updatedAt, timestamp);
    }
    if (item.type !== "user" && item.type !== "assistant") continue;
    if (!isClaudeConversationRecord(item)) continue;
    const contentText = textFromClaudeContent(item.message?.content);
    if (!contentText.trim()) continue;
    const role = item.message?.role === "assistant" || item.type === "assistant" ? "assistant" : "user";
    if (role === "user") {
      if (!firstUserText) firstUserText = contentText;
      lastUserText = contentText;
    }
    history.push({
      type: role === "assistant" ? "assistant" : "user",
      text: contentText,
      outputGroup: item.uuid || item.requestId || sessionId,
    });
  }

  const fallbackTitle = firstUserText || sessionId;
  const firstTimestamp = Number.isFinite(createdAt) ? createdAt : stat.birthtimeMs;
  return {
    summary: {
      id: sessionId,
      name: customTitle || title || fallbackTitle,
      preview: lastUserText || fallbackTitle,
      cwd: cwd || workdir,
      provider: "claude",
      updatedAt,
      updated_at: updatedAt,
      createdAt: firstTimestamp,
      created_at: firstTimestamp,
    },
    history: capHistory(history),
  };
}

function readClaudeSessionFile(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const stat = fs.statSync(filePath);
  return parseClaudeSessionFile(filePath, stat, fs.readFileSync(filePath, "utf8"));
}

async function readClaudeSessionFileAsync(filePath) {
  if (!filePath) return null;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    const text = await fs.promises.readFile(filePath, "utf8");
    return parseClaudeSessionFile(filePath, stat, text);
  } catch {
    return null;
  }
}

function readClaudeSession(sessionId) {
  return readClaudeSessionFile(claudeSessionFilePath(sessionId));
}

function claudeHistoryForSession(sessionId) {
  return readClaudeSession(sessionId)?.history || [];
}

// A session belongs to the directory it was started in. Now that the sidebar
// lists every workdir, resuming one from wherever the bridge happens to be
// pointing would file the continuation under a different project and leave the
// original looking abandoned.
function requestedWorkdirOr(requested, fallback = workdir) {
  if (!requested) return fallback;
  try {
    return validateWorkdir(requested);
  } catch {
    return fallback;
  }
}

function claudeSessionWorkdir(session, fallback = workdir) {
  const cwd = String(session?.summary?.cwd || "").trim();
  if (!cwd || path.resolve(cwd) === path.resolve(fallback)) return fallback;
  // Deliberately not validateWorkdir: its home-folder rule exists to constrain
  // what a phone may ask for over the network, and this is not that. It is where
  // the local `claude` already ran, read back out of its own transcript — an
  // external volume is a perfectly ordinary place to keep a repo. Silently
  // running somewhere else is the real hazard: the answer then describes a
  // different folder than the row the session was opened from.
  try {
    const target = path.resolve(cwd);
    return fs.statSync(target).isDirectory() ? target : fallback;
  } catch {
    // Gone. Opening the history read-only beats refusing to show the session.
    return fallback;
  }
}

// The list is polled, and it now spans every workdir, so re-reading every
// transcript each time would make it too slow to leave on. A summary stays good
// until the file changes underneath it.
const claudeSummaryCache = new Map();
const claudeSummaryCacheLimit = 500;

async function claudeSessionSummary(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
  } catch {
    claudeSummaryCache.delete(filePath);
    return null;
  }
  const cached = claudeSummaryCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
  const parsed = await readClaudeSessionFileAsync(filePath);
  if (!parsed) return null;
  if (claudeSummaryCache.size >= claudeSummaryCacheLimit) {
    claudeSummaryCache.delete(claudeSummaryCache.keys().next().value);
  }
  claudeSummaryCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary: parsed.summary });
  return parsed.summary;
}

// Statting is cheap and parsing is not, so the cap is applied before any
// transcript is opened.
const claudeSessionsPerProject = Number(process.env.PHONE_CLAUDE_SESSIONS_PER_PROJECT || 20) || 20;

// How closely an open session follows work happening in the desktop app or the
// terminal. One stat per second against one file, only while a phone is looking
// at it.
const claudeSessionWatchIntervalMs = Math.max(250, Number(process.env.PHONE_CLAUDE_WATCH_INTERVAL_MS || 1000) || 1000);

async function claudeProjectSessionFiles(dir, limit = claudeSessionsPerProject) {
  let fileNames = [];
  try {
    fileNames = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, fileName);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) files.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // Raced with a delete.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit).map((file) => file.filePath);
}

async function claudeThreadListPayload() {
  const byId = new Map();
  const files = (await Promise.all(claudeProjectDirs().map((dir) => claudeProjectSessionFiles(dir)))).flat();
  const summaries = await Promise.all(files.map((filePath) => claudeSessionSummary(filePath)));
  const hidden = new Set(hiddenWorkspaces());
  const active = normalizeWorkspacePath(workdir);
  for (const summary of summaries) {
    if (!summary) continue;
    // Never hide the workdir the bridge is running in: there would be no way
    // back to it from a sidebar that no longer lists it.
    const cwd = normalizeWorkspacePath(summary.cwd);
    if (cwd !== active && hidden.has(cwd)) continue;
    // The active workdir is scanned first, so it wins a duplicate id.
    if (!byId.has(summary.id)) byId.set(summary.id, summary);
  }
  return {
    provider: "claude",
    activeProvider: "claude",
    hiddenProjects: hiddenWorkspaces().filter((item) => item !== active),
    data: mergeThreadListData(Array.from(byId.values()), localThreadList("claude")),
  };
}

// An app-server connection can also receive other threads' events (including
// subagent output). Socket ownership is not conversation ownership. Check the
// scope before touching history, run state, approval state, or queued work.
function codexMessageMatchesThread(message, threadId) {
  if (!message.method) return true; // Responses are correlated by request id.
  const params = message.params || {};
  const ids = [params.threadId, params.thread_id, params.thread?.id, params.conversationId, params.conversation_id]
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length) return Boolean(threadId) && ids.every((id) => id === threadId);
  // Global account notifications have no thread. Conversation notifications
  // and server requests without an owner must never enter a session.
  return !/^(thread\/|turn\/|item\/|codex\/event\/)|^error$/.test(message.method)
    && !message.method.endsWith("/requestApproval");
}

class SharedBridge {
  constructor(requestedThreadId, baseBridgeKey, options = {}) {
    this.provider = "codex";
    this.model = modelForProvider(this.provider);
    this.requestedThreadId = requestedThreadId;
    this.workdir = options.workdir ? validateWorkdir(options.workdir) : workdir;
    this.serviceTier = Object.prototype.hasOwnProperty.call(options, "serviceTier") ? normalizeServiceTier(options.serviceTier) : null;
    this.baseBridgeKey = baseBridgeKey;
    this.bridgeKey = bridgeMapKey(this.provider, baseBridgeKey);
    this.clients = new Set();
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = null;
    this.activeTurnId = null;
    this.createdAt = Date.now();
    this.listUpdatedAt = 0;
    this.ready = false;
    this.startupFailed = false;
    this.history = [];
    this.terminalHistory = [];
    this.pendingApproval = null;
    this.turnQueue = [];
    this.runState = { state: "connecting", label: "接続中", turnId: null, updatedAt: Date.now() };
    this.streamingStarted = false;
    this.turnStarted = false;
    this.seenUserItems = new Set();
    this.localUserEcho = null;
    this.interruptRequested = false;
    this.idleDisposeTimer = null;
    this.longRunningTimer = null;
    this.disposing = false;
    this.connectionLostReported = false;
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
    const thread = threadRecordForBridge(this);
    return {
      provider: this.provider,
      threadId: this.threadId,
      threadTitle: thread?.displayTitle || thread?.name || "",
      thread,
      model: this.model,
      workdir: this.workdir,
      ...currentWorkspaceMeta(this.workdir),
      shared: true,
      clients: this.clients.size,
      history: this.history,
      terminalHistory: this.terminalHistory,
      // Codex reports no command list of its own, and the field has to be here
      // to say so: without it a phone arriving from a Claude chat keeps that
      // chat's commands on screen and offers `/context` to Codex.
      slashCommands: [],
      run: this.runPayload(),
    };
  }

  runPayload() {
    // The open request outranks the turn waiting on it, the way ClaudeBridge
    // reports it: without this, a phone that reconnected mid-approval was told
    // the run was 処理中, threw away the card it still had, and Codex waited on
    // an answer nobody could give.
    if (this.pendingApproval) {
      return {
        state: "approval",
        label: "承認待ち",
        turnId: this.activeTurnId,
        pendingApproval: this.pendingApproval,
        updatedAt: Date.now(),
        ...currentWorkspaceMeta(this.workdir),
      };
    }
    if (this.activeTurnId) {
      if (this.runState?.state === "interrupting") return { ...this.runState, ...currentWorkspaceMeta(this.workdir) };
      return {
        state: this.streamingStarted ? "streaming" : "running",
        label: this.streamingStarted ? "回答生成中" : "Agent 処理中",
        turnId: this.activeTurnId,
        updatedAt: Date.now(),
        ...currentWorkspaceMeta(this.workdir),
      };
    }
    return {
      ...(this.runState || { state: "ready", label: "未実行・送信できます", turnId: null, updatedAt: Date.now() }),
      ...currentWorkspaceMeta(this.workdir),
    };
  }

  setBridgeRunState(state, label, turnId = this.activeTurnId || null) {
    const next = { state, label, turnId, updatedAt: Date.now(), ...currentWorkspaceMeta(this.workdir) };
    const previous = this.runState || {};
    // Codex waits for the answer for as long as the turn runs, so the held
    // request outlives a stream update and is only dropped when the turn is
    // no longer running.
    const turnStillRunning = state === "running" || state === "streaming" || state === "interrupting";
    if (state !== "approval" && !turnStillRunning) this.pendingApproval = null;
    this.runState = next;
    lastBridgeEventAt = Date.now();
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

  appendTerminal(entry) {
    if (!entry) return null;
    const next = {
      id: entry.id || `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: entry.ts || Date.now(),
      kind: entry.kind || "status",
      message: redactTerminalText(entry.message || ""),
      detail: entry.detail ? redactTerminalText(entry.detail).slice(0, 4000) : "",
      turnId: entry.turnId || this.activeTurnId || null,
    };
    this.terminalHistory.push(next);
    this.terminalHistory = this.terminalHistory.slice(-terminalHistoryLimit);
    return next;
  }

  emit(type, payload = {}) {
    lastBridgeEventAt = Date.now();
    const terminalEntry = this.appendTerminal(terminalEntryForBridgeMessage(type, payload, this));
    const body = JSON.stringify({ type, threadId: this.threadId, ...(terminalEntry ? { terminalEntry } : {}), ...payload });
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
    this.disposing = true;
    this.cancelIdleDispose();
    clearLongRunningNotification(this);
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

  observeTurnStart(turnId, started = false) {
    if (!turnId) return;
    const changed = this.activeTurnId !== turnId;
    if (changed) {
      this.activeTurnId = turnId;
      this.streamingStarted = false;
      this.turnStarted = false;
      scheduleLongRunningNotification(this, turnId);
      this.setBridgeRunState("running", "Agent 処理中", turnId);
      this.emit("turn", { status: "started", turnId, run: this.runPayload() });
    }
    // Notifications can precede the reply to our own turn/start request.
    // A late reply must not reset streaming or disable the interrupt button.
    this.turnStarted = this.turnStarted || started;
  }

  observeUserItem(item, turnId) {
    if (item?.type !== "userMessage") return;
    const key = `${turnId || this.activeTurnId}:${item.id || JSON.stringify(item.content)}`;
    this.seenUserItems ||= new Set();
    if (this.seenUserItems.has(key)) return;
    this.seenUserItems.add(key);
    if (this.seenUserItems.size > historyLimit) this.seenUserItems.delete(this.seenUserItems.values().next().value);
    const entry = summarizeItem(item);
    const local = this.localUserEcho;
    if (local && (!local.turnId || local.turnId === turnId)
      && local.text === item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")) {
      this.localUserEcho = null;
      return;
    }
    this.appendHistory({ ...entry, outputGroup: turnId || this.activeTurnId || null });
    this.emit("user", { text: entry.text, attachments: entry.attachments || [] });
  }

  promoteBridgeKey() {
    if (!shouldPromoteBridgeKey({ bridgeKey: this.baseBridgeKey, threadId: this.threadId })) return;
    const previousKey = this.bridgeKey;
    const nextKey = bridgeMapKey(this.provider, this.threadId);
    if (bridges.has(nextKey) && bridges.get(nextKey) !== this) return;
    if (bridges.get(previousKey) !== this) return;
    this.baseBridgeKey = this.threadId;
    this.bridgeKey = nextKey;
    bridges.delete(previousKey);
    bridges.set(this.bridgeKey, this);
  }

  requestNewThread(statusText = "新しいthreadを開始中...") {
    const id = this.request("thread/start", {
      model: this.model,
      serviceTier: this.serviceTier,
      cwd: this.workdir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    this.pending.set(id, "thread/start");
    this.emit("status", { text: statusText });
  }

  recoverEmptyThread(thread) {
    if (thread?.id !== this.requestedThreadId) return false;
    const originalWorkdir = emptyCodexThreadWorkdir(thread);
    if (!originalWorkdir) return false;
    try { this.workdir = validateWorkdir(originalWorkdir); } catch { return false; }
    debugLog("codex.resume.empty", { threadId: thread.id, workdir: this.workdir });
    this.emit("status", { text: "この会話はまだメッセージが送信されていません。元のフォルダで入力画面を開き直します。" });
    this.requestedThreadId = null;
    const previousKey = this.bridgeKey;
    if (bridges.get(previousKey) === this) bridges.delete(previousKey);
    this.baseBridgeKey = `new:${crypto.randomUUID()}`;
    this.bridgeKey = bridgeMapKey(this.provider, this.baseBridgeKey);
    bridges.set(this.bridgeKey, this);
    this.requestNewThread("新しいthreadを開始中...");
    return true;
  }

  failStartup(text, details = {}) {
    this.startupFailed = true;
    this.ready = false;
    this.setBridgeRunState("error", "会話を開けません", null);
    this.emit("error", { text, ...details });
  }

  completeStartup(result) {
    if (result.initialTurnsPage) result = { ...result, thread: withRecentTurns(result.thread, result.initialTurnsPage) };
    this.threadId = result.thread.id;
    const resumedWorkdir = result.cwd || result.thread.cwd;
    if (resumedWorkdir) {
      try { this.workdir = validateWorkdir(resumedWorkdir); } catch {
        this.failStartup("この会話の作業フォルダを開けません。元のフォルダがこの Mac にあるか確認してください。");
        return;
      }
    }
    this.model = result.model || this.model;
    this.startupFailed = false;
    this.promoteBridgeKey();
    this.ready = true;
    this.history = historyFromThread(result.thread);
    this.seenUserItems = new Set((result.thread.turns || []).flatMap((turn) =>
      (turn.items || []).filter((item) => item.type === "userMessage").map((item) => `${turn.id}:${item.id}`)).slice(-historyLimit));
    this.terminalHistory = terminalHistoryFromChatHistory(this.history);
    const activeTurn = (result.thread.turns || []).findLast((turn) => turn.status === "inProgress");
    this.activeTurnId = activeTurn?.id || null;
    this.turnStarted = Boolean(activeTurn);
    const idleState = activeTurn
      ? { state: "running", label: "Agent 処理中", turnId: activeTurn.id }
      : idleRunStateFromHistory(this.history, runStateFromSessionFile(result.thread));
    this.setBridgeRunState(idleState.state, idleState.label, idleState.turnId);
    this.emit("ready", this.readyPayload());
    if (this.requestedThreadId) this.emit("status", { text: `既存threadを再開しました: ${this.threadId}` });
  }

  bindUpstream() {
    this.upstream.on("open", () => {
      this.request("initialize", {
        clientInfo: { name: "codex-phone-bridge", title: "Codex Phone Bridge", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.upstream.send(JSON.stringify({ method: "initialized", params: {} }));
      if (!this.requestedThreadId) {
        this.requestNewThread();
        return;
      }
      const id = this.request("thread/resume", {
        threadId: this.requestedThreadId,
        excludeTurns: true,
        initialTurnsPage: { ...recentTurnsOptions },
      });
      this.pending.set(id, "thread/resume");
      this.emit("status", { text: "既存threadを再開中..." });
    });

    this.upstream.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (!codexMessageMatchesThread(msg, this.threadId || this.requestedThreadId)) {
        debugLog("codex.event.ignored", { method: msg.method, expectedThreadId: this.threadId || this.requestedThreadId, threadId: msg.params?.threadId });
        return;
      }
      // Server requests and client requests use separate id namespaces.
      const pendingMethod = msg.method ? undefined : this.pending.get(msg.id);

      if (pendingMethod === "thread/read:persist-start") {
        this.pending.delete(msg.id);
        const started = this.pendingStartedThread;
        this.pendingStartedThread = null;
        if (!started || (msg.error && !isUnavailableHistoryError(msg.error))
          || (msg.result?.thread?.id && msg.result.thread.id !== started.thread.id)
          || !hasSavedCodexThread(started.thread)) {
          debugLog("codex.start.save-failed", { threadId: started?.thread?.id, error: msg.error?.message });
          this.failStartup("新しい会話の保存を確認できませんでした。送信せず、接続状態を確認してから新規作成をやり直してください。");
          return;
        }
        this.completeStartup({ ...started, thread: msg.result?.thread || started.thread });
        return;
      }

      if (pendingMethod === "thread/read:resume-recovery") {
        this.pending.delete(msg.id);
        if (!msg.error && this.recoverEmptyThread(msg.result?.thread)) return;
        this.failStartup("この会話の履歴を開けませんでした。会話は切り替えていません。一覧から元の会話を選び直してください。");
        return;
      }

      if (pendingMethod === "thread/start" || pendingMethod === "thread/resume") {
        this.pending.delete(msg.id);
        if (msg.error) {
          const compact = compactCodexError(msg.error.message || JSON.stringify(msg.error));
          const error = new Error(compact.text);
          debugLog("codex.resume.failed", { method: pendingMethod, threadId: this.requestedThreadId, error: msg.error.message });
          if (pendingMethod === "thread/resume" && isUnavailableHistoryError(error)) {
            const id = this.request("thread/read", { threadId: this.requestedThreadId, includeTurns: false });
            this.pending.set(id, "thread/read:resume-recovery");
            return;
          }
          this.failStartup(compact.text, compact.code ? { code: compact.code, retryable: compact.retryable } : {});
          return;
        }
        if (pendingMethod === "thread/start" && !hasSavedCodexThread(msg.result.thread)) {
          this.pendingStartedThread = msg.result;
          // Codex materializes its initial record on a full history read, even
          // when a paginated empty history reports an unsupported-turns error.
          const id = this.request("thread/read", { threadId: msg.result.thread.id, includeTurns: true });
          this.pending.set(id, "thread/read:persist-start");
          this.emit("status", { text: "新しい会話の保存を確認中..." });
          return;
        }
        this.completeStartup(msg.result);
        return;
      }

      if (pendingMethod === "turn/start") {
        this.pending.delete(msg.id);
        if (msg.error) {
          this.localUserEcho = null;
          this.interruptRequested = false;
          const error = compactCodexError(msg.error.message || JSON.stringify(msg.error));
          this.emit(error.retrying ? "status" : "error", { text: error.text });
          this.setBridgeRunState(error.retrying ? "running" : "error", error.retrying ? "再試行中" : "開始に失敗");
          if (!error.retrying) {
            notifyRunEvent("failed", {
              provider: this.provider,
              model: this.model,
              threadId: this.threadId,
              message: error.text,
              workdir: this.workdir,
            });
          }
          this.startNextQueuedTurn();
        } else {
          if (this.localUserEcho) this.localUserEcho.turnId = msg.result.turn.id;
          this.observeTurnStart(msg.result.turn.id);
          if (this.interruptRequested) {
            this.setBridgeRunState("interrupting", "開始後に中断します", this.activeTurnId);
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

      if (msg.method === "turn/started") {
        this.observeTurnStart(msg.params.turn?.id || msg.params.turnId, true);
        this.flushPendingInterrupt();
        return;
      }

      if (msg.method === "item/agentMessage/delta") {
        this.turnStarted = true;
        if (!this.streamingStarted) {
          this.streamingStarted = true;
          this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
        }
        this.flushPendingInterrupt();
        this.emit("assistantDelta", { text: msg.params.delta });
        return;
      }

      if (msg.method === "item/started") {
        this.turnStarted = true;
        this.observeUserItem(msg.params.item, msg.params.turnId);
        this.flushPendingInterrupt();
        const text = summarizeLiveItem(msg.params.item, "started");
        if (text) this.emit("status", { text });
        return;
      }

      if (msg.method === "item/completed") {
        this.turnStarted = true;
        this.observeUserItem(msg.params.item, msg.params.turnId);
        this.flushPendingInterrupt();
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
        this.localUserEcho = null;
        this.interruptRequested = false;
        this.activeTurnId = null;
        this.streamingStarted = false;
        this.turnStarted = false;
        clearLongRunningNotification(this);
        const question = latestAssistantQuestion(this, completedTurnId);
        this.setBridgeRunState(
          wasInterrupted ? "interrupted" : question ? "question" : "done",
          wasInterrupted ? "中断しました" : question ? "返信待ち" : "完了しました",
          completedTurnId,
        );
        this.emit("turn", { status: "completed", turnId: completedTurnId, run: this.runPayload() });
        // One message per finished turn. A turn that ended on a question is
        // announced as the question, which is the part the reader has to act
        // on; a second "finished" message under it said the same thing twice.
        if (!wasInterrupted && question) {
          notifyBridgeEvent("question_required", {
            bridge: this,
            turnId: completedTurnId,
            severity: "warning",
            detail: question,
            force: true,
          });
        } else {
          notifyRunEvent(wasInterrupted ? "interrupted" : "completed", {
            bridge: this,
            model: this.model,
            turnId: completedTurnId,
          });
        }
        this.syncHistory("turn completed");
        this.startNextQueuedTurn();
        this.scheduleIdleDispose();
        return;
      }

      if (msg.method === "serverRequest/resolved") {
        if (this.pendingApproval?.id === msg.params.requestId) {
          this.pendingApproval = null;
          this.setBridgeRunState(this.streamingStarted ? "streaming" : "running", "別の画面で承認に回答しました", this.activeTurnId);
        }
        return;
      }

      if (msg.method && msg.method.endsWith("/requestApproval")) {
        this.pendingApproval = msg;
        this.setBridgeRunState("approval", "承認待ち", this.activeTurnId);
        this.emit("approval", { request: msg });
        const approval = approvalDetail(msg);
        // With no phone connected, the notification is the only way the
        // question reaches anyone, so it goes out whether or not event
        // notifications are switched on.
        notifyBridgeEvent("approval_required", {
          bridge: this,
          turnId: this.activeTurnId,
          severity: "warning",
          detail: approval.text,
          questionCount: approval.questionCount || 0,
          force: !this.clients.size,
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
        clearLongRunningNotification(this);
        this.setBridgeRunState("error", "エラー", this.activeTurnId);
        this.emit("error", { text: error.text });
        notifyRunEvent("failed", {
          bridge: this,
          model: this.model,
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
      clearLongRunningNotification(this);
      // Closing a socket that is still opening makes ws report an error before
      // the close, so a bridge we tore down ourselves fails on the way out. It
      // is not a failure anyone has to hear about.
      if (this.disposing) return;
      const compact = compactCodexError(error.message);
      this.ready = false;
      this.setBridgeRunState("error", "接続エラー", this.activeTurnId || null);
      this.emit("error", { text: compact.text, ...(compact.code ? { code: compact.code, retryable: compact.retryable } : {}) });
      // A connection lost mid-turn is one event for the reader - the work
      // failed, and this is why - not a "connection lost" message followed by a
      // "failed" message about the same moment. A socket that never opened
      // reports `error` and then `close`, and that close is the same moment
      // again, so this message is the one that stands for it.
      this.connectionLostReported = true;
      if (this.activeTurnId) {
        notifyRunEvent("failed", {
          bridge: this,
          model: this.model,
          turnId: this.activeTurnId,
          message: `Codexとの接続が切れました（${error.message}）`,
        });
      } else {
        notifyBridgeEvent("connection_lost", {
          bridge: this,
          severity: "error",
          detail: error.message,
        });
      }
      if (shouldStartCodexServer && isCodexConnectionFailure(error)) {
        ensureCodexServerRunning().catch((restartError) => {
          this.emit("error", { text: `Codex app-serverを再起動できませんでした: ${restartError.message}` });
        });
      }
    });
    this.upstream.on("close", () => {
      if (!this.ready) this.startupFailed = true;
      this.interruptRequested = false;
      clearLongRunningNotification(this);
      this.emit("status", { text: "Codex接続が閉じました" });
      // A bridge taken down on purpose - swapped for another folder, cleaned up
      // after going idle, replaced when the phone dials again - closes its own
      // socket, and this handler cannot tell that from Codex hanging up. It
      // used to announce both as 接続が切れました: a warning that arrives while
      // the work it names keeps running on another bridge, several at once
      // whenever a reconnect swept the idle ones. Only a close nobody asked
      // for is news.
      if (this.disposing) return;
      if (this.activeTurnId) this.setBridgeRunState("error", "接続が閉じました", this.activeTurnId);
      if (!this.connectionLostReported) {
        this.connectionLostReported = true;
        notifyBridgeEvent("connection_lost", {
          bridge: this,
          turnId: this.activeTurnId,
          severity: "warning",
          detail: "Codex側が接続を閉じました。",
        });
      }
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

  flushPendingInterrupt() {
    if (!this.interruptRequested || !this.activeTurnId || !this.turnStarted) return;
    try {
      this.interruptRequested = false;
      if (!this.sendTurnInterrupt(this.activeTurnId)) this.emit("status", { text: "中断要求はすでに送信済みです。" });
    } catch (error) {
      this.setBridgeRunState("error", "中断に失敗", this.activeTurnId);
      this.emit("error", { text: `中断要求の送信に失敗しました: ${error.message}` });
    }
  }

  interrupt() {
    const queuedCount = this.turnQueue.length;
    this.turnQueue = [];
    if (queuedCount) this.emit("status", { text: `待機中の送信を破棄しました（${queuedCount}件）。` });

    if (this.activeTurnId) {
      if (!this.turnStarted) {
        this.interruptRequested = true;
        this.setBridgeRunState("interrupting", "開始後に中断します", this.activeTurnId);
        this.emit("status", { text: "開始待ちの処理を中断予約しました。" });
        return;
      }
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

  prompt(text, attachments = [], options = {}, clientMessageId = null, context = null) {
    context = { ...operationContext.normalize(context), receivedAt: Date.now() };
    if (!this.threadId) {
      this.emit("error", { text: "Thread is not ready yet" });
      return;
    }
    if (this.activeTurnId || this.hasPendingTurnStart()) {
      this.turnQueue.push({ text, attachments, options, clientMessageId, context });
      if (clientMessageId) this.emit("promptAccepted", { clientMessageId, queued: true });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options, clientMessageId, context);
    } catch (error) {
      this.emit("error", browserOperationError(error, "送信に失敗しました: "));
    }
  }

  startNextQueuedTurn() {
    if (!this.ready || this.activeTurnId || this.hasPendingTurnStart() || !this.turnQueue.length) return;
    try {
      const next = this.turnQueue.shift();
      this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
      this.startPrompt(next.text, next.attachments, next.options, next.clientMessageId, next.context);
    } catch (error) {
      this.emit("error", browserOperationError(error, "送信に失敗しました: "));
      this.startNextQueuedTurn();
    }
  }

  syncHistory(reason) {
    const enabled = historySyncEnabledForProvider(this.provider);
    if (!this.threadId || !enabled) return;
    lastHistorySync.enabled = enabled;
    runHistorySync({
      threadId: this.threadId,
      workdir: this.workdir,
      request: appServerRequest,
      enabled,
    })
      .then((result) => {
        if (!result.skipped) {
          lastHistorySync = { enabled, lastSuccessAt: new Date().toISOString(), lastFailureAt: lastHistorySync.lastFailureAt, lastError: "" };
          this.emit("status", { text: `履歴同期を更新しました (${reason})` });
        }
      })
      .catch((error) => {
        lastHistorySync = { enabled, lastSuccessAt: lastHistorySync.lastSuccessAt, lastFailureAt: new Date().toISOString(), lastError: error.message };
        notifyBridgeEvent("history_sync_failed", {
          provider: this.provider,
          threadId: this.threadId,
          severity: "error",
          title: "履歴同期に失敗しました",
          message: error.message,
        });
        this.emit("status", { text: `履歴同期に失敗しました: ${error.message}` });
      });
  }

  startPrompt(text, attachments = [], options = {}, clientMessageId = null, context = null) {
    this.interruptRequested = false;
    this.turnStarted = false;
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
      additionalContext: {
        "phone-operation-context": { kind: "application", value: operationContext.modelContext(context, phoneMachineLabel) },
      },
    };
    params.model = options.model || this.model;
    // Overrides the reasoning effort for this turn and the ones after it. Left
    // out, the thread keeps whatever `model_reasoning_effort` in the Codex
    // config says, which is what made the phone's depth menu do nothing.
    const effort = codexEffortLevel(options, params.model);
    if (effort) params.effort = effort;
    if (Object.prototype.hasOwnProperty.call(options, "serviceTier")) params.serviceTier = normalizeServiceTier(options.serviceTier);
    if (options.approvalPolicy) params.approvalPolicy = options.approvalPolicy;
    if (options.sandboxMode) params.sandboxPolicy = sandboxPolicyForMode(options.sandboxMode);
    const id = this.request("turn/start", {
      ...params,
    });
    this.localUserEcho = { text: input[0].text, turnId: null };
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
    if (entry?.text) this.listUpdatedAt = Date.now();
  }

  approval(requestMsg, decision) {
    const pending = this.pendingApproval;
    if (!pending || requestMsg?.id !== pending.id || requestMsg?.method !== pending.method
      || !codexMessageMatchesThread(requestMsg, this.threadId)
      || !codexMessageMatchesThread(pending, this.threadId)) return;
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
    this.pendingApproval = null;
    this.setBridgeRunState("running", accept ? "承認済み・処理中" : "拒否済み・処理中", this.activeTurnId);
    this.emit("status", { text: accept ? "承認しました" : "拒否しました" });
  }
}

// Skills describe themselves in SKILL.md frontmatter. Read once per bridge run:
// the set only changes when files change, and the phone asks on every turn.
let skillDescriptionCache = null;

function skillDescriptionsFromDisk() {
  if (skillDescriptionCache) return skillDescriptionCache;
  const descriptions = {};
  const roots = [path.join(os.homedir(), ".claude", "skills"), path.join(workdir, ".claude", "skills")];
  for (const dir of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // No isDirectory() check: skills are commonly symlinked in from a shared
      // folder, and a symlink reports as neither a file nor a directory here.
      // Reading through the name settles it, and anything else lands in catch.
      try {
        const head = fs.readFileSync(path.join(dir, entry.name, "SKILL.md"), "utf8").slice(0, 4000);
        const frontmatter = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!frontmatter) continue;
        // `description:` runs to the next top-level key, folded or not.
        const described = frontmatter[1].match(/^description:\s*(>-?|\|-?)?[ \t]*\r?\n?([\s\S]*?)(?=\r?\n[a-zA-Z_-]+:|$)/m);
        if (described) descriptions[entry.name] = described[2].replace(/\s+/g, " ").trim();
      } catch {
        // A skill that cannot be read is listed without a description.
      }
    }
  }
  skillDescriptionCache = descriptions;
  return descriptions;
}

const approvalMcpScript = path.join(root, "scripts", "claude-approval-mcp.js");
const approvalMcpServerName = "phone_approval";
// How long an open approval or question waits for an answer before it is
// declined. The person it is for is usually not looking at the phone when it is
// asked - that is what the notification is for - and five minutes was shorter
// than the walk back to the phone: the card had already been declined and the
// turn had carried on without an answer by the time the app was opened. Claude
// Code aborts a stdio MCP tool call that stays silent for 30 minutes, so the
// wait has to end before that.
const approvalTimeoutMs = Number(process.env.PHONE_APPROVAL_TIMEOUT_MS || 20 * 60 * 1000);
const approvalSocketPaths = new Set();

function claudePermissionMode(options = {}) {
  if (options.permissionMode) return options.permissionMode;
  if (options.sandboxMode === "danger-full-access" || options.approvalPolicy === "never") return "bypassPermissions";
  if (options.sandboxMode === "read-only") return "plan";
  // 確認モード asks for on-request approval, so stay in `default` where unmatched
  // tools fall through to the permission prompt tool instead of auto-approving.
  if (options.approvalPolicy === "on-request") return process.env.CLAUDE_PERMISSION_MODE || "default";
  return process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";
}

// The approval channel is attached in every permission mode, フルアクセス
// included. It used to be left off there, on the reading that bypassPermissions
// approves everything before the prompt tool is consulted. It does not: a
// PreToolUse hook answering "ask", and Claude Code's own residual prompts, still
// stop the tool call. Without a prompt tool to route them to, headless Claude
// records a permission denial and narrates that it needs confirmation - the
// phone showed a spinner and no way to answer, and the only way through was the
// desktop or the official app.
//
// Attaching it costs nothing when nothing asks: in bypassPermissions an ordinary
// tool call never reaches the prompt tool, so full access stays full access.

// A Unix socket per bridge, never a port: the fleet runs several bridges at once
// and a fixed-port approval channel would collide on the second one.
function approvalSocketPathFor(bridgeKey) {
  const suffix = crypto.createHash("sha1").update(`${process.pid}:${bridgeKey}`).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), `phone-approval-${process.pid}-${suffix}.sock`);
}

function removeApprovalSocket(socketPath) {
  approvalSocketPaths.delete(socketPath);
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  } catch {
    // Best effort: a leftover socket file is harmless on the next run.
  }
}

function approvalMcpConfig(socketPath) {
  return JSON.stringify({
    mcpServers: {
      [approvalMcpServerName]: {
        type: "stdio",
        command: process.execPath,
        args: [approvalMcpScript],
        env: {
          PHONE_APPROVAL_SOCKET: socketPath,
          PHONE_APPROVAL_TIMEOUT_MS: String(approvalTimeoutMs),
          PHONE_APPROVAL_SERVER_NAME: approvalMcpServerName,
        },
      },
    },
  });
}

const askQuestionToolName = "AskUserQuestion";
const maxAnswerLength = 2000;

function askUserQuestions(params = {}) {
  if (params.toolName !== askQuestionToolName) return [];
  const questions = params.input?.questions;
  return Array.isArray(questions) ? questions.filter((question) => typeof question?.question === "string" && question.question) : [];
}

// The phone is not trusted to say what was asked, only what was chosen: answers
// are matched back to the questions the tool actually sent, and anything else in
// the message is dropped. Keyed by question text because that is the key
// `AskUserQuestion` reads its answers under.
function questionAnswersFor(params, answers) {
  const questions = askUserQuestions(params);
  if (!questions.length || !answers || typeof answers !== "object") return null;
  const cleaned = {};
  for (const question of questions) {
    const value = answers[question.question];
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, maxAnswerLength);
    if (trimmed) cleaned[question.question] = trimmed;
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

// The phone sends a slash command as ordinary prompt text, so the only way to
// know a turn is one is to read it back off the front of the prompt.
function slashCommandFromPrompt(text) {
  const match = /^\s*\/([\w:-]+)/.exec(String(text || ""));
  return match ? match[1].toLowerCase() : "";
}

function truncateStatusText(value, limit = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function claudeToolPath(value, base) {
  const raw = String(value || "");
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.relative(base || workdir, raw) || raw : raw;
}

// Mirrors the Codex side's live status vocabulary (`$ cmd`, `file changes: …`)
// so both providers read the same way in the collapsed status log.
function summarizeClaudeToolUse(block, base) {
  if (!block || block.type !== "tool_use") return null;
  const name = String(block.name || "");
  const input = block.input || {};
  if (name === "Bash" || name === "BashOutput") return truncateStatusText(`$ ${input.command || input.description || ""}`);
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    return truncateStatusText(`file changes: ${claudeToolPath(input.file_path || input.notebook_path, base)}`);
  }
  if (name === "Read") return truncateStatusText(`read: ${claudeToolPath(input.file_path, base)}`);
  if (name === "Glob") return truncateStatusText(`glob: ${input.pattern || ""}`);
  if (name === "Grep") return truncateStatusText(`grep: ${input.pattern || ""}`);
  if (name === "Task" || name === "Agent") {
    return truncateStatusText(`subagent: ${input.description || input.subagent_type || ""}`);
  }
  if (name === "WebFetch") return truncateStatusText(`fetch: ${input.url || ""}`);
  if (name === "WebSearch") return truncateStatusText(`web search: ${input.query || ""}`);
  if (name.startsWith("mcp__")) return truncateStatusText(`mcp: ${name.slice("mcp__".length).replace(/__/g, " / ")}`);
  if (!name) return null;
  return truncateStatusText(name);
}

// Successful results are already implied by the next status line, so only
// failures are worth surfacing while a turn is running.
function summarizeClaudeToolResult(block) {
  if (!block || block.type !== "tool_result" || !block.is_error) return null;
  const content = block.content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join(" ")
    : content;
  return truncateStatusText(`failed: ${text || "tool returned an error"}`);
}

// Claude Code's streaming input takes image blocks directly, so an attachment
// reaches the model as an image rather than a path it has to go and read.
function claudeImageBlock(saved) {
  const preview = saved?.preview;
  if (!preview || preview.kind !== "image" || !preview.absolutePath) return null;
  if (!fs.existsSync(preview.absolutePath)) return null;
  const mediaType = preview.mimeType || preview.mediaType || "image/png";
  if (!String(mediaType).startsWith("image/")) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: fs.readFileSync(preview.absolutePath).toString("base64") },
  };
}

function summarizeClaudeAttachmentPrompt(text, savedAttachments) {
  if (!savedAttachments.length) return text;
  const lines = savedAttachments.map((file) => `- ${file.name}: ${file.absolutePath}`);
  return `${text || "添付ファイルを確認してください。"}\n\n添付ファイルはMac側に保存済みです。必要ならこのパスを読み取って処理してください:\n${lines.join("\n")}`;
}

class ClaudeBridge {
  constructor(requestedThreadId, baseBridgeKey, options = {}) {
    this.provider = "claude";
    this.model = modelForProvider(this.provider);
    this.requestedThreadId = requestedThreadId;
    this.baseBridgeKey = baseBridgeKey;
    this.bridgeKey = bridgeMapKey(this.provider, baseBridgeKey);
    this.clients = new Set();
    this.threadId = requestedThreadId || `claude:${crypto.randomUUID()}`;
    // The id handed to the phone before a real Claude session id exists. A new
    // chat has none until its first turn finishes, so `ready` carries this
    // `claude:<uuid>` and the phone stores it as the selected thread. Kept here
    // so a reconnect that dials back with it resolves to this same bridge -
    // even after promoteBridgeKey has moved `threadId` onto the real session id
    // - instead of building an empty second bridge under a `claude:<uuid>` key.
    this.provisionalThreadId = requestedThreadId ? "" : this.threadId;
    this.claudeSessionId = requestedThreadId && !requestedThreadId.startsWith("claude:") ? requestedThreadId : null;
    this.activeTurnId = null;
    this.createdAt = Date.now();
    this.listUpdatedAt = 0;
    this.ready = true;
    const session = this.claudeSessionId ? readClaudeSession(this.claudeSessionId) : null;
    this.history = session?.history || [];
    // Follow the session home rather than dragging it into the active workdir.
    // A new chat has no session to follow, so a folder asked for by the caller
    // decides instead, and the configured workdir is the last word.
    this.workdir = claudeSessionWorkdir(session, requestedWorkdirOr(options.workdir));
    this.terminalHistory = terminalHistoryFromChatHistory(this.history);
    this.pendingApproval = null;
    this.slashCommands = [];
    this.clearRequested = false;
    this.turnQueue = [];
    this.activeProcess = null;
    const idleState = idleRunStateFromHistory(this.history);
    this.runState = { ...idleState, updatedAt: Date.now() };
    this.streamingStarted = false;
    this.interruptRequested = false;
    this.idleDisposeTimer = null;
    this.longRunningTimer = null;
    this.stalledTurnId = null;
    this.sessionWatchPath = "";
    this.sessionWatchTimer = null;
  }

  addClient(browser) {
    this.cancelIdleDispose();
    // The watcher below only reports what happens next, and it is torn down
    // while nobody is connected. A phone that locked its screen, or walked out
    // of range, would come back to the snapshot it left - so the file is read
    // once here, before `ready` carries this history to the arriving client.
    this.reloadSessionFromDisk();
    this.clients.add(browser);
    this.watchSession();
    this.emitTo(browser, "status", { text: "共有Claudeブリッジに参加しました。" });
    this.emitTo(browser, "ready", this.readyPayload());
    browser.on("close", () => {
      this.clients.delete(browser);
      if (!this.clients.size) this.unwatchSession();
      this.scheduleIdleDispose();
    });
  }

  // A session is one file, and the desktop app and the terminal CLI append to
  // the same one. Without this the phone shows the snapshot it read when the
  // thread was opened and never learns that the work carried on elsewhere.
  watchSession() {
    if (this.sessionWatchPath || !this.claudeSessionId) return;
    const file = claudeSessionFilePath(this.claudeSessionId);
    if (!file) return;
    this.sessionWatchPath = file;
    // Keep our own initial stat: watchFile takes its baseline asynchronously,
    // so an append just after joining can become that baseline and never emit
    // a change (observed on Linux). A stat poll also survives atomic replaces.
    let lastStamp = "";
    const poll = () => {
      if (this.hasActiveWork()) return;
      try {
        const stat = fs.statSync(file);
        const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (stamp === lastStamp) return;
        this.reloadSessionFromDisk();
        lastStamp = stamp;
      } catch { lastStamp = ""; }
    };
    poll();
    this.sessionWatchTimer = setInterval(poll, claudeSessionWatchIntervalMs);
    this.sessionWatchTimer.unref?.();
  }

  unwatchSession() {
    if (!this.sessionWatchPath) return;
    clearInterval(this.sessionWatchTimer);
    this.sessionWatchPath = "";
    this.sessionWatchTimer = null;
  }

  reloadSessionFromDisk() {
    // Our own turn is writing; its stream is already the live view, and
    // replacing history underneath it would fight the deltas on screen.
    if (this.hasActiveWork()) return;
    const session = readClaudeSession(this.claudeSessionId);
    const history = session?.history;
    if (!Array.isArray(history) || !history.length) return;
    if (claudeHistoryHoldsSameConversation(history, this.history)) return;
    // Different is not the same as newer: the file is appended to by several
    // writers, and one that does not carry the answer we just streamed is one
    // caught mid-write. Adopting it would take that answer off the phone.
    if (!historyKeepsLatestAnswer(history, this.history)) return;
    this.history = history;
    // Deliberately not terminalHistory: a transcript carries no status or error
    // records, so rebuilding it from one yields nothing and would throw away the
    // tool activity this bridge watched go by.
    this.emit("historyChanged", { threadId: this.threadId, messages: history.length });
  }

  readyPayload() {
    const thread = threadRecordForBridge(this);
    return {
      provider: this.provider,
      threadId: this.threadId,
      threadTitle: thread?.displayTitle || thread?.name || "",
      thread,
      model: this.model,
      // Its own, the way SharedBridge already reports. Sending the configured
      // workdir made the header name one folder while the turn ran in another.
      workdir: this.workdir || workdir,
      ...currentWorkspaceMeta(this.workdir || workdir),
      shared: true,
      clients: this.clients.size,
      history: this.history,
      terminalHistory: this.terminalHistory,
      slashCommands: this.slashCommands,
      run: this.runPayload(),
    };
  }

  // A phone that joins between turns has no init message to learn from, so the
  // last list this bridge saw travels with `ready`.
  applySlashCommands(commands, skills) {
    if (!Array.isArray(commands) || !commands.length) return;
    const catalog = slashCommandCatalog({
      commands,
      skills: Array.isArray(skills) ? skills : [],
      descriptions: skillDescriptionsFromDisk(),
    });
    const changed = JSON.stringify(catalog) !== JSON.stringify(this.slashCommands);
    this.slashCommands = catalog;
    if (changed) this.emit("slashCommands", { slashCommands: catalog });
  }

  runPayload() {
    // A question outranks the turn waiting on it. The turn is still active, so
    // this used to report "Agent 処理中" and carry nothing to answer with: a
    // phone that reconnected mid-approval was shown a spinner for a run that had
    // already stopped to ask it something.
    if (this.pendingApproval) {
      return {
        state: "approval",
        label: "承認待ち",
        turnId: this.activeTurnId,
        pendingApproval: this.pendingApproval,
        updatedAt: Date.now(),
        ...this.workspaceMeta(),
      };
    }
    if (this.activeTurnId || this.activeProcess) {
      if (this.runState?.state === "interrupting") return { ...this.runState, ...this.workspaceMeta() };
      return {
        state: this.streamingStarted ? "streaming" : "running",
        label: this.streamingStarted ? "回答生成中" : "Agent 処理中",
        turnId: this.activeTurnId,
        updatedAt: Date.now(),
        ...this.workspaceMeta(),
      };
    }
    return {
      ...(this.runState || { state: "ready", label: "未実行・送信できます", turnId: null, updatedAt: Date.now() }),
      ...this.workspaceMeta(),
    };
  }

  // The session's folder, not this process's. Read without the argument, every
  // run this bridge reported described the folder the bridge was started in:
  // a chat opened in `00_受け渡し` was announced as `codex-remote-control-lab`
  // on branch `develop`, and the phone believed the report over its own folder.
  workspaceMeta() {
    return currentWorkspaceMeta(this.workdir || workdir);
  }

  setBridgeRunState(state, label, turnId = this.activeTurnId || null) {
    const next = { state, label, turnId, updatedAt: Date.now(), ...this.workspaceMeta() };
    const previous = this.runState || {};
    // A question that is still waiting for its answer is kept through every
    // other state change. Dropping the held copy on a stream update left the
    // asker waiting on a card no reconnecting phone would be handed.
    const stillAsked = Boolean(this.pendingApproval && this.pendingApprovals?.has(this.pendingApproval.id));
    if (state !== "approval" && !stillAsked) this.pendingApproval = null;
    this.runState = next;
    lastBridgeEventAt = Date.now();
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
      this.unwatchSession();
      this.closeApprovalServer();
      if (bridges.get(this.bridgeKey) === this) bridges.delete(this.bridgeKey);
    }, idleBridgeTtlMs);
    this.idleDisposeTimer.unref?.();
  }

  appendTerminal(entry) {
    if (!entry) return null;
    const next = {
      id: entry.id || `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: entry.ts || Date.now(),
      kind: entry.kind || "status",
      message: redactTerminalText(entry.message || ""),
      detail: entry.detail ? redactTerminalText(entry.detail).slice(0, 4000) : "",
      turnId: entry.turnId || this.activeTurnId || null,
    };
    this.terminalHistory.push(next);
    this.terminalHistory = this.terminalHistory.slice(-terminalHistoryLimit);
    return next;
  }

  emit(type, payload = {}) {
    lastBridgeEventAt = Date.now();
    const terminalEntry = this.appendTerminal(terminalEntryForBridgeMessage(type, payload, this));
    // 作業ログ went to the open page and nowhere else. It is the only account of
    // what happened between two messages - why a turn stalled, that a retry is
    // running, that permissions changed - and the phone rebuilds its log from
    // this history every time it comes back to the chat. So leaving the screen
    // and returning threw all of it away, and what was left read as though the
    // work had begun at the moment of return.
    if (type === "status") this.appendStatusHistory(payload.text);
    const body = JSON.stringify({ type, ...(terminalEntry ? { terminalEntry } : {}), ...payload });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(body);
    }
  }

  appendStatusHistory(text) {
    const value = String(text || "").trim();
    if (!value) return;
    this.history.push({ type: "status", text: value });
    this.history = capHistoryWithStatus(this.history);
  }

  emitTo(client, type, payload = {}) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type, ...payload }));
  }

  // Answers whether the key change carried a fresh `ready` out, so a caller
  // that changed what `ready` says does not have to send a second one.
  promoteBridgeKey() {
    if (!this.claudeSessionId || this.baseBridgeKey === this.claudeSessionId) return false;
    const previousKey = this.bridgeKey;
    const nextKey = bridgeMapKey(this.provider, this.claudeSessionId);
    if (bridges.has(nextKey) && bridges.get(nextKey) !== this) return false;
    if (bridges.get(previousKey) !== this) return false;
    this.threadId = this.claudeSessionId;
    this.baseBridgeKey = this.claudeSessionId;
    this.bridgeKey = nextKey;
    bridges.delete(previousKey);
    bridges.set(this.bridgeKey, this);
    this.emit("ready", this.readyPayload());
    return true;
  }

  // `/clear` is the one command that answers with nothing at all: the CLI forks
  // a clean session, this bridge adopts the new id, and the phone is left
  // showing a conversation the model can no longer see. Say it happened, drop
  // the transcript that is no longer true, and follow the new session file
  // instead of the abandoned one.
  forgetClearedConversation() {
    this.clearRequested = false;
    this.history = [];
    // The terminal pane is this bridge's own log of what it watched happen, not
    // the model's memory, so clearing the model's does not falsify it.
    this.emit("status", { text: "会話の記憶をリセットしました。ここから先は前のやり取りを引き継ぎません。" });
    if (this.clients.size) {
      this.unwatchSession();
      this.watchSession();
    }
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

  prompt(text, attachments = [], options = {}, clientMessageId = null, context = null) {
    context = { ...operationContext.normalize(context), receivedAt: Date.now() };
    if (this.activeTurnId || this.activeProcess) {
      this.turnQueue.push({ text, attachments, options, clientMessageId, context });
      if (clientMessageId) this.emit("promptAccepted", { clientMessageId, queued: true });
      this.emit("status", { text: `キューに追加しました（${this.turnQueue.length}件待機）` });
      return;
    }
    try {
      this.startPrompt(text, attachments, options, clientMessageId, context);
    } catch (error) {
      this.emit("error", { text: `送信に失敗しました: ${error.message}` });
    }
  }

  startNextQueuedTurn() {
    if (this.activeTurnId || this.activeProcess || !this.turnQueue.length) return;
    const next = this.turnQueue.shift();
    this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
    this.startPrompt(next.text, next.attachments, next.options, next.clientMessageId, next.context);
  }

  startPrompt(text, attachments = [], options = {}, clientMessageId = null, context = null) {
    const permissionMode = claudePermissionMode(options);
    // Reserve the slot before awaiting so a second prompt still queues.
    this.activeTurnId = `claude-turn:pending:${crypto.randomUUID()}`;
    this.ensureApprovalServer()
      .then((socketPath) => this.spawnTurn(text, attachments, options, clientMessageId, permissionMode, socketPath, context))
      .catch((error) => {
        this.activeTurnId = null;
        this.emit("status", { text: `承認ソケットを準備できなかったため承認なしで実行します: ${error.message}` });
        this.spawnTurn(text, attachments, options, clientMessageId, permissionMode, null, context);
      });
  }

  spawnTurn(text, attachments = [], options = {}, clientMessageId = null, permissionMode = "acceptEdits", approvalSocketPath = null, context = null) {
    // Kept on the bridge because an approval raised mid-turn has to be able to
    // report the mode it was raised under; フルアクセス behaves differently here.
    this.activePermissionMode = permissionMode;
    this.interruptRequested = false;
    const savedAttachments = [];
    const savedImages = [];
    const imageBlocks = [];
    const pathOnlyAttachments = [];
    for (const attachment of attachments || []) {
      const saved = saveDataUrlAttachment(attachment);
      if (!saved) continue;
      savedAttachments.push(saved.preview);
      if (saved.preview.kind === "image") savedImages.push(saved.preview);
      const block = claudeImageBlock(saved);
      // Anything we cannot inline still falls back to handing over its path.
      if (block) imageBlocks.push(block);
      else pathOnlyAttachments.push(saved.preview);
    }

    const promptText =
      summarizeClaudeAttachmentPrompt(text, pathOnlyAttachments) ||
      (imageBlocks.length ? "添付画像を確認してください。" : text);
    // Only the turn that asked for it may drop the transcript.
    this.clearRequested = slashCommandFromPrompt(promptText) === "clear";
    const displayText = savedAttachments.length ? `${text || "添付ファイルを確認してください。"}\n\n添付: ${savedAttachments.map((file) => file.name).join(", ")}` : text;
    const turnId = `claude-turn:${crypto.randomUUID()}`;
    this.activeTurnId = turnId;
    this.streamingStarted = false;
    scheduleLongRunningNotification(this, turnId);
    this.setBridgeRunState("running", "Agent 処理中", turnId);
    this.appendHistory({ type: "user", text: displayText, attachments: savedImages });
    this.emit("user", { text: displayText, attachments: savedImages, clientMessageId });
    this.emit("turn", { status: "started", turnId, run: this.runPayload() });

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      options.model || this.model,
      "--permission-mode",
      permissionMode,
      "--append-system-prompt",
      operationContext.modelContext(context, phoneMachineLabel),
    ];
    const effort = claudeEffortLevel(options);
    if (effort) args.push("--effort", effort);
    if (approvalSocketPath) {
      args.push(
        "--mcp-config",
        approvalMcpConfig(approvalSocketPath),
        "--permission-prompt-tool",
        `mcp__${approvalMcpServerName}__approve`,
      );
    }
    if (this.claudeSessionId) args.push("--resume", this.claudeSessionId);
    else {
      // Only when the session is created. Passing it on every turn would keep
      // overwriting the title with the newest prompt, including one the user
      // renamed by hand on the desktop.
      const sessionName = claudeSessionName(text);
      if (sessionName && claudeAcceptsNameFlag()) args.push("--name", sessionName);
    }

    const child = spawn(claudeBin, args, {
      // Per-bridge workdir: the fleet pins each slot to its own worktree, so the
      // module-level workdir would send every slot's turns to the same tree.
      cwd: this.workdir || workdir,
      // Recorded verbatim on every turn, so a transcript says which surface
      // started it. Nothing reads it yet; it is what makes "sessions from the
      // phone" answerable later without guessing from shape.
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || "phone_bridge" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", (error) => {
      this.emit("status", { text: `Claude prompt input closed early: ${error.message}` });
    });
    try {
      child.stdin.end(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: promptText }, ...imageBlocks] },
          parent_tool_use_id: null,
        })}\n`,
      );
    } catch (error) {
      this.emit("status", { text: `Claudeへの送信に失敗しました: ${error.message}` });
    }
    this.activeProcess = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let assistantText = "";
    let deltaCount = 0;
    let deltaBytes = 0;
    let lineCount = 0;
    let unhandledCount = 0;
    // Spawn counts as output: startup silence is the CLI booting, not a stall.
    let lastOutputAt = Date.now();
    let stallWarned = false;
    let stallTimer = null;
    const pendingToolUses = new Set();
    const finishTurnDebug = debugTimer("claude.turn", {
      turnId,
      threadId: this.threadId,
      model: this.model,
      permissionMode,
      workdir: this.workdir || workdir,
      approvalSocket: Boolean(approvalSocketPath),
    });

    const clearActiveProcess = () => {
      // Unconditional: only this child's own error/exit handlers call this, so a
      // turn that lost the slot must still stop its watchdog from firing at a
      // process that is already gone.
      if (stallTimer) {
        clearInterval(stallTimer);
        stallTimer = null;
      }
      if (this.activeProcess !== child && this.activeTurnId !== turnId) return false;
      this.activeProcess = null;
      this.activeTurnId = null;
      this.streamingStarted = false;
      clearLongRunningNotification(this);
      return true;
    };

    // Every branch below names itself, so the debug log says which one claimed
    // a line - and, when none did, says that too. A stream message that
    // silently matches nothing is what "the newest reply never showed up"
    // looks like from the phone, and it is invisible from the outside.
    const routeLine = (line) => {
      if (!line.trim()) return null;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("status", { text: line.slice(0, 500) });
        return { handled: "unparsed", type: "", raw: line.slice(0, 500) };
      }
      const routed = { handled: "unhandled", type: msg.type || "", subtype: msg.subtype || "" };
      const rateLimitUpdate = persistClaudeRateLimitMessage(msg);
      if (rateLimitUpdate) {
        this.emit("rateLimits", { rateLimits: rateLimitUpdate });
        return { ...routed, handled: "rateLimits" };
      }
      if (msg.session_id) {
        // A turn keeps the id it resumed; `/clear` is what makes one fork.
        const forked = Boolean(this.claudeSessionId) && msg.session_id !== this.claudeSessionId;
        this.claudeSessionId = msg.session_id;
        if (forked && this.clearRequested) {
          // Before the key change, so no `ready` ever carries the transcript
          // together with the session that no longer holds it.
          this.forgetClearedConversation();
          if (!this.promoteBridgeKey()) this.emit("ready", this.readyPayload());
        } else this.promoteBridgeKey();
      }
      if (msg.type === "system" && msg.subtype === "init") {
        // Claude opens every turn by listing what it can do. Taking the list
        // from here is what keeps the phone's command sheet honest when a skill
        // is added or the CLI is updated.
        this.applySlashCommands(msg.slash_commands, msg.skills);
        this.emit("status", { text: `Claude session ready: ${msg.session_id || this.threadId}` });
        return {
          ...routed,
          handled: "systemInit",
          sessionId: msg.session_id || this.threadId,
          slashCommandCount: this.slashCommands.length,
        };
      }
      if (msg.type === "system" && msg.subtype === "api_retry") {
        this.emit("status", { text: `Claude API retry ${msg.attempt}/${msg.max_retries}` });
        return { ...routed, handled: "apiRetry", attempt: msg.attempt, maxRetries: msg.max_retries };
      }
      const delta = msg.type === "stream_event" && msg.event?.delta?.type === "text_delta" ? msg.event.delta.text : "";
      if (delta) {
        if (!this.streamingStarted) {
          this.streamingStarted = true;
          this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
        }
        assistantText += delta;
        this.emit("assistantDelta", { text: delta });
        deltaCount += 1;
        deltaBytes += delta.length;
        return { ...routed, handled: "delta" };
      }
      if (msg.type === "assistant") {
        let summaries = 0;
        for (const block of msg.message?.content || []) {
          // Held so the watchdog can tell "running a tool" from "owes tokens".
          if (block?.type === "tool_use" && block.id) pendingToolUses.add(block.id);
          const summary = summarizeClaudeToolUse(block, this.workdir || workdir);
          if (summary) {
            this.emit("status", { text: summary });
            summaries += 1;
          }
        }
        return { ...routed, handled: "assistant", blocks: (msg.message?.content || []).length, summaries };
      }
      if (msg.type === "user") {
        let summaries = 0;
        for (const block of msg.message?.content || []) {
          // A result without an id cannot be matched to its call, and guessing
          // wrong the other way - holding a tool open that already returned - is
          // what would keep a dead turn alive, so it clears the whole set.
          if (block?.type === "tool_result") {
            if (block.tool_use_id) pendingToolUses.delete(block.tool_use_id);
            else pendingToolUses.clear();
          }
          const summary = summarizeClaudeToolResult(block);
          if (summary) {
            this.emit("status", { text: summary });
            summaries += 1;
          }
        }
        return { ...routed, handled: "user", blocks: (msg.message?.content || []).length, summaries };
      }
      if (msg.type === "result") {
        // The turn is answered; nothing can still be in flight under it.
        pendingToolUses.clear();
        if (msg.session_id) {
          this.claudeSessionId = msg.session_id;
          this.promoteBridgeKey();
        }
        const recovered = Boolean(!assistantText && msg.result);
        if (recovered) {
          if (!this.streamingStarted) {
            this.streamingStarted = true;
            this.setBridgeRunState("streaming", "回答生成中", this.activeTurnId);
          }
          assistantText = String(msg.result);
          this.emit("assistantDelta", { text: assistantText });
        }
        return { ...routed, handled: "result", recoveredFromResult: recovered, subtypeResult: msg.subtype || "" };
      }
      return routed;
    };

    const handleLine = (line) => {
      const routed = routeLine(line);
      if (!routed) return;
      lineCount += 1;
      if (routed.handled === "unhandled") unhandledCount += 1;
      // Deltas arrive per token. Logging each one would bury the entries that
      // explain anything, so they are counted here and reported once per turn.
      if (routed.handled === "delta") return;
      debugLog("claude.stream.line", {
        turnId,
        threadId: this.threadId,
        sessionId: this.claudeSessionId || null,
        streamingStarted: this.streamingStarted,
        assistantChars: assistantText.length,
        ...routed,
      });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // Any byte at all, including a thinking delta and a retry notice, is proof
      // the process is still alive and working.
      lastOutputAt = Date.now();
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) this.emit("status", { text: line.slice(0, 500) });
      }
    });

    if (claudeStallWarnMs > 0 || claudeStallKillMs > 0) {
      stallTimer = setInterval(() => {
        if (this.activeProcess !== child) return;
        const verdict = claudeStallVerdict({
          now: Date.now(),
          lastOutputAt,
          pendingToolCount: pendingToolUses.size,
          warned: stallWarned,
          warnMs: claudeStallWarnMs,
          killMs: claudeStallKillMs,
        });
        if (verdict.action === "none") return;
        const silence = formatSilence(verdict.silentMs);
        debugLog("claude.stall", {
          turnId,
          threadId: this.threadId,
          action: verdict.action,
          silentMs: verdict.silentMs,
          toolInFlight: verdict.toolInFlight,
          pendingToolCount: pendingToolUses.size,
          assistantChars: assistantText.length,
        });
        if (verdict.action === "warn") {
          stallWarned = true;
          // Said once, and said plainly, because the alternative the phone shows
          // today is an animation that means nothing.
          this.emit("status", {
            text: verdict.toolInFlight
              ? `${silence}のあいだ実行中のツールを待っています。処理は続いています。`
              : `${silence}のあいだClaudeからの出力がありません。応答が止まっている可能性があります。`,
          });
          return;
        }
        // The verdict stays "kill" for as long as the process takes to die, and
        // the process is under no obligation to die quickly - so the watchdog
        // has to stand down here rather than repeat itself every tick. The
        // escalation below, and then the exit handler, finish the job.
        clearInterval(stallTimer);
        stallTimer = null;
        this.stalledTurnId = turnId;
        this.setBridgeRunState("error", "応答なし", turnId);
        this.emit("status", { text: `${silence}出力がないため、応答が停止したと判断して終了します。` });
        child.kill("SIGTERM");
        const forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, claudeStallKillGraceMs);
        forceTimer.unref?.();
      }, claudeStallCheckMs);
      stallTimer.unref?.();
    }
    child.on("error", (error) => {
      if (!clearActiveProcess()) return;
      this.interruptRequested = false;
      this.setBridgeRunState("error", "起動に失敗", turnId);
      this.emit("error", { text: `Claudeを起動できませんでした: ${error.message}` });
      notifyRunEvent("failed", {
        provider: this.provider,
        model: this.model,
        threadId: this.threadId,
        turnId,
        message: error.message,
      });
      this.startNextQueuedTurn();
      this.scheduleIdleDispose();
    });
    child.on("exit", (code, signal) => {
      // The watchdog kills with the same signals a person does, so without this
      // the phone would be told the user interrupted a turn they never touched.
      // A clean exit still wins: a turn that answered as it was being killed
      // answered.
      const wasStalled = this.stalledTurnId === turnId && !(code === 0 && !signal);
      const wasInterrupted = !wasStalled && (this.interruptRequested || signal === "SIGINT" || signal === "SIGTERM");
      if (!clearActiveProcess()) return;
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      this.interruptRequested = false;
      this.stalledTurnId = null;
      // A `/clear` that never forked - it failed, or was interrupted - must not
      // leave the next turn armed to drop the transcript.
      this.clearRequested = false;
      // An empty `assistantText` on a clean exit is the whole bug in one field:
      // the turn ran, and nothing was appended for the phone to show.
      finishTurnDebug({
        code,
        signal,
        wasInterrupted,
        wasStalled,
        lineCount,
        deltaCount,
        deltaBytes,
        unhandledCount,
        assistantChars: assistantText.length,
        willAppendHistory: Boolean(assistantText.trim()),
        historyLength: this.history.length,
        clientCount: this.clients.size,
        stderrTail: stderrBuffer.trim().slice(-500),
      });
      if (wasStalled) {
        // Whatever did arrive before the silence is kept: a half-written answer
        // is still the only account of what the turn was doing.
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        const message = "Claudeからの出力が止まったため、この処理を終了しました。もう一度送信してください。";
        this.setBridgeRunState("error", "応答なし", turnId);
        this.emit("error", { text: message });
        notifyRunEvent("failed", { bridge: this, model: this.model, turnId, message });
      } else if (code === 0 && !wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        const question = latestAssistantQuestion(this, turnId);
        this.setBridgeRunState(question ? "question" : "done", question ? "返信待ち" : "完了しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        // One message per finished turn: the question when there is one, the
        // answer otherwise. See the Codex turn/completed handler.
        if (question) {
          notifyBridgeEvent("question_required", { bridge: this, turnId, severity: "warning", detail: question, force: true });
        } else {
          notifyRunEvent("completed", { bridge: this, model: this.model, turnId, reply: assistantText });
        }
      } else if (wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        this.setBridgeRunState("interrupted", "中断しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        notifyRunEvent("interrupted", { bridge: this, model: this.model, turnId, reply: assistantText });
      } else {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        const message = `Claude process exited (${reason})${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-1000)}` : ""}`;
        this.setBridgeRunState("error", "エラー", turnId);
        this.emit("error", { text: message });
        notifyRunEvent("failed", { bridge: this, model: this.model, turnId, message });
      }
      this.startNextQueuedTurn();
      this.scheduleIdleDispose();
    });
  }

  appendHistory(entry) {
    this.history.push(entry);
    // Trimmed the same way the status lines are, so a long turn's notes cannot
    // push the messages they annotate off the front of the chat.
    this.history = capHistoryWithStatus(this.history);
    if (entry?.text) this.listUpdatedAt = Date.now();
  }

  // Claude Code spawns the approval MCP server itself, so the bridge only has to
  // listen on a Unix socket it can dial back on. No port is bound, which keeps
  // concurrent fleet bridges from colliding.
  ensureApprovalServer() {
    if (this.approvalServer) return Promise.resolve(this.approvalSocketPath);
    const socketPath = approvalSocketPathFor(this.bridgeKey || this.threadId || String(uiPort));
    return new Promise((resolve, reject) => {
      try {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {
        // A stale socket we cannot remove means listen() will fail below.
      }
      const server = net.createServer((socket) => this.handleApprovalConnection(socket));
      server.on("error", (error) => {
        this.approvalServer = null;
        this.approvalSocketPath = null;
        reject(error);
      });
      server.listen(socketPath, () => {
        this.approvalServer = server;
        this.approvalSocketPath = socketPath;
        approvalSocketPaths.add(socketPath);
        resolve(socketPath);
      });
    });
  }

  handleApprovalConnection(socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let payload;
      try {
        payload = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.end(`${JSON.stringify({ decision: "decline", message: "承認要求を解釈できませんでした。" })}\n`);
        return;
      }
      buffer = buffer.slice(newline + 1);
      this.openApproval(payload, socket);
    });
  }

  openApproval(payload, socket) {
    if (!this.pendingApprovals) this.pendingApprovals = new Map();
    const id = `claude-approval:${(this.nextApprovalId = (this.nextApprovalId || 0) + 1)}`;
    const request = {
      id,
      method: "claude/requestApproval",
      params: {
        toolName: payload.toolName || "unknown",
        input: payload.input || {},
        toolUseId: payload.toolUseId || null,
      },
    };

    debugLog("claude.approval.opened", {
      id,
      threadId: this.threadId,
      turnId: this.activeTurnId,
      toolName: request.params.toolName,
      toolUseId: request.params.toolUseId,
      inputKeys: Object.keys(request.params.input || {}),
      clientCount: this.clients.size,
      permissionMode: this.activePermissionMode || null,
      runState: this.runState?.state || null,
    });

    const settle = (decision, message, answers) => {
      if (!this.pendingApprovals.has(id)) {
        debugLog("claude.approval.settleIgnored", { id, decision, threadId: this.threadId });
        return;
      }
      clearTimeout(timer);
      this.pendingApprovals.delete(id);
      if (this.pendingApproval?.id === id) this.pendingApproval = null;
      const chosen = questionAnswersFor(request.params, answers);
      debugLog("claude.approval.settled", {
        id,
        decision,
        message,
        // The choices themselves are the operator's, so the log counts them
        // rather than repeating them.
        answered: chosen ? Object.keys(chosen).length : 0,
        threadId: this.threadId,
        socketDestroyed: socket.destroyed,
      });
      if (!socket.destroyed) socket.end(`${JSON.stringify({ decision, message, answers: chosen || undefined })}\n`);
    };

    const timeoutMs = this.approvalTimeoutMs ?? approvalTimeoutMs;
    const timer = setTimeout(() => {
      settle("decline", "承認がタイムアウトしました。");
      this.emit("status", { text: "承認がタイムアウトしたため拒否しました。" });
      // The card is gone by the time the app is opened; without this the
      // person who was told to come and answer finds nothing, and the turn
      // carrying on without them looks like a decision nobody made.
      this.announceApprovalExpired(request, timeoutMs);
    }, timeoutMs);

    // The asker hung up. Claude Code kills the prompt tool's child when the turn
    // that asked ends without an answer, so this is the ordinary end of an
    // unanswered question - and dropping only the settle entry was what left the
    // held copy behind, advertised by every status poll with nothing on the
    // other end to receive a decision.
    socket.on("close", () => {
      if (!this.pendingApprovals.has(id)) return;
      clearTimeout(timer);
      this.pendingApprovals.delete(id);
      this.forgetPendingApproval(id, "askerGone");
    });

    this.pendingApprovals.set(id, settle);

    // No phone connected is the ordinary case for a question, not the
    // exceptional one: the app is in the background, the socket is gone, and
    // the notification is how the person finds out. So the question is held and
    // announced, and the phone that opens gets the card from `ready`. Only when
    // there is no notification channel either - nobody to tell, nobody to wait
    // for - is it declined on the spot rather than left to hang.
    if (!this.clients.size && !this.operatorReachable()) {
      settle("decline", "接続中の端末も通知先もないため拒否しました。");
      this.emit("status", { text: "承認を求められましたが、接続中の端末も通知先もありません。" });
      return;
    }
    if (!this.clients.size) {
      this.emit("status", { text: "承認を求められました。接続中の端末がないため、通知を送って答えを待っています。" });
    }

    // Held, not just broadcast. A phone that reloads or drops its socket while
    // the question is open has no card left to answer, and `ready` has to be
    // able to hand it back. Set after the run state, which clears this on any
    // state that is not an approval.
    this.setBridgeRunState("approval", "承認待ち", this.activeTurnId);
    this.pendingApproval = request;
    this.emit("approval", { request });
    // Split "never sent" from "sent but never drawn": past this line the card
    // is the phone UI's problem, not the bridge's.
    debugLog("claude.approval.broadcast", {
      id,
      threadId: this.threadId,
      clientCount: this.clients.size,
      runState: this.runState?.state || null,
      pendingApprovalId: this.pendingApproval?.id || null,
    });
    this.announceApproval(request, timeoutMs);
  }

  // Whether a question asked while no phone is connected can still reach the
  // person: true when a notification channel is configured.
  operatorReachable() {
    return notificationTargets(process.env).length > 0;
  }

  announceApproval(request, timeoutMs = approvalTimeoutMs) {
    const approval = approvalDetail(request);
    notifyBridgeEvent("approval_required", {
      bridge: this,
      turnId: this.activeTurnId,
      severity: "warning",
      detail: approval.text,
      questionCount: approval.questionCount || 0,
      deadlineMinutes: Math.max(1, Math.round(timeoutMs / 60_000)),
      // With no phone connected the notification is the only way the question
      // reaches anyone, so it goes out whether or not event notifications are
      // switched on.
      force: !this.clients.size,
    });
  }

  announceApprovalExpired(request, timeoutMs = approvalTimeoutMs) {
    const approval = approvalDetail(request);
    notifyBridgeEvent("approval_expired", {
      bridge: this,
      turnId: this.activeTurnId,
      severity: "warning",
      detail: approval.text,
      questionCount: approval.questionCount || 0,
      deadlineMinutes: Math.max(1, Math.round(timeoutMs / 60_000)),
      force: true,
    });
  }

  closeApprovalServer() {
    for (const settle of Array.from((this.pendingApprovals || new Map()).values())) {
      settle("decline", "ブリッジが終了したため拒否しました。");
    }
    this.pendingApprovals?.clear();
    if (this.approvalServer) {
      this.approvalServer.close();
      this.approvalServer = null;
    }
    if (this.approvalSocketPath) {
      removeApprovalSocket(this.approvalSocketPath);
      this.approvalSocketPath = null;
    }
  }

  // A question nobody can answer any more has to stop being asked. The held copy
  // is what `ready` and every status poll hand to the phone, so leaving it in
  // place is what turns one dead approval into a card that comes back after
  // every single tap - answering it can never reach the settle entry that is
  // already gone.
  forgetPendingApproval(id, reason) {
    if (!id || this.pendingApproval?.id !== id) return false;
    this.pendingApproval = null;
    debugLog("claude.approval.forgotten", { id, reason, threadId: this.threadId, turnId: this.activeTurnId });
    const working = Boolean(this.activeTurnId || this.activeProcess);
    this.setBridgeRunState(
      working ? "running" : "ready",
      working ? "Agent 処理中" : "未実行・送信できます",
      this.activeTurnId,
    );
    return true;
  }

  approval(requestMsg, decision, answers) {
    const id = requestMsg?.id;
    const settle = id ? this.pendingApprovals?.get(id) : null;
    if (!settle) {
      // The phone can still be holding a card for a request that ended on its
      // own. Clear it here rather than only reporting it, or the tap that was
      // meant to dismiss it leaves it on screen for the next poll to redraw.
      const cleared = this.forgetPendingApproval(id, "decidedAfterEnd");
      this.emit("status", {
        text: cleared
          ? "この承認待ちは既に終了していたため、表示を取り下げました。"
          : "対象の承認リクエストは既に解決済みです。",
      });
      return;
    }
    const accepted = decision === "accept";
    const asked = askUserQuestions(requestMsg?.params).length > 0;
    settle(
      accepted ? "accept" : "decline",
      accepted ? undefined : asked ? "回答せずに進めることを選びました。前提を明示して進めてください。" : "ブラウザから拒否されました。",
      accepted ? answers : null,
    );
    this.setBridgeRunState("running", "Agent 処理中", this.activeTurnId);
    this.emit("status", { text: asked ? (accepted ? "回答を送信しました" : "回答せずに進めます") : accepted ? "承認しました" : "拒否しました" });
  }
}

function getBridge(threadId, provider = agentProvider, connectionId = crypto.randomUUID(), options = {}) {
  const requestedProvider = normalizeProvider(provider);
  // A new-session request that cannot be honoured is final: the same request id
  // against the same folder will keep failing, so the phone must be told to stop
  // retrying it rather than reconnect on the timer with the id it is holding.
  // Defined here rather than at module scope so the resolver unit test, which
  // runs this function's source in isolation, has it in scope.
  const newSessionError = (message, code = "new_session_unavailable") => {
    const error = new Error(message);
    error.retryable = false;
    error.code = code;
    return error;
  };
  // Claude honours this too now. While the sidebar showed only the active
  // workdir, the per-project "new chat" button could only ever mean the folder
  // the bridge was already in; listing every project made it a real request.
  const requestedWorkdir = options.workdir ? validateWorkdir(options.workdir) : "";
  const requestedServiceTier = requestedProvider === "codex" && Object.prototype.hasOwnProperty.call(options, "serviceTier") ? normalizeServiceTier(options.serviceTier) : null;
  const bridgeOptions = { ...options, ...(requestedWorkdir ? { workdir: requestedWorkdir } : {}), serviceTier: requestedServiceTier };
  // Keep creation ownership on the bridge itself: its map key is promoted to
  // the real thread id before the browser necessarily receives ready.
  const newSessionId = !threadId && bridgeOptions.fresh ? String(options.newSessionId || "") : "";
  if (newSessionId && !/^[A-Za-z0-9_-]{1,128}$/.test(newSessionId)) throw newSessionError("Invalid new session id", "invalid_new_session_id");
  if (newSessionId) {
    for (const bridge of bridges.values()) {
      if (bridge.provider !== requestedProvider || bridge.newSessionId !== newSessionId) continue;
      if (!bridgeMatchesWorkdir({ bridgeWorkdir: bridge.newSessionWorkdir, targetWorkdir: requestedWorkdir || workdir })) {
        throw newSessionError("New session workdir changed; start a separate session", "new_session_workdir_changed");
      }
      if (typeof bridge.isReusable === "function" && !bridge.isReusable()) throw newSessionError("New session unavailable; start a separate session");
      return bridge;
    }
  }
  // A Claude session names itself only after its first turn finishes; until then
  // the bridge answers to the provisional `claude:<uuid>` it put in `ready`, and
  // that is what the phone dials back with. Its own key logic would look this id
  // up as `claude:claude:<uuid>`, miss, and build an empty second bridge while
  // the first still holds the conversation - so resolve it to the live bridge by
  // its provisional (or already-promoted) id first. Real session ids never carry
  // the `claude:` prefix, so this cannot shadow a resumed session.
  if (threadId && requestedProvider === "claude" && String(threadId).startsWith("claude:")) {
    for (const bridge of bridges.values()) {
      if (bridge.provider !== "claude") continue;
      if (bridge.threadId === threadId || bridge.provisionalThreadId === threadId) return bridge;
    }
  }
  // A Claude session already names its own directory, and the bridge reads it
  // out of the transcript - a requested folder is only the fallback for a
  // session that does not exist yet. So for a request that names one, the
  // folder must decide neither the bridge key nor whether to replace a bridge.
  // It used to decide both, and the phone sends whichever directory it happens
  // to know when it dials: returning to a backgrounded tab could reconnect
  // under a different key and land on a second bridge for the same session,
  // built fresh from the transcript. That one reports the session idle - 前回
  // 完了・送信できます - while the turn it should have been watching goes on
  // streaming into the first, which no longer has a client.
  // Existing Codex sessions also own their folder. A stale browser hint must
  // neither create a duplicate connection nor replace one doing active work.
  const sessionOwnsWorkdir = Boolean(threadId);
  const bridgeHasActiveWork = (bridge) => Boolean(typeof bridge?.hasActiveWork === "function" && bridge.hasActiveWork());
  // A bridge a phone is connected to is not a stale hint to clean up: evicting
  // it drops that phone's live socket and can kill a new session mid-creation.
  // So a folder mismatch may replace only a bridge nobody is on.
  const bridgeHasClients = (bridge) => Boolean(bridge?.clients && bridge.clients.size > 0);
  const bridgeNeedsReplacement = (bridge) =>
    !sessionOwnsWorkdir &&
    !bridgeHasClients(bridge) &&
    shouldReplaceBridgeForWorkdir({
      bridgeWorkdir: bridge?.workdir || workdir,
      targetWorkdir: requestedWorkdir,
      active: bridgeHasActiveWork(bridge),
    });
  const bridgeMatchesRequestWorkdir = (bridge) =>
    bridgeMatchesWorkdir({
      bridgeWorkdir: bridge?.workdir || workdir,
      targetWorkdir: requestedWorkdir,
    });

  if (!threadId && !bridgeOptions.fresh) {
    for (const [key, bridge] of bridges.entries()) {
      if (bridge.provider !== requestedProvider) continue;
      // Only a bridge that has not yet started a conversation is a candidate for
      // this "new chat, no folder named" request. A bridge created from the
      // sidebar's "+" keeps requestedThreadId null even after it owns a real
      // thread, so match on threadId too: without this, a no-thread reconnect
      // (a provider tab, a Mac switch, a plain reload with nothing selected)
      // would join that "+" conversation, or - in another folder - dispose the
      // very bridge whose phone is watching it.
      if (bridge.requestedThreadId || bridge.threadId) continue;
      if (bridgeNeedsReplacement(bridge)) {
        if (typeof bridge.dispose === "function") bridge.dispose();
        bridges.delete(key);
        continue;
      }
      if (!bridgeMatchesRequestWorkdir(bridge)) continue;
      if (typeof bridge.isReusable !== "function" || bridge.isReusable()) return bridge;
      if (typeof bridge.dispose === "function") bridge.dispose();
      bridges.delete(key);
    }
  }
  const baseKey = bridgeKeyForRequest(threadId, connectionId, sessionOwnsWorkdir ? { ...bridgeOptions, workdir: "", cwd: "" } : bridgeOptions);
  const key = bridgeMapKey(requestedProvider, baseKey);
  let existing = bridges.get(key);
  if (existing && bridgeNeedsReplacement(existing)) {
    if (typeof existing.dispose === "function") existing.dispose();
    bridges.delete(key);
    existing = null;
  }
  if (existing && typeof existing.isReusable === "function" && !existing.isReusable()) {
    existing.dispose();
    bridges.delete(key);
    existing = null;
  }
  if (!existing && !bridges.has(key)) {
    const created = requestedProvider === "claude" ? new ClaudeBridge(threadId, baseKey, bridgeOptions) : new SharedBridge(threadId, baseKey, bridgeOptions);
    created.newSessionId = newSessionId;
    created.newSessionWorkdir = requestedWorkdir || workdir;
    bridges.set(key, created);
  }
  return bridges.get(key);
}

// The phone remembers a cwd per thread, and it can name a folder that does not
// exist on this machine — a thread opened on one Mac and reopened on another,
// or a worktree since deleted. Dropping the hint costs routing; letting it throw
// kills the socket, and the phone reconnects straight into the same failure.
function usableRequestedWorkdir(requested) {
  if (!requested) return { workdir: "" };
  try {
    return { workdir: validateWorkdir(requested) };
  } catch (error) {
    return { workdir: "", problem: error.message };
  }
}

async function bindBrowser(browser, phoneToken, threadId, provider = agentProvider, options = {}, dependencies = {}) {
  const requestedProvider = normalizeProvider(provider);
  const ensureAppServer = dependencies.ensureCodexServerRunning || ensureCodexServerRunning;
  const resolveBridge = dependencies.getBridge || getBridge;
  browser.isAlive = true;
  browser.on("pong", () => {
    browser.isAlive = true;
  });
  if (requestedProvider === "codex" && shouldStartCodexServer) {
    try {
      await ensureAppServer();
    } catch (error) {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify({ type: "error", text: `Codex app-serverを起動できませんでした: ${error.message}` }));
        browser.close();
      }
      return;
    }
  }
  if (browser.readyState !== WebSocket.OPEN) return;
  const requestedWorkspace = usableRequestedWorkdir(options.workdir);
  if (!threadId && requestedWorkspace.problem) {
    browser.send(JSON.stringify({
      type: "error", code: "invalid_new_session_workdir", retryable: false,
      text: `選んだ作業場所を使えないため、新しい会話を開始できません。新規セッションからフォルダを選び直してください: ${requestedWorkspace.problem}`,
    }));
    browser.close();
    return;
  }
  let bridge;
  try {
    bridge = resolveBridge(threadId, requestedProvider, crypto.randomUUID(), { ...options, workdir: requestedWorkspace.workdir });
  } catch (error) {
    // A new-session request that cannot be honoured carries retryable:false so
    // the phone drops the held request instead of dialling back on the timer
    // with the same id, which is what produced a once-a-second reconnect loop.
    if (browser.readyState === WebSocket.OPEN) {
      const payload = { type: "error", text: error.message };
      if (error.retryable === false) payload.retryable = false;
      if (error.code) payload.code = error.code;
      browser.send(JSON.stringify(payload));
      browser.close();
    }
    return;
  }
  bridge.addClient(browser);
  if (requestedWorkspace.problem) {
    // Say it rather than quietly working somewhere else than the phone shows.
    bridge.emitTo(browser, "status", {
      text: `保存されていた作業場所を使えないため ${bridge.workdir || workdir} で開きます: ${requestedWorkspace.problem}`,
    });
  }

  browser.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (error) {
      bridge.emitTo(browser, "error", { text: `Invalid browser message: ${error.message}` });
      return;
    }
    if (msg.token && msg.token !== phoneToken) {
      bridge.emitTo(browser, "error", { text: "Invalid token" });
      browser.close();
      return;
    }
    if (msg.type === "prompt") bridge.prompt(msg.text, msg.attachments, msg.options, msg.clientMessageId, msg.operationContext);
    if (msg.type === "interrupt") bridge.interrupt();
    if (msg.type === "approval") bridge.approval(msg.request, msg.decision, msg.answers);
  });
}

function bridgeSummaries() {
  return Array.from(bridges.values()).map((bridge) => {
    const meta = currentWorkspaceMeta(bridge.workdir || workdir);
    return {
      threadId: bridge.threadId,
      clients: bridge.clients.size,
      ready: bridge.ready,
      provider: bridge.provider || agentProvider,
      workdir: bridge.workdir || workdir,
      ...meta,
      run: typeof bridge.runPayload === "function" ? bridge.runPayload() : null,
      pendingApproval: bridge.pendingApproval || null,
      terminalTail: Array.isArray(bridge.terminalHistory) ? bridge.terminalHistory.slice(-12) : [],
      lastEventAt: lastBridgeEventAt || null,
    };
  });
}

function healthBridgeSummaries() {
  return bridgeSummaries().map((bridge) => ({
    threadId: bridge.threadId,
    clients: bridge.clients,
    ready: bridge.ready,
    provider: bridge.provider,
    run: bridge.run,
    pendingApproval: Boolean(bridge.pendingApproval),
    lastEventAt: bridge.lastEventAt,
  }));
}

function activeClientCount() {
  return Array.from(bridges.values()).reduce((sum, bridge) => sum + bridge.clients.size, 0);
}

function tokenFreeLanUrls() {
  return notificationBridgeUrls.map(stripTokenFromUrl).filter(Boolean);
}

function startupNotificationUrls() {
  if (startupTokenUrlsEnabled()) return notificationBridgeUrls;
  // The published HTTPS address first: it is the one the installed app uses.
  return [...new Set([servedBridgeBaseUrl, ...tokenFreeLanUrls()].filter(Boolean))];
}

function enabledNotificationProviders(env = process.env) {
  return notificationTargets(env).map((target) => target.type);
}

function shortOutput(value, maxBytes = 24_000) {
  const text = redactSensitiveText(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function gitOutputLimited(cwd, args, maxBytes = 24_000) {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1500,
      maxBuffer: maxBytes * 2,
    });
    return { ...shortOutput(output.trim(), maxBytes), error: "" };
  } catch (error) {
    return { text: "", truncated: false, error: redactSensitiveText(error.message) };
  }
}

function appendCappedOutput(current, chunk, maxBytes) {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return { text: current, truncated: true };
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return { text: next, truncated: false };
  return { text: Buffer.from(next).subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function executeTerminalCommand(command, options = {}) {
  const text = String(command || "").trim();
  if (!text) throw new Error("Command is required");
  if (text.length > 2000) throw new Error("Command is too long");
  const cwd = options.cwd ? validateWorkdir(options.cwd) : workdir;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 30_000), 1000), 60_000);
  const maxBytes = Math.min(Math.max(Number(options.maxBytes || 60_000), 4_000), 120_000);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let exited = false;
    const child = spawn(text, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
      shell: process.env.SHELL || true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 1000).unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = appendCappedOutput(stdout, chunk.toString("utf8"), maxBytes);
      stdout = next.text;
      truncated = truncated || next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendCappedOutput(stderr, chunk.toString("utf8"), maxBytes);
      stderr = next.text;
      truncated = truncated || next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: text,
        cwd,
        code: 1,
        signal: "",
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr || error.message),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, signal) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        command: text,
        cwd,
        code: timedOut ? 124 : Number(code || 0),
        signal: signal || "",
        stdout: redactSensitiveText(stdout.trimEnd()),
        stderr: redactSensitiveText((timedOut ? `${stderr}\nCommand timed out after ${timeoutMs}ms` : stderr).trimEnd()),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function reviewDiffPayload() {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      workdir,
      statusShort: "",
      diffStat: "",
      files: [],
      truncated: false,
      message: "Git repository was not detected.",
    };
  }
  const status = gitOutputLimited(workdir, ["status", "--short"], 12_000);
  const stat = gitOutputLimited(workdir, ["diff", "--stat"], 12_000);
  const files = status.text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 80)
    .map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3).trim() }));
  return {
    isGitRepo: true,
    workdir,
    repoRoot,
    branch: currentGitBranch() || null,
    statusShort: status.text,
    diffStat: stat.text,
    files,
    truncated: Boolean(status.truncated || stat.truncated),
    error: status.error || stat.error || "",
  };
}

function terminalEntriesForThread(threadId = "", provider = "") {
  const bridge = threadId ? findBridgeByThreadId(threadId, provider) || findLiveBridge(bridges, threadId) : null;
  if (bridge?.terminalHistory) return bridge.terminalHistory.slice(-120);
  const newest = Array.from(bridges.values())
    .filter((candidate) => !provider || candidate.provider === provider)
    .sort((a, b) => (b.runState?.updatedAt || 0) - (a.runState?.updatedAt || 0))[0];
  return newest?.terminalHistory?.slice(-120) || [];
}

function reviewTestsPayload(threadId = "", provider = "") {
  const terminal = terminalEntriesForThread(threadId, provider);
  const testEntries = terminal.filter((entry) => /(npm (?:run )?(?:test|check)|npm test|pnpm test|yarn test|vitest|jest|pytest|docs:build)/i.test(entry.message || ""));
  const errorEntries = terminal.filter((entry) => entry.kind === "error" || /failed|error|失敗|エラー/i.test(`${entry.message || ""}\n${entry.detail || ""}`));
  const lastCommand = testEntries.length ? testEntries[testEntries.length - 1] : null;
  const failed = errorEntries.some((entry) => /test|check|failed|失敗/i.test(`${entry.message || ""}\n${entry.detail || ""}`));
  return {
    threadId,
    lastCommand: lastCommand?.message || "",
    status: lastCommand ? (failed ? "failed" : "unknown") : "empty",
    failureSummary: errorEntries
      .slice(-4)
      .map((entry) => entry.detail || entry.message)
      .join("\n")
      .slice(0, 4000),
    terminalTail: terminal.slice(-30),
  };
}

async function healthPayload(phoneToken, requestedProvider = agentProvider) {
  const summaries = bridgeSummaries();
  const appServerConnected =
    requestedProvider === "claude" ? true : codexSocketPath || !shouldStartCodexServer ? appServerClient.ready : await isCodexReady();
  const bridgeState = summaries.some((item) => item.run?.state === "error")
    ? "degraded"
    : appServerConnected
      ? "alive"
      : "degraded";
  return {
    ok: bridgeState !== "error",
    bridge: bridgeState,
    appServer: requestedProvider === "claude" ? "local-process" : appServerConnected ? "connected" : "disconnected",
    websocket: activeClientCount() ? "connected" : "disconnected",
    historySync: {
      enabled: historySyncEnabledForProvider(requestedProvider),
      lastSuccessAt: lastHistorySync.lastSuccessAt,
      lastFailureAt: lastHistorySync.lastFailureAt,
      lastError: lastHistorySync.lastError,
    },
    activeClients: activeClientCount(),
    workdir,
    model: modelForProvider(requestedProvider),
    token: tokenMetadata(phoneToken),
    notification: {
      eventsEnabled: /^(1|true|yes|on)$/i.test(String(process.env.PHONE_NOTIFY_EVENTS || "")),
      providers: enabledNotificationProviders(),
    },
    hostName: os.hostname(),
    lanUrls: tokenFreeLanUrls(),
    lastEventAt: lastBridgeEventAt ? new Date(lastBridgeEventAt).toISOString() : null,
    bridges: healthBridgeSummaries(),
  };
}

// A thread that was started but never spoken to. Every connect that names no
// thread starts one, and the bridge object then lives on for an hour after the
// phone leaves, so each of those sat in everyone's list as 名前未設定のチャット
// with no date - one per open of a Codex icon, one per test run. The phone
// already draws the chat it is on as 現在のチャット, so the list has nothing to
// gain from these; a turn in flight still counts as content.
function bridgeIsUntouched(bridge = {}) {
  const history = Array.isArray(bridge.history) ? bridge.history : [];
  if (history.some((entry) => entry?.type === "user")) return false;
  if (typeof bridge.hasActiveWork === "function" && bridge.hasActiveWork()) return false;
  return true;
}

function localThreadList(provider = "") {
  const requestedProvider = provider ? normalizeProvider(provider) : "";
  return Array.from(bridges.values())
    .filter((bridge) => !requestedProvider || bridge.provider === requestedProvider)
    .filter((bridge) => bridge.threadId && !bridgeIsUntouched(bridge))
    .map((bridge) => threadRecordForBridge(bridge));
}

function timestampValueMs(value, unit = "auto") {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    if (unit === "ms") return value;
    if (unit === "seconds") return value * 1000;
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return timestampValueMs(numeric, unit);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function threadListTimestamp(thread = {}) {
  const fields = [
    ["updatedAt", "auto"],
    ["updated_at_ms", "ms"],
    ["updated_at", "auto"],
    ["createdAt", "auto"],
    ["created_at_ms", "ms"],
    ["created_at", "auto"],
  ];
  for (const [field, unit] of fields) {
    const timestamp = timestampValueMs(thread[field], unit);
    if (timestamp) return timestamp;
  }
  return 0;
}

function copyThreadTimeFields(target, source, fields) {
  for (const field of fields) {
    if (source && source[field] !== undefined && source[field] !== null && source[field] !== "") target[field] = source[field];
    else delete target[field];
  }
}

function copyThreadContextFields(target, source, fields) {
  for (const field of fields) {
    if (!source || source[field] === undefined || source[field] === null || source[field] === "") continue;
    target[field] = source[field];
  }
}

const canonicalThreadContextFields = ["cwd", "workdir", "workspaceLocation", "repoName", "gitBranch"];

function threadRecordForBridge(bridge = {}) {
  if (!bridge.threadId) return null;
  const userEntry = [...(bridge.history || [])].reverse().find((entry) => entry.type === "user");
  const preview = userEntry?.text || bridge.threadId;
  const title = preview.split("\n").find(Boolean) || bridge.threadId;
  const localActivityAt = threadListTimestamp({ updatedAt: bridge.listUpdatedAt || 0 });
  const updatedAt = localActivityAt || 0;
  const createdAt = localActivityAt ? bridge.createdAt || updatedAt : 0;
  return {
    id: bridge.threadId,
    name: title,
    displayTitle: title,
    preview,
    cwd: bridge.workdir || workdir,
    bridgeWorkdir: bridge.workdir || workdir,
    lastExecutionCwd: bridge.workdir || workdir,
    contextSource: "live-bridge",
    provider: bridge.provider || agentProvider,
    updatedAt,
    updated_at: updatedAt,
    createdAt,
    created_at: createdAt,
    localActivityAt,
    runState: bridge.runState?.state || "",
  };
}

function mergeThreadListData(remoteThreads = [], localThreads = []) {
  const byId = new Map();
  for (const thread of Array.isArray(remoteThreads) ? remoteThreads : []) {
    if (thread?.id) byId.set(thread.id, thread);
  }
  for (const thread of Array.isArray(localThreads) ? localThreads : []) {
    if (!thread?.id) continue;
    const existing = byId.get(thread.id);
    const merged = {
      ...existing,
      ...thread,
      name: thread.name === thread.id && existing?.name ? existing.name : thread.name,
      preview: thread.preview === thread.id && existing?.preview ? existing.preview : thread.preview,
    };
    if (existing) {
      // Keep the stored title stable: reconnecting must not rename a familiar
      // conversation to its last short follow-up (e.g. "continue").
      if (existing.name && existing.name !== existing.id) {
        merged.name = existing.name;
        merged.displayTitle = existing.displayTitle || existing.name;
      }
      copyThreadContextFields(merged, existing, canonicalThreadContextFields);
      const existingTimestamp = threadListTimestamp(existing);
      const localActivityAt = threadListTimestamp({ updatedAt: thread.localActivityAt || 0 });
      if (!localActivityAt || (existingTimestamp && localActivityAt <= existingTimestamp)) {
        copyThreadTimeFields(merged, existing, ["updatedAt", "updated_at", "updated_at_ms"]);
        copyThreadContextFields(merged, existing, [
          ...canonicalThreadContextFields,
          "lastExecutionCwd",
          "lastExecutionCwdAt",
          "contextSource",
        ]);
      }
      copyThreadTimeFields(merged, existing, ["createdAt", "created_at", "created_at_ms"]);
    }
    byId.set(thread.id, merged);
  }
  return Array.from(byId.values()).sort((a, b) => threadListTimestamp(b) - threadListTimestamp(a));
}

async function codexThreadListPayload(requestedProvider) {
  const result = await appServerRequest("thread/list", {
    limit: 30,
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false,
    sourceKinds: ["cli", "vscode", "appServer"],
    useStateDbOnly: false,
  });
  const remoteData = Array.isArray(result.data) ? result.data.map((thread) => ({ ...thread, provider: requestedProvider })) : result.data;
  const data = Array.isArray(remoteData) ? mergeThreadListData(remoteData, localThreadList(requestedProvider)) : remoteData;
  return { ...result, provider: requestedProvider, activeProvider: requestedProvider, data };
}

function findBridgeByThreadId(threadId, provider = "", options = {}) {
  const requestedProvider = provider ? normalizeProvider(provider) : "";
  const targetWorkdir = options.workdir ? validateWorkdir(options.workdir) : "";
  return Array.from(bridges.values()).find((bridge) => {
    const matchesThread = bridge.threadId === threadId || bridge.requestedThreadId === threadId || bridge.baseBridgeKey === threadId || bridge.bridgeKey === threadId;
    if (!matchesThread || (requestedProvider && bridge.provider !== requestedProvider)) return false;
    if (!targetWorkdir) return true;
    return bridgeMatchesWorkdir({ bridgeWorkdir: bridge.workdir || workdir, targetWorkdir });
  });
}

function localModelList(provider = agentProvider) {
  const requestedProvider = normalizeProvider(provider);
  return {
    data: modelOptionsForProvider(requestedProvider).map((item) => ({
      id: item,
      model: item,
      displayName: item,
    })),
  };
}

async function main() {
  // Capture before serving requests so later disk edits can require a restart.
  bridgeBuildTracker = createBuildTracker(root);
  const phoneToken = getToken();
  const managedCodexServer = shouldStartCodexServer;
  if (isCodexProvider) {
    await appServerRequest("thread/loaded/list", { cursor: null, limit: 1 });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    url._phoneHeaders = req.headers;
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      sendJson(res, 200, { ok: true, bridge: "alive", uptimeSeconds: Math.round(process.uptime()) });
      return;
    }
    if (url.pathname === "/api/session" || url.pathname === "/api/auth/status") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, { ok: true, authenticated: true, token: tokenMetadata(phoneToken) });
      return;
    }
    if (url.pathname === "/api/health") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      sendJson(res, 200, await healthPayload(phoneToken, requestedProvider));
      return;
    }
    if (url.pathname === "/api/info") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, {
        provider: agentProvider,
        providers: ["codex", "claude"],
        model,
        modelChoices: { codex: codexModelChoices({ configured: modelForProvider("codex") }), claude: claudeModelOptions },
    reasoningChoices: reasoningChoicePayload(),
        workdir,
        app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
        codexUrl,
        codexSocketPath: codexSocketPath || null,
        managedCodexServer,
        tokenRequired: true,
        operationContext: { version: 1 },
      });
      return;
    }
    if (url.pathname === "/api/bridge/info") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, bridgeInfoPayload());
      return;
    }
    // The phone's own copy of the bridge list dies with the Home Screen icon,
    // so this slot keeps the last synced copy for the reinstall that follows.
    // Every failure answers with a non-200: a client that mistook an error for
    // "no backup yet" would push its empty registry over the real one.
    if (url.pathname === "/api/bridge/registry") {
      if (!requireToken(url, phoneToken, res)) return;
      const store = { filePath: bridgeRegistryPath, keyPath: bridgeRegistryKeyPath };
      if (req.method === "GET") {
        try {
          sendJson(res, 200, { ok: true, ...readBridgeRegistryBackup(store) });
        } catch (error) {
          const code = error instanceof RegistryUnreadableError ? error.code : "registry-error";
          sendJson(res, 409, { error: error.message, code });
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.bridges)) throw new Error("bridges must be an array");
          sendJson(res, 200, {
            ok: true,
            ...writeBridgeRegistryBackup({
              ...store,
              bridges: body.bridges,
              deleted: body.deleted,
              tokens: body.tokens,
              expectedRevision: body.revision,
            }),
          });
        } catch (error) {
          if (error instanceof RegistryConflictError) {
            // The current copy rides along so the phone can merge and retry
            // instead of asking the owner to re-register machines by hand.
            sendJson(res, 409, { error: error.message, code: error.code, current: error.current || null });
            return;
          }
          sendJson(res, 400, { error: error.message });
        }
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
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
    // Safari and the installed Home Screen app do not share storage. A valid
    // install URL therefore receives an authenticated manifest whose start_url
    // seeds the app through a fragment. Tokenless or invalid requests keep the
    // manifest out, and the normal public manifest remains credential-free.
    if (url.pathname === "/install") {
      const authenticatedInstall = requestToken(url) === phoneToken;
      serveIndex(req, res, { includeManifest: authenticatedInstall, standalone: true, phoneToken });
      return;
    }
    if (url.pathname === "/api/threads") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      if (requestedProvider === "claude") {
        sendJson(res, 200, await claudeThreadListPayload());
        return;
      }
      try {
        sendJson(res, 200, await codexThreadListPayload(requestedProvider));
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/models") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      if (requestedProvider === "claude") {
        sendJson(res, 200, localModelList(requestedProvider));
        return;
      }
      try {
        const result = await appServerRequest("model/list", { limit: 80, includeHidden: false });
        rememberCodexModels(result?.data);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/plugins") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      if (requestedProvider === "claude") {
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
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      if (requestedProvider === "claude") {
        sendJson(res, 200, {
          config: { config: { model: modelForProvider(requestedProvider), cwd: workdir, provider: requestedProvider } },
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
    if (url.pathname === "/api/workspaces/browse") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        sendJson(res, 200, browseWorkspaceDirectories(url.searchParams.get("path")));
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/workspaces/bookmark") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = setWorkspaceBookmark(body.path || body.workdir, body.pinned !== false);
        sendJson(res, 200, { ok: true, ...result, options: workspaceOptions() });
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/workspaces/hidden") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = setWorkspaceHidden(body.path || body.workdir, body.hidden !== false);
        sendJson(res, 200, { ok: true, ...result, hiddenProjects: hiddenWorkspaces() });
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/local-settings") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method === "GET") {
        // Cheap when the app-server is up, a no-op when it is not, so the sheet
        // opens on today's list without ever starting Codex to draw it.
        await refreshCodexModelList();
        sendJson(res, 200, localSettingsPayload());
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const updates = {};
          const fleetUpdates = {};
          const requestedProvider = Object.prototype.hasOwnProperty.call(body, "provider") ? normalizeProvider(body.provider) : agentProvider;
          if (Object.prototype.hasOwnProperty.call(body, "provider")) {
            updates[slotEnvKey("PHONE_AGENT_PROVIDER", uiPort)] = requestedProvider;
            fleetUpdates.provider = requestedProvider;
          }
          if (Object.prototype.hasOwnProperty.call(body, "model")) {
            const nextModel = validateModel(body.model);
            updates[slotEnvKey(modelEnvKeyForProvider(requestedProvider), uiPort)] = nextModel;
            fleetUpdates.model = nextModel;
          }
          if (Object.prototype.hasOwnProperty.call(body, "workdir")) {
            const nextWorkdir = rememberWorkspace(body.workdir);
            updates[slotEnvKey("PHONE_WORKDIR", uiPort)] = nextWorkdir;
            fleetUpdates.workdir = nextWorkdir;
          }
          if (requestedProvider === "codex" && Object.prototype.hasOwnProperty.call(body, "historySyncEnabled")) {
            updates[slotEnvKey("CODEX_HISTORY_SYNC", uiPort)] = body.historySyncEnabled ? "1" : "0";
          }
          writeEnvValues(updates);
          const fleetUpdate = Object.keys(fleetUpdates).length
            ? updateFleetConfigBridgeSettings(fleetConfigPath, {
                port: uiPort,
                bridgeId: process.env.PHONE_FLEET_BRIDGE_ID || process.env.PHONE_BRIDGE_ID || phoneBridgeId,
                ...fleetUpdates,
              })
            : { updated: false, reason: "no fleet settings changed" };
          sendJson(res, 200, { ok: true, fleetUpdate, ...localSettingsPayload() });
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
        sendOperationJsonError(res, error, error.statusCode || 400);
      }
      return;
    }
    if (url.pathname === "/api/restart") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      // Restarting means exiting 42 and trusting a supervisor to bring the
      // bridge back. Without one the process simply dies, and recovering needs
      // physical access to the machine -- the worst possible outcome for a
      // button pressed from a phone.
      if (!bridgeIsSupervised) {
        sendJson(res, 409, {
          error:
            "再起動できません。監視付きで起動していないため、停止すると復帰できなくなります。`npm run phone:loop:claude`（Codexは`npm run phone:loop`）で起動してください。",
          code: "restart_unsupervised",
        });
        return;
      }
      sendJson(res, 200, { ok: true, message: "Restarting phone bridge" });
      setTimeout(() => {
        stopCodexServer();
        process.exit(42);
      }, 200);
      return;
    }
    if (url.pathname === "/api/terminal/run") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await executeTerminalCommand(body.command, {
          cwd: body.cwd || workdir,
          timeoutMs: body.timeoutMs,
          maxBytes: body.maxBytes,
        });
        sendJson(res, 200, result);
      } catch (error) {
        sendOperationJsonError(res, error);
      }
      return;
    }
    if (url.pathname === "/api/status") {
      if (!requireToken(url, phoneToken, res)) return;
      const refreshRateLimits = url.searchParams.get("refreshRateLimits") === "1";
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      sendJson(res, 200, {
        provider: requestedProvider,
        defaultProvider: agentProvider,
        workdir,
        ...currentWorkspaceMeta(),
        model: modelForProvider(requestedProvider),
        app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
        codexUrl,
        codexSocketPath: codexSocketPath || null,
        managedCodexServer,
        historySyncEnabled: historySyncEnabledForProvider(requestedProvider),
        health: await healthPayload(phoneToken, requestedProvider),
        token: tokenMetadata(phoneToken),
        rateLimits: await rateLimitSnapshot({ provider: requestedProvider, refresh: refreshRateLimits }),
        uiPort,
        codexPort,
        bridges: bridgeSummaries(),
      });
      return;
    }
    if (url.pathname === "/api/review/diff") {
      if (!requireToken(url, phoneToken, res)) return;
      sendJson(res, 200, reviewDiffPayload());
      return;
    }
    if (url.pathname === "/api/review/tests") {
      if (!requireToken(url, phoneToken, res)) return;
      const threadId = String(url.searchParams.get("thread") || "").trim();
      const requestedProvider = queryProvider(url, res, threadId?.startsWith("claude:") ? "claude" : agentProvider);
      if (!requestedProvider) return;
      sendJson(res, 200, reviewTestsPayload(threadId, requestedProvider));
      return;
    }
    if (url.pathname === "/api/approval") {
      if (!requireToken(url, phoneToken, res)) return;
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const requestedProvider = body.provider ? normalizeProvider(body.provider) : agentProvider;
        const threadId = String(body.threadId || body.request?.params?.threadId || body.request?.threadId || "").trim();
        const bridge = threadId ? findBridgeByThreadId(threadId, requestedProvider) : null;
        if (!bridge) {
          sendJson(res, 404, { error: "approval bridge not found" });
          return;
        }
        bridge.approval(body.request || bridge.pendingApproval, body.decision === "decline" ? "decline" : "accept");
        sendJson(res, 200, { ok: true, provider: requestedProvider, threadId });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/history-sync") {
      if (!requireToken(url, phoneToken, res)) return;
      const requestedProvider = queryProvider(url, res);
      if (!requestedProvider) return;
      if (requestedProvider === "claude") {
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
          enabled: historySyncEnabledForProvider(requestedProvider),
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
      const requestedProvider = queryProvider(url, res, threadId?.startsWith("claude:") ? "claude" : agentProvider);
      if (!requestedProvider) return;
      if (!threadId) {
        sendJson(res, 400, { error: "thread is required" });
        return;
      }
      if (requestedProvider === "claude") {
        const bridge = findBridgeByThreadId(threadId, requestedProvider);
        const session = bridge ? null : readClaudeSession(threadId);
        if (!bridge && !session) {
          sendJson(res, 200, { provider: requestedProvider, activeProvider: requestedProvider, threadId, missing: true, history: [] });
          return;
        }
        sendJson(res, 200, {
          provider: requestedProvider,
          activeProvider: requestedProvider,
          threadId,
          history: bridge?.history?.length ? bridge.history : session?.history || [],
        });
        return;
      }
      try {
        const snapshot = await readThreadSnapshot({
          threadId,
          liveBridge: findBridgeByThreadId(threadId, requestedProvider) || findLiveBridge(bridges, threadId, { provider: requestedProvider }),
          request: appServerRequest,
          historyFromThread,
        });
        sendJson(res, 200, { provider: requestedProvider, activeProvider: requestedProvider, ...snapshot });
      } catch (error) {
        if (isMissingThreadError(error)) {
          sendJson(res, 200, { provider: requestedProvider, activeProvider: requestedProvider, threadId, missing: true, history: [] });
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
    url._phoneHeaders = req.headers;
    if (url.pathname !== "/bridge") {
      socket.destroy();
      return;
    }
    if (requestToken(url) !== phoneToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const threadId = url.searchParams.get("thread") || null;
    const fresh = url.searchParams.get("fresh") === "1";
    let requestedProvider;
    try {
      requestedProvider = normalizeProvider(url.searchParams.get("provider") || (threadId?.startsWith("claude:") ? "claude" : agentProvider));
    } catch (error) {
      socket.write(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${error.message}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      bindBrowser(ws, phoneToken, threadId, requestedProvider, {
        fresh,
        newSessionId: url.searchParams.get("newSessionId") || "",
        workdir: url.searchParams.get("workdir") || "",
        serviceTier: url.searchParams.has("serviceTier") ? url.searchParams.get("serviceTier") : undefined,
      }).catch((error) => {
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
    servedBridgeBaseUrl = servedBridgeUrl(uiPort);
    console.log("");
    console.log("Codex shared browser bridge is ready.");
    for (const url of urls) console.log(`  ${maskTokenInUrl(url)}`);
    console.log("");
    console.log(`Workdir: ${workdir}`);
    console.log(`Default provider: ${agentProvider}`);
    console.log(`Default model:    ${model}`);
    console.log(`App:     ${phoneAppName} (${phoneAppId})`);
    console.log(`Bridge label: ${phoneBridgeLabel} (${phoneBridgeId})`);
    console.log(`Bridge:  ${uiHost}:${uiPort}`);
    console.log(`Codex:   ${managedCodexServer ? codexUrl : codexSocketPath || codexUrl}`);
    console.log(`Claude:  ${claudeBin}`);
    console.log(`Fleet registry entry: ${JSON.stringify({ id: phoneBridgeId, label: phoneBridgeLabel, group: phoneBridgeGroup, baseUrl: `http://LAN-IP:${uiPort}`, token: "***", port: uiPort })}`);
    console.log("Open the private tokenized bridge URL from your protected startup channel to share one bridge thread.");
    console.log("The terminal output masks the local access key by default.");
    // A token holding a backslash, a space or an `&` still works everywhere the
    // bridge builds a URL itself, because those are encoded now. It is the
    // hand-copied address that breaks, and it breaks silently. Say so once.
    if (tokenNeedsUrlEncoding(phoneToken)) {
      console.log(
        "Note: .phone-token holds characters that must be percent-encoded in a URL. Links this bridge prints are encoded; " +
          "a hand-written one may not be. Rewrite .phone-token with letters, digits, - and _ if you copy URLs by hand.",
      );
    }
    if (isDebugEnabled()) console.log(`Debug log: ${debugLogPath()} (PHONE_DEBUG is on)`);
    console.log("Press Ctrl+C to stop.");

    if (servedBridgeBaseUrl) console.log(`Published: ${servedBridgeBaseUrl} (tailscale serve, HTTPS; notification links use it)`);
    // One startup message. The `bridge_started` event that used to follow it
    // told the same channel the same thing a second time.
    notifyBridgeUrls(startupNotificationUrls(), { machine: phoneMachineLabel, project: path.basename(workdir), color: phoneBridgeColor }).then((results) => {
      logNotifyResults("startup", results);
    });
  });

  process.on("exit", () => {
    stopCodexServer();
    for (const socketPath of Array.from(approvalSocketPaths)) removeApprovalSocket(socketPath);
  });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  ClaudeBridge,
  SharedBridge,
  compactCodexError,
  appIdentityForProvider,
  approvalMcpConfig,
  bridgeIsUntouched,
  codexEffortLevel,
  codexEffortsFromList,
  codexModelChoices,
  codexModelIdsFromList,
  codexReasoningChoices,
  reasoningChoicePayload,
  localSettingsPayload,
  readCodexModelCache,
  refreshCodexModelList,
  rememberCodexModels,
  requestedAppProvider,
  serveIndex,
  shouldStartCodexServer,
  askUserQuestions,
  capHistoryWithStatus,
  questionAnswersFor,
  bindBrowser,
  bookmarkIconFiles,
  bridgeIconVariant,
  browseWorkspaceDirectories,
  setWorkspaceBookmark,
  setWorkspaceHidden,
  hiddenWorkspaces,
  workspaceBookmarks,
  claudeAcceptsNameFlag,
  claudeEffortLevel,
  claudeHistoryHoldsSameConversation,
  claudePermissionMode,
  claudeSessionFilePath,
  claudeSessionName,
  claudeSessionWorkdir,
  claudeStallVerdict,
  claudeThreadListPayload,
  executeTerminalCommand,
  getBridge,
  historyKeepsLatestAnswer,
  launchSettingsFromFleetOrEnv,
  machineLabelForEnvironment,
  manifestHrefForRequest,
  manifestPayloadForRequest,
  maskTokenValue,
  mergeThreadListData,
  normalizeClaudeRateLimitPayload,
  readClaudeSessionFile,
  readFleetConfigBridgeSettings,
  requestTokenFromHeaders,
  safeProxyBasePath,
  summarizeClaudeToolResult,
  summarizeClaudeToolUse,
  threadRecordForBridge,
  threadListTimestamp,
  tokenMetadata,
  updateFleetConfigBridgeSettings,
};
