const { slotSettingValue } = require("./phone-slot-settings");

function bridgeUrls(addresses, uiPort, phoneToken) {
  return addresses.map((address) => `http://${address}:${uiPort}/?token=${phoneToken}`);
}

// Every other setting in a fleet is written per slot - `PHONE_WORKDIR_45214`,
// `CLAUDE_MODEL_45214` - because two bridges share one `.env`. Notification
// settings were the exception: they were read as bare keys only, so a webhook
// written the way the rest of the file is written was silently ignored and the
// bridge notified nobody. A slot key wins, and a bare key still covers both.
function envValue(env, key) {
  const port = Number(env.PHONE_UI_PORT) || 45214;
  const value = slotSettingValue(env, key, port);
  return value && String(value).trim();
}

function ntfyConfig(env) {
  const topic = envValue(env, "PHONE_NTFY_TOPIC");
  if (!topic) return null;
  const server = envValue(env, "PHONE_NTFY_SERVER") || "https://ntfy.sh";
  return {
    type: "ntfy",
    server: server.replace(/\/+$/, ""),
    topic,
    token: envValue(env, "PHONE_NTFY_TOKEN"),
  };
}

function pushoverConfig(env) {
  const token = envValue(env, "PHONE_PUSHOVER_TOKEN");
  const user = envValue(env, "PHONE_PUSHOVER_USER");
  if (!token || !user) return null;
  return {
    type: "pushover",
    token,
    user,
    device: envValue(env, "PHONE_PUSHOVER_DEVICE"),
  };
}

function discordConfig(env) {
  const webhookUrl = envValue(env, "PHONE_DISCORD_WEBHOOK_URL");
  if (!webhookUrl) return null;
  return {
    type: "discord",
    webhookUrl,
  };
}

function notificationTargets(env = process.env) {
  return [ntfyConfig(env), pushoverConfig(env), discordConfig(env)].filter(Boolean);
}

function notificationTimeoutMs(env = process.env) {
  const value = Number(envValue(env, "PHONE_NOTIFY_TIMEOUT_MS") || 5000);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

function notificationEventDedupeMs(env = process.env) {
  const value = Number(envValue(env, "PHONE_NOTIFY_EVENT_DEDUPE_MS") || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function notificationEventsEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(envValue(env, "PHONE_NOTIFY_EVENTS") || ""));
}

// The startup message lands in a chat channel, and a tokenized URL there is the
// key to the whole fleet rather than to one Mac: a bridge serves the registry
// backup, so one authenticated request reads the backed-up tokens of every
// bridge the phone had registered. An installed Home Screen app already holds
// its own token and only needs to know the bridge is up, so the default is
// token-free. The tokenized form stays available for first-time setup, as an
// explicit opt-in rather than as the thing that happens on every restart.
function startupTokenUrlsEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(envValue(env, "PHONE_NOTIFY_STARTUP_TOKEN_URLS") || ""));
}

function stripTokenFromUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    url.searchParams.delete("token");
    url.searchParams.delete("key");
    return url.toString();
  } catch {
    return text.replace(/([?&])(?:token|key)=[^&\s]*&?/gi, (match, prefix) => (match.endsWith("&") ? prefix : ""));
  }
}

