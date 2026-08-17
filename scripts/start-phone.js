const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const WebSocket = require("ws");
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
const { bridgeUrls, eventTypeLabel, notificationTargets, notifyBridgeUrls, notifyEvent, notifyTaskEvent, startupTokenUrlsEnabled, stripTokenFromUrl } = require("./phone-notify");
const { defaultCodexAppServerPort, settingEnvKeysForSlot, slotEnvKey, slotSettingValue } = require("./phone-slot-settings");
const { slashCommandCatalog } = require("./slash-commands");
const { findLiveBridge, readThreadSnapshot } = require("./thread-read");

const root = path.resolve(__dirname, "..");

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
// A Claude-default bridge has no use for the Codex app-server, and starting one
// anyway makes the bridge depend on the codex binary being present and runnable.
const shouldStartCodexServer = isCodexProvider && !process.env.CODEX_APP_SERVER_URL && !codexSocketPath;
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
const codexModelOptions = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];
// Aliases rather than pinned full names: they follow the current generation, so
// the list cannot rot into offering models that no longer exist.
const claudeModelOptions = ["sonnet", "opus", "haiku", "fable"];
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
const modelOptions = isClaudeProvider ? claudeModelOptions : codexModelOptions;
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
    machineLabel: phoneMachineLabel || null,
    workdir,
    cwd: workdir,
    repoRoot,
    branch: currentGitBranch() || null,
    head: gitOutput(["rev-parse", "--short", "HEAD"]) || null,
    dirty,
    dirtySummary: summary,
    provider: agentProvider,
    providers: ["codex", "claude"],
    model,
    modelsByProvider: providerModels,
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
    color: phoneBridgeColor || null,
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

function historySyncEnvKeyForProvider(provider) {
  return provider === "claude" ? "CLAUDE_HISTORY_SYNC" : "CODEX_HISTORY_SYNC";
}

function defaultModelForProvider(provider) {
  return provider === "claude" ? "sonnet" : "gpt-5.4";
}