function redactNotificationText(value) {
  return String(value || "")
    .replace(/([?&])(?:token|key)=[^&\s]*&?/gi, (match, prefix) => (match.endsWith("&") ? prefix : ""))
    .replace(/\b(PHONE_TOKEN=)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/\b(token:\s*)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
}

// A notification is read by a person, on a phone, and this one is read in
// Japanese - the same language the UI it links to is written in. Only the
// identifiers stay as they are: a thread id, a turn id, a model name and the
// event type are looked up and pasted, not read.
function notificationMessage(urls) {
  const visibleUrls = urls.length ? urls : ["LAN内のURLを検出できませんでした。Mac側のコンソールを確認してください。"];
  return ["スマホブリッジを起動しました。", "", ...visibleUrls, "", "同じWi-Fi / LAN上のスマホから、上のURLを開いてください。"].join("\n");
}

const providerLabels = { codex: "Codex", claude: "Claude" };

function providerLabel(provider) {
  const key = String(provider || "").toLowerCase();
  return providerLabels[key] || provider || "Codex";
}

function taskStatusLabel(status) {
  if (status === "completed") return "ターン完了";
  if (status === "failed") return "失敗";
  if (status === "approval") return "承認待ち";
  if (status === "interrupted") return "中断";
  return String(status || "更新");
}

const eventTypeLabels = {
  bridge_started: "ブリッジ起動",
  turn_completed: "ターン完了",
  approval_required: "承認待ち",
  question_required: "返信待ち",
  test_failed: "失敗",
  connection_lost: "接続切断",
  history_sync_failed: "履歴同期の失敗",
  long_running: "長時間実行",
};

function eventTypeLabel(type) {
  return eventTypeLabels[String(type || "")] || String(type || "").replace(/_/g, " ");
}

const severityLabels = { info: "情報", warning: "注意", error: "エラー" };

// The host's own clock. An ISO timestamp in UTC is not a time anyone reads at a
// glance, and the person reading this is standing in the timezone the work ran
// in.
function localTimeLabel(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return String(value || "");
  return at.toLocaleString("ja-JP", { hour12: false });
}

function taskNotificationMessage(event = {}) {
  const lines = [`${providerLabel(event.provider)}：${taskStatusLabel(event.status)}`, ""];
  if (event.threadId) lines.push(`スレッド: ${event.threadId}`);
  if (event.turnId) lines.push(`ターン: ${event.turnId}`);
  if (event.model) lines.push(`モデル: ${event.model}`);
  if (event.workdir) lines.push(`作業フォルダ: ${event.workdir}`);
  if (event.message) lines.push("", redactNotificationText(event.message));
  if (Array.isArray(event.urls) && event.urls.length) lines.push("", "リンク:", ...event.urls.map(stripTokenFromUrl));
  else if (event.url) lines.push("", stripTokenFromUrl(event.url));
  return redactNotificationText(lines.join("\n"));
}

function eventSeverity(event = {}) {
  const severity = String(event.severity || "").toLowerCase();
  if (severity === "error" || severity === "warning" || severity === "info") return severity;
  if (/failed|lost|error/i.test(event.type || event.status || "")) return "error";
  if (/approval|required|long_running|sync/i.test(event.type || "")) return "warning";
  return "info";
}

function eventTags(event = {}) {
  const severity = eventSeverity(event);
  if (event.type === "approval_required" || event.type === "question_required") return "bell,computer";
  if (severity === "error") return "warning,computer";
  if (severity === "warning") return "hourglass,computer";
  return "white_check_mark,computer";
}

function normalizeEvent(event = {}) {
  const type = String(event.type || event.status || "bridge_started");
  const severity = eventSeverity({ ...event, type });
  const title = String(event.title || eventTypeLabel(type));
  const createdAt = event.createdAt || new Date().toISOString();
  return {
    type,
    title: redactNotificationText(title),
    message: redactNotificationText(event.message || title),
    threadId: event.threadId || "",
    threadTitle: redactNotificationText(event.threadTitle || ""),
    projectName: redactNotificationText(event.projectName || ""),
    severity,
    createdAt,
    url: stripTokenFromUrl(event.url || ""),
    extra: event.extra && typeof event.extra === "object" ? event.extra : {},
  };
}

function eventNotificationMessage(event = {}) {
  const normalized = normalizeEvent(event);
  const lines = [
    normalized.title,
    "",
    normalized.message,
    "",
    // The raw type is kept alongside its label: it is what a filter or a search
    // in the channel is written against.
    `種別: ${eventTypeLabel(normalized.type)} (${normalized.type})`,
    `重要度: ${severityLabels[normalized.severity] || normalized.severity}`,
    `発生: ${localTimeLabel(normalized.createdAt)}`,
  ];
  if (normalized.projectName) lines.push(`プロジェクト: ${normalized.projectName}`);
  if (normalized.threadTitle) lines.push(`スレッド名: ${normalized.threadTitle}`);
  if (normalized.threadId) lines.push(`スレッド: ${normalized.threadId}`);
  if (normalized.url) lines.push("", normalized.url);
  return lines.join("\n");
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function ntfyEndpoint(target) {
  const server = new URL(`${target.server}/`);
  if (server.protocol !== "https:") throw new Error("PHONE_NTFY_SERVER must use https");
  return new URL(encodeURIComponent(target.topic), server).toString();
}

async function postNtfy(target, urls, fetchImpl, timeoutMs) {
  return postNtfyNotification(
    target,
    {
      title: "Codex phone bridge ready",
      tags: "computer,phone",
      clickUrl: urls[0],
      message: notificationMessage(urls),
    },
    fetchImpl,
    timeoutMs,
  );
}

async function postNtfyNotification(target, notification, fetchImpl, timeoutMs) {
  const headers = {
    title: notification.title,
    tags: notification.tags || "computer,phone",
  };
  if (notification.clickUrl) headers.click = notification.clickUrl;
  if (target.token) headers.authorization = `Bearer ${target.token}`;
  const response = await fetchWithTimeout(fetchImpl, ntfyEndpoint(target), {
    method: "POST",
    headers,
    body: notification.message,
  }, timeoutMs);
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
}

async function postPushover(target, urls, fetchImpl, timeoutMs) {
  return postPushoverNotification(
    target,
    {
      title: "Codex phone bridge ready",
      clickUrl: urls[0],
      clickTitle: "Open Codex phone bridge",
      message: notificationMessage(urls),
    },
    fetchImpl,
    timeoutMs,
  );
}

async function postPushoverNotification(target, notification, fetchImpl, timeoutMs) {
  const form = new URLSearchParams({
    token: target.token,
    user: target.user,
    title: notification.title,
    message: notification.message,
  });
  if (notification.clickUrl) {
    form.set("url", notification.clickUrl);
    form.set("url_title", notification.clickTitle || "Open phone bridge");
  }
  if (target.device) form.set("device", target.device);
  const response = await fetchWithTimeout(fetchImpl, "https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: form,
  }, timeoutMs);
  if (!response.ok) throw new Error(`Pushover returned HTTP ${response.status}`);
}

function discordEndpoint(target) {
  const url = new URL(target.webhookUrl);
  const allowedHosts = new Set(["discord.com", "discordapp.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("PHONE_DISCORD_WEBHOOK_URL must be a Discord https webhook URL");
  }
  return url.toString();
}

async function postDiscord(target, urls, fetchImpl, timeoutMs) {
  return postDiscordNotification(
    target,
    { message: notificationMessage(urls) },
    fetchImpl,
    timeoutMs,
  );
}

async function postDiscordNotification(target, notification, fetchImpl, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, discordEndpoint(target), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: notification.message,
      allowed_mentions: { parse: [] },
    }),
  }, timeoutMs);
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
}