function modelOptionsForProvider(provider) {
  return provider === "claude" ? claudeModelOptions : codexModelOptions;
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

function localSettingsPayload() {
  const envValues = parseEnvValues(envPath);
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
  const historyPinned = historySyncEnvKeyForProvider(settingsProvider) ? settingPinned(historySyncEnvKeyForProvider(settingsProvider)) : false;
  const portPinned = hasLaunchEnv("PHONE_UI_PORT");
  const hostPinned = hasLaunchEnv("PHONE_UI_HOST");
  const savedHistorySyncEnabled = settingsProvider === "codex" ? historySyncEnabledFromEnv(envValues) : false;
  const savedPort = Number(envValues.PHONE_UI_PORT || uiPort);
  const savedHost = envValues.PHONE_UI_HOST || uiHost;
  const savedModel = fleetSettings.model || modelFromEnv(envValues, settingsProvider, settingsProvider === agentProvider ? model : defaultModelForProvider(settingsProvider));
  const savedWorkdir = fleetSettings.workdir || workdirFromEnv(envValues, settingsProvider, workdir);
  const settingsModel = modelPinned && settingsProvider === agentProvider ? model : savedModel;
  const settingsWorkdir = savedWorkdir;
  const settingsHistorySyncEnabled = historyPinned && settingsProvider === agentProvider ? historySyncEnabledForProvider(settingsProvider) : savedHistorySyncEnabled;
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
      (!modelPinned && settingsProvider === agentProvider && savedModel !== model) ||
      (settingsProvider === agentProvider && savedWorkdir !== workdir) ||
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

function bridgeUrlsForThread(threadId, provider = agentProvider, { includeToken = false } = {}) {
  return notificationBridgeUrls
    .map((base) => {
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
    })
    .filter(Boolean);
}

function logNotifyResults(context, results) {
  if (!results.length) return;
  for (const result of results) {
    if (result.ok) console.log(`[notify] ${context} sent via ${result.type}`);
    else console.warn(`[notify] ${context} ${result.type} failed: ${result.error}`);
  }
}

function notifyRunEvent(status, { provider = agentProvider, threadId, turnId, message, model: eventModel = modelForProvider(provider), workdir: eventWorkdir = workdir } = {}) {
  notifyTaskEvent({
    status,
    provider: normalizeProvider(provider),
    threadId,
    turnId,
    model: eventModel,
    workdir: eventWorkdir,
    message,
    url: bridgeUrlForThread(threadId, provider),
    urls: bridgeUrlsForThread(threadId, provider),
  }, {
    force: status === "completed" || status === "interrupted",
  })
    .then((results) => logNotifyResults(`task ${status}`, results))
    .catch((error) => console.warn(`[notify] task ${status} error: ${error.message}`));
}

function notifyBridgeEvent(type, payload = {}) {
  const provider = normalizeProvider(payload.provider || agentProvider);
  const threadId = payload.threadId || "";
  const projectName = payload.projectName || path.basename(workdir);
  const event = {
    type,
    title: payload.title || `${eventTypeLabel(type)}: ${projectName}`,
    message: payload.message || "",
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
  notifyEvent(event)
    .then((results) => logNotifyResults(`event ${type}`, results))
    .catch((error) => console.warn(`[notify] event ${type} error: ${error.message}`));
}

function scheduleLongRunningNotification(bridge, turnId) {
  clearLongRunningNotification(bridge);
  if (!bridge || !turnId || !longRunningNotifyMs) return;
  bridge.longRunningTimer = setTimeout(() => {
    if (!bridge.activeTurnId && !bridge.activeProcess) return;
    notifyBridgeEvent("long_running", {
      provider: bridge.provider || agentProvider,
      threadId: bridge.threadId,
      turnId,
      severity: "warning",
      title: "処理が長時間続いています",
      message: `${path.basename(workdir)} の処理が長時間続いています。`,
    });
  }, longRunningNotifyMs);
  bridge.longRunningTimer.unref?.();
}

function clearLongRunningNotification(bridge) {
  if (!bridge?.longRunningTimer) return;
  clearTimeout(bridge.longRunningTimer);
  bridge.longRunningTimer = null;
}

function latestAssistantQuestion(bridge) {
  const assistant = [...(bridge?.history || [])].reverse().find((entry) => entry.type === "assistant" && entry.text);
  const text = String(assistant?.text || "");
  if (!/(\?|？|確認してください|どちら|選んで|教えてください|必要ですか)/.test(text)) return "";
  return text.split(/\r?\n/).filter(Boolean).slice(-3).join("\n").slice(0, 500);
}

function latestQuestionFromHistory(history = []) {
  return latestAssistantQuestion({ history });
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
  const text = redactSensitiveText(raw).trim();
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
  if (safeBasePath) params.set("base", safeBasePath);
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
  const version = fs.existsSync(assetPath) ? `${Math.round(fs.statSync(assetPath).mtimeMs).toString(36)}-${phoneAppId}` : phoneAppId;
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

function bookmarkIconFileName() {
  return bookmarkIconFiles().icon180;
}

function bookmarkIcon512FileName() {
  return bookmarkIconFiles().icon512;
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

function manifestPayloadForRequest(url, phoneToken = "") {
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
  const authenticatedInstall = url.searchParams.get("install") === "1" && phoneToken && requestToken(url) === phoneToken;
  manifest.start_url = authenticatedInstall
    ? `${safeBasePath}/install#token=${encodeURIComponent(phoneToken)}`
    : `${safeBasePath}/`;
  return manifest;
}

function serveManifest(url, phoneToken, res) {
  if (url.searchParams.get("install") === "1" && !requireToken(url, phoneToken, res)) return;
  const manifest = manifestPayloadForRequest(url, phoneToken);
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

function idleRunStateFromHistory(history = []) {
  const lastConversationEntry = [...history].reverse().find((entry) => entry.type === "user" || entry.type === "assistant");
  if (!lastConversationEntry) return { state: "ready", label: "未実行・送信できます", turnId: null };
  if (lastConversationEntry.type === "assistant") {
    if (latestQuestionFromHistory(history)) {
      return { state: "question", label: "返信待ち", turnId: lastConversationEntry.outputGroup || null };
    }
    return { state: "done", label: "前回完了・送信できます", turnId: lastConversationEntry.outputGroup || null };
  }
  return { state: "ready", label: "前回送信済み・応答未確認", turnId: lastConversationEntry.outputGroup || null };
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
  let cwd = workdir;
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
    if (item.cwd) cwd = item.cwd;
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
    this.interruptRequested = false;
    this.idleDisposeTimer = null;
    this.longRunningTimer = null;
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
    if (state !== "approval") this.pendingApproval = null;
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
    const body = JSON.stringify({ type, ...(terminalEntry ? { terminalEntry } : {}), ...payload });
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

  fallbackToNewThread(error) {
    this.emit("status", { text: `既存threadが見つからないため新しいthreadを開始します: ${error.message}` });
    this.requestedThreadId = null;
    const previousKey = this.bridgeKey;
    if (bridges.get(previousKey) === this) bridges.delete(previousKey);
    this.baseBridgeKey = `new:${crypto.randomUUID()}`;
    this.bridgeKey = bridgeMapKey(this.provider, this.baseBridgeKey);
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
        model: this.model,
        serviceTier: this.serviceTier,
        cwd: this.workdir,
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
        this.terminalHistory = terminalHistoryFromChatHistory(this.history);
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
              provider: this.provider,
              model: this.model,
              threadId: this.threadId,
              message: error.text,
              workdir: this.workdir,
            });
          }
          this.startNextQueuedTurn();
        } else {
          this.activeTurnId = msg.result.turn.id;
          this.streamingStarted = false;
          this.turnStarted = false;
          scheduleLongRunningNotification(this, this.activeTurnId);
          this.setBridgeRunState("running", "Agent 処理中", this.activeTurnId);
          this.emit("turn", { status: "started", turnId: this.activeTurnId, run: this.runPayload() });
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
        this.turnStarted = true;
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
        this.flushPendingInterrupt();
        const text = summarizeLiveItem(msg.params.item, "started");
        if (text) this.emit("status", { text });
        return;
      }

      if (msg.method === "item/completed") {
        this.turnStarted = true;
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
        this.interruptRequested = false;
        this.activeTurnId = null;
        this.streamingStarted = false;
        this.turnStarted = false;
        clearLongRunningNotification(this);
        const question = latestAssistantQuestion(this);
        this.setBridgeRunState(
          wasInterrupted ? "interrupted" : question ? "question" : "done",
          wasInterrupted ? "中断しました" : question ? "返信待ち" : "完了しました",
          completedTurnId,
        );
        this.emit("turn", { status: "completed", turnId: completedTurnId, run: this.runPayload() });
        if (question) {
          notifyBridgeEvent("question_required", {
            provider: this.provider,
            threadId: this.threadId,
            turnId: completedTurnId,
            severity: "warning",
            title: "返信待ち",
            message: question,
          });
        }
        notifyRunEvent(wasInterrupted ? "interrupted" : "completed", {
          provider: this.provider,
          model: this.model,
          threadId: this.threadId,
          turnId: completedTurnId,
          workdir: this.workdir,
        });
        this.syncHistory("turn completed");
        this.startNextQueuedTurn();
        this.scheduleIdleDispose();
        return;
      }

      if (msg.method && msg.method.endsWith("/requestApproval")) {
        this.pendingApproval = msg;
        this.setBridgeRunState("approval", "承認待ち", this.activeTurnId);
        this.emit("approval", { request: msg });
        notifyBridgeEvent("approval_required", {
          provider: this.provider,
          threadId: this.threadId,
          turnId: this.activeTurnId,
          severity: "warning",
          title: "承認待ち",
          message: msg.method,
        });
        notifyRunEvent("approval", {
          provider: this.provider,
          model: this.model,
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: msg.method,
          workdir: this.workdir,
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
          provider: this.provider,
          model: this.model,
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: error.text,
          workdir: this.workdir,
        });
        return;
      }

      this.emit("event", { event: msg });
    });

    this.upstream.on("error", (error) => {
      if (!this.ready) this.startupFailed = true;
      this.interruptRequested = false;
      clearLongRunningNotification(this);
      this.emit("error", { text: error.message });
      if (this.activeTurnId) this.setBridgeRunState("error", "接続エラー", this.activeTurnId);
      notifyBridgeEvent("connection_lost", {
        provider: this.provider,
        threadId: this.threadId,
        turnId: this.activeTurnId,
        severity: "error",
        title: "Codex app-serverとの接続が切れました",
        message: error.message,
      });
      if (shouldStartCodexServer && isCodexConnectionFailure(error)) {
        ensureCodexServerRunning().catch((restartError) => {
          this.emit("error", { text: `Codex app-serverを再起動できませんでした: ${restartError.message}` });
        });
      }
      if (this.activeTurnId) {
        notifyRunEvent("failed", {
          provider: this.provider,
          model: this.model,
          threadId: this.threadId,
          turnId: this.activeTurnId,
          message: error.message,
          workdir: this.workdir,
        });
      }
    });
    this.upstream.on("close", () => {
      if (!this.ready) this.startupFailed = true;
      this.interruptRequested = false;
      clearLongRunningNotification(this);
      this.emit("status", { text: "Codex接続が閉じました" });
      if (this.activeTurnId) this.setBridgeRunState("error", "接続が閉じました", this.activeTurnId);
      notifyBridgeEvent("connection_lost", {
        provider: this.provider,
        threadId: this.threadId,
        turnId: this.activeTurnId,
        severity: "warning",
        title: "Codex app-serverとの接続が閉じました",
        message: "Codex app-serverとの接続が閉じました。",
      });
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
      this.emit("error", browserOperationError(error, "送信に失敗しました: "));
    }
  }

  startNextQueuedTurn() {
    if (!this.ready || this.activeTurnId || this.hasPendingTurnStart() || !this.turnQueue.length) return;
    try {
      const next = this.turnQueue.shift();
      this.emit("status", { text: `キューから送信中（残り${this.turnQueue.length}件）` });
      this.startPrompt(next.text, next.attachments, next.options, next.clientMessageId);
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

  startPrompt(text, attachments = [], options = {}, clientMessageId = null) {
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
    };
    params.model = options.model || this.model;
    if (Object.prototype.hasOwnProperty.call(options, "serviceTier")) params.serviceTier = normalizeServiceTier(options.serviceTier);
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
    if (entry?.text) this.listUpdatedAt = Date.now();
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
const approvalTimeoutMs = Number(process.env.PHONE_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000);
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
    this.sessionWatchPath = "";
    this.sessionWatchListener = null;
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
    // watchFile rather than watch: it is a stat poll, so it survives the atomic
    // replaces and editor-style rewrites that fs.watch drops on macOS.
    this.sessionWatchListener = () => this.reloadSessionFromDisk();
    fs.watchFile(file, { interval: claudeSessionWatchIntervalMs }, this.sessionWatchListener);
  }

  unwatchSession() {
    if (!this.sessionWatchPath) return;
    fs.unwatchFile(this.sessionWatchPath, this.sessionWatchListener);
    this.sessionWatchPath = "";
    this.sessionWatchListener = null;
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
    if (state !== "approval") this.pendingApproval = null;
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
    const permissionMode = claudePermissionMode(options);
    // Reserve the slot before awaiting so a second prompt still queues.
    this.activeTurnId = `claude-turn:pending:${crypto.randomUUID()}`;
    this.ensureApprovalServer()
      .then((socketPath) => this.spawnTurn(text, attachments, options, clientMessageId, permissionMode, socketPath))
      .catch((error) => {
        this.activeTurnId = null;
        this.emit("status", { text: `承認ソケットを準備できなかったため承認なしで実行します: ${error.message}` });
        this.spawnTurn(text, attachments, options, clientMessageId, permissionMode, null);
      });
  }

  spawnTurn(text, attachments = [], options = {}, clientMessageId = null, permissionMode = "acceptEdits", approvalSocketPath = null) {
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
    const finishTurnDebug = debugTimer("claude.turn", {
      turnId,
      threadId: this.threadId,
      model: this.model,
      permissionMode,
      workdir: this.workdir || workdir,
      approvalSocket: Boolean(approvalSocketPath),
    });

    const clearActiveProcess = () => {
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
          const summary = summarizeClaudeToolResult(block);
          if (summary) {
            this.emit("status", { text: summary });
            summaries += 1;
          }
        }
        return { ...routed, handled: "user", blocks: (msg.message?.content || []).length, summaries };
      }
      if (msg.type === "result") {
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
      const wasInterrupted = this.interruptRequested || signal === "SIGINT" || signal === "SIGTERM";
      if (!clearActiveProcess()) return;
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      this.interruptRequested = false;
      // A `/clear` that never forked - it failed, or was interrupted - must not
      // leave the next turn armed to drop the transcript.
      this.clearRequested = false;
      // An empty `assistantText` on a clean exit is the whole bug in one field:
      // the turn ran, and nothing was appended for the phone to show.
      finishTurnDebug({
        code,
        signal,
        wasInterrupted,
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
      if (code === 0 && !wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        const question = latestAssistantQuestion(this);
        this.setBridgeRunState(question ? "question" : "done", question ? "返信待ち" : "完了しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        if (question) {
          notifyBridgeEvent("question_required", {
            provider: this.provider,
            threadId: this.threadId,
            turnId,
            severity: "warning",
            title: "返信待ち",
            message: question,
          });
        }
        notifyRunEvent("completed", { provider: this.provider, model: this.model, threadId: this.threadId, turnId });
      } else if (wasInterrupted) {
        if (assistantText.trim()) this.appendHistory({ type: "assistant", text: assistantText, outputGroup: turnId });
        this.setBridgeRunState("interrupted", "中断しました", turnId);
        this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
        notifyRunEvent("interrupted", { provider: this.provider, model: this.model, threadId: this.threadId, turnId });
      } else {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        const message = `Claude process exited (${reason})${stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(-1000)}` : ""}`;
        this.setBridgeRunState("error", "エラー", turnId);
        this.emit("error", { text: message });
        notifyRunEvent("failed", {
          provider: this.provider,
          model: this.model,
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

    const timer = setTimeout(() => {
      settle("decline", "承認がタイムアウトしました。");
      this.emit("status", { text: "承認がタイムアウトしたため拒否しました。" });
    }, approvalTimeoutMs);

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

    if (!this.clients.size) {
      settle("decline", "接続中のブラウザがないため拒否しました。");
      this.emit("status", { text: "承認を求められましたが、接続中の端末がありません。" });
      return;
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
    const questions = askUserQuestions(request.params);
    notifyBridgeEvent("approval_required", {
      provider: this.provider,
      threadId: this.threadId,
      turnId: this.activeTurnId,
      severity: "warning",
      title: questions.length ? "質問待ち" : "承認待ち",
      message: questions.length ? `${questions.length}件の質問に回答してください` : `${request.params.toolName} の承認待ちです`,
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
  // Claude honours this too now. While the sidebar showed only the active
  // workdir, the per-project "new chat" button could only ever mean the folder
  // the bridge was already in; listing every project made it a real request.
  const requestedWorkdir = options.workdir ? validateWorkdir(options.workdir) : "";
  const requestedServiceTier = requestedProvider === "codex" && Object.prototype.hasOwnProperty.call(options, "serviceTier") ? normalizeServiceTier(options.serviceTier) : null;
  const bridgeOptions = { ...options, ...(requestedWorkdir ? { workdir: requestedWorkdir } : {}), serviceTier: requestedServiceTier };
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
  const sessionOwnsWorkdir = requestedProvider === "claude" && Boolean(threadId);
  const bridgeHasActiveWork = (bridge) => Boolean(typeof bridge?.hasActiveWork === "function" && bridge.hasActiveWork());
  const bridgeNeedsReplacement = (bridge) =>
    !sessionOwnsWorkdir &&
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
      if (bridge.requestedThreadId) continue;
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
    bridges.set(key, requestedProvider === "claude" ? new ClaudeBridge(threadId, baseKey, bridgeOptions) : new SharedBridge(threadId, baseKey, bridgeOptions));
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
  const bridge = resolveBridge(threadId, requestedProvider, crypto.randomUUID(), { ...options, workdir: requestedWorkspace.workdir });
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
    if (msg.type === "prompt") bridge.prompt(msg.text, msg.attachments, msg.options, msg.clientMessageId);
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
  return startupTokenUrlsEnabled() ? notificationBridgeUrls : tokenFreeLanUrls();
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

function localThreadList(provider = "") {
  const requestedProvider = provider ? normalizeProvider(provider) : "";
  return Array.from(bridges.values())
    .filter((bridge) => !requestedProvider || bridge.provider === requestedProvider)
    .filter((bridge) => bridge.threadId)
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
        workdir,
        app: { id: phoneAppId, name: phoneAppName, shortName: phoneAppShortName },
        codexUrl,
        codexSocketPath: codexSocketPath || null,
        managedCodexServer,
        tokenRequired: true,
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
        const targetWorkdir = url.searchParams.get("workdir") ? validateWorkdir(url.searchParams.get("workdir")) : workdir;
        const snapshot = await readThreadSnapshot({
          threadId,
          liveBridge:
            findBridgeByThreadId(threadId, requestedProvider, { workdir: targetWorkdir }) ||
            findLiveBridge(bridges, threadId, { workdir: targetWorkdir }),
          request: appServerRequest,
          model: modelForProvider(requestedProvider),
          workdir: targetWorkdir,
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
    if (isDebugEnabled()) console.log(`Debug log: ${debugLogPath()} (PHONE_DEBUG is on)`);
    console.log("Press Ctrl+C to stop.");

    notifyBridgeUrls(startupNotificationUrls()).then((results) => {
      logNotifyResults("startup", results);
    });
    notifyBridgeEvent("bridge_started", {
      severity: "info",
      title: "スマホブリッジを起動しました",
      message: `${phoneBridgeLabel} が ${tokenFreeLanUrls()[0] || `http://localhost:${uiPort}/`} で待機しています。`,
      projectName: path.basename(workdir),
      url: tokenFreeLanUrls()[0] || "",
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
  approvalMcpConfig,
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