async function notifyBridgeUrls(urls, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const targets = notificationTargets(env);
  const timeoutMs = notificationTimeoutMs(env);
  const results = [];

  for (const target of targets) {
    try {
      if (target.type === "ntfy") await postNtfy(target, urls, fetchImpl, timeoutMs);
      if (target.type === "pushover") await postPushover(target, urls, fetchImpl, timeoutMs);
      if (target.type === "discord") await postDiscord(target, urls, fetchImpl, timeoutMs);
      results.push({ type: target.type, ok: true });
    } catch (error) {
      results.push({ type: target.type, ok: false, error: error.message });
    }
  }

  return results;
}

async function notifyTaskEvent(event = {}, options = {}) {
  const status = event.status || "updated";
  const statusToType = {
    approval: "approval_required",
    completed: "turn_completed",
    interrupted: "turn_completed",
    failed: "test_failed",
  };
  return notifyEvent(
    {
      type: statusToType[status] || status,
      title: `${providerLabel(event.provider)}：${taskStatusLabel(status)}`,
      message: taskNotificationMessage({ ...event, url: stripTokenFromUrl(event.url), urls: (event.urls || []).map(stripTokenFromUrl) }),
      threadId: event.threadId,
      projectName: event.projectName || event.workdir?.split(/[\\/]/).filter(Boolean).pop() || "",
      severity: status === "failed" ? "error" : status === "approval" ? "warning" : "info",
      url: event.url,
      extra: {
        provider: event.provider,
        turnId: event.turnId,
        model: event.model,
      },
    },
    options,
  );
}

const recentEventNotifications = new Map();

async function notifyEvent(event = {}, options = {}) {
  const env = options.env || process.env;
  if (!notificationEventsEnabled(env) && !options.force) return [];
  const fetchImpl = options.fetch || fetch;
  const targets = notificationTargets(env);
  const timeoutMs = notificationTimeoutMs(env);
  const dedupeMs = notificationEventDedupeMs(env);
  const normalized = normalizeEvent(event);
  const dedupeKey = `${normalized.type}:${normalized.threadId || normalized.projectName || normalized.url || "global"}`;
  const now = Date.now();
  const lastSentAt = recentEventNotifications.get(dedupeKey) || 0;
  if (!options.force && dedupeMs && now - lastSentAt < dedupeMs) return [];
  recentEventNotifications.set(dedupeKey, now);

  const notification = {
    title: normalized.title,
    tags: eventTags(normalized),
    clickUrl: normalized.url,
    clickTitle: "Open phone bridge",
    message: eventNotificationMessage(normalized),
  };
  const results = [];

  for (const target of targets) {
    try {
      if (target.type === "ntfy") await postNtfyNotification(target, notification, fetchImpl, timeoutMs);
      if (target.type === "pushover") await postPushoverNotification(target, notification, fetchImpl, timeoutMs);
      if (target.type === "discord") await postDiscordNotification(target, notification, fetchImpl, timeoutMs);
      results.push({ type: target.type, ok: true });
    } catch (error) {
      results.push({ type: target.type, ok: false, error: error.message });
    }
  }

  return results;
}

module.exports = {
  bridgeUrls,
  eventNotificationMessage,
  eventTypeLabel,
  notificationEventDedupeMs,
  notificationEventsEnabled,
  notificationMessage,
  notificationTargets,
  notificationTimeoutMs,
  redactNotificationText,
  startupTokenUrlsEnabled,
  notifyEvent,
  notifyTaskEvent,
  notifyBridgeUrls,
  stripTokenFromUrl,
  taskNotificationMessage,
};
