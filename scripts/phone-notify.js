const { slotSettingValue } = require("./phone-slot-settings");

// The token is written by whoever made `.phone-token`, so it can hold anything
// a keyboard or a stray `printf '...\n'` puts there. Pasted in raw, a backslash,
// a space or an `&` ends the query early or is rewritten by the browser, and the
// address that arrives carries a token that does not match: a Home Screen icon
// added from it can never connect, and nothing about it looks like an encoding
// problem. Encode it, and every token survives the trip.
function bridgeUrls(addresses, uiPort, phoneToken) {
  const token = encodeURIComponent(phoneToken ?? "");
  return addresses.map((address) => `http://${address}:${uiPort}/?token=${token}`);
}

// True when the raw token would not survive being pasted into a URL as-is, so
// the bridge can say so once at startup instead of leaving the owner to find out
// from an icon that silently never connects.
function tokenNeedsUrlEncoding(phoneToken) {
  const token = String(phoneToken ?? "");
  return Boolean(token) && encodeURIComponent(token) !== token;
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

// How much of the answer a completion notification quotes. The quote is what
// lets the reader tell from the notification alone what finished, without
// opening the app; `0` leaves it out for a channel that should not carry it.
const defaultExcerptChars = 200;

function notificationExcerptChars(env = process.env) {
  const raw = envValue(env, "PHONE_NOTIFY_EXCERPT_CHARS");
  if (raw === undefined || raw === "") return defaultExcerptChars;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultExcerptChars;
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

// Which Mac a message is about has to be visible before the message is read:
// two Macs post to the same channel, and "Claude finished" from one of them
// looks exactly like the other. Each Mac gets the colour its Home Screen icon
// carries in the phone UI - mini amber, Air blue - and any other name a fixed
// colour of its own. `PHONE_BRIDGE_COLOR` overrides the guess.
const machineAccentColors = { mini: "#F59E0B", air: "#2563EB" };
const accentPalette = ["#FF5D22", "#7C3AED", "#0F766E", "#DB2777", "#CA8A04", "#0891B2"];
const neutralAccentColor = "#6B7280";

function sanitizeHexColor(value) {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : "";
}

function machineColor(machine, override = "") {
  const forced = sanitizeHexColor(override);
  if (forced) return forced;
  const key = String(machine || "").trim().toLowerCase();
  if (!key) return neutralAccentColor;
  if (/(?:^|[^a-z])mini(?:[^a-z]|$)|mac.?mini/.test(key)) return machineAccentColors.mini;
  if (/(?:^|[^a-z])air(?:[^a-z]|$)|macbook.?air/.test(key)) return machineAccentColors.air;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return accentPalette[hash % accentPalette.length];
}

function colorInteger(hex) {
  return Number.parseInt((sanitizeHexColor(hex) || neutralAccentColor).slice(1), 16);
}

// A quote for a notification: one line, markdown scaffolding dropped, cut to
// `max` characters. An answer is written for a screen that scrolls; the
// notification banner it is quoted into does not.
function notificationExcerpt(value, max = defaultExcerptChars) {
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return "";
  const text = String(value || "")
    .replace(/```[^\n]*\n?/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[#>*\-+]+|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

// The first line of what the person asked. It is what the phone's chat list
// shows as the chat's name, so a notification that opens with it is recognised
// the way the chat itself is.
const promptExcerptChars = 80;

// A notification is read by a person, on a phone, and this one is read in
// Japanese - the same language the UI it links to is written in. Only the
// identifiers stay as they are: a thread id, a turn id, a model name and the
// event type are looked up and pasted, not read.
function startupNotificationParts(urls, { machine = "", project = "", color = "" } = {}) {
  const headline = machine ? `🟢 ${machine} のスマホブリッジが起動しました` : "🟢 スマホブリッジが起動しました";
  const lines = [];
  if (project) lines.push(`フォルダ: ${project}`);
  lines.push("");
  if (urls.length) {
    lines.push("ホーム画面のアプリから、いつも通り開けます。アプリがまだない場合は下のURLを開いてください。", "", ...urls);
  } else {
    lines.push("接続用のURLを見つけられませんでした。Mac側の画面を確認してください。");
  }
  return {
    headline,
    body: lines.join("\n").replace(/^\n+/, ""),
    author: ["スマホブリッジ", machine].filter(Boolean).join(" "),
    color: machineColor(machine, color),
  };
}

function notificationMessage(urls, options = {}) {
  const parts = startupNotificationParts(urls, options);
  return `${parts.headline}\n${parts.body}`;
}

const providerLabels = { codex: "Codex", claude: "Claude" };

function providerLabel(provider) {
  const key = String(provider || "").toLowerCase();
  return providerLabels[key] || provider || "Codex";
}

// Plain words for each kind of event. The raw type used to be printed beside
// its label, for a search in the channel to match on; the owner read it as
// noise, and a search matches the Japanese heading just as well.
const eventTypeLabels = {
  bridge_started: "起動",
  turn_completed: "作業終了",
  approval_required: "承認待ち",
  approval_expired: "承認の時間切れ",
  question_required: "質問待ち",
  test_failed: "失敗",
  connection_lost: "接続切れ",
  history_sync_failed: "履歴同期の失敗",
  long_running: "長時間の処理",
};

function eventTypeLabel(type) {
  return eventTypeLabels[String(type || "")] || String(type || "").replace(/_/g, " ");
}

// A path in a notification only has to say which file; the folders above the
// project are the same in every message and stop the eye.
function shortPath(value) {
  const text = String(value || "").trim();
  const parts = text.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return text;
  return `…/${parts.slice(-2).join("/")}`;
}

function commandText(value) {
  if (Array.isArray(value)) return value.map((part) => String(part)).join(" ").trim();
  return String(value || "").replace(/\s+/g, " ").trim();
}

function changedPaths(params = {}, input = {}) {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) found.push(shortPath(value));
  };
  const changes = params.changes ?? params.fileChanges ?? input.changes;
  if (Array.isArray(changes)) changes.forEach((change) => push(typeof change === "string" ? change : change?.path || change?.file));
  else if (changes && typeof changes === "object") Object.keys(changes).forEach(push);
  [params.path, params.filePath, input.file_path, input.path, input.notebook_path].forEach(push);
  return [...new Set(found)];
}

// What an approval request is asking for, said the way the phone's approval
// card says it: a command, a file change, a question, or the tool by name. Both
// providers arrive here - Codex as a JSON-RPC method with params, Claude as a
// tool name with its input - and neither is something to paste into a message.
function approvalDetail(request = {}) {
  const method = String(request.method || "");
  const params = request.params && typeof request.params === "object" ? request.params : {};
  const input = params.input && typeof params.input === "object" ? params.input : {};
  const questions = Array.isArray(input.questions)
    ? input.questions.filter((question) => typeof question?.question === "string" && question.question.trim())
    : [];
  if (questions.length) {
    return { kind: "question", questionCount: questions.length, text: questions.map((question) => question.question.trim()).join(" / ") };
  }
  const command = commandText(params.command ?? params.cmd ?? input.command);
  if (command || /commandExecution/i.test(method) || /^bash$/i.test(String(params.toolName || ""))) {
    const description = commandText(params.description ?? input.description);
    return { kind: "command", text: `コマンドの実行: ${command || description || "(内容を取得できませんでした)"}` };
  }
  const paths = changedPaths(params, input);
  if (paths.length || /fileChange|applyPatch/i.test(method)) {
    return { kind: "file", text: `ファイルの変更: ${paths.join(", ") || "(対象を取得できませんでした)"}` };
  }
  const tool = String(params.toolName || method || "確認").trim();
  const summary = commandText(input.description ?? input.url ?? input.pattern ?? input.query ?? "");
  return { kind: "tool", text: summary ? `${tool}: ${summary}` : tool };
}

function normalizeEvent(event = {}) {
  const type = String(event.type || event.status || "bridge_started");
  const severity = eventSeverity({ ...event, type });
  const createdAt = event.createdAt || new Date().toISOString();
  const extra = event.extra && typeof event.extra === "object" ? event.extra : {};
  const excerptChars = Number.isFinite(Number(event.excerptChars)) ? Number(event.excerptChars) : defaultExcerptChars;
  return {
    type,
    status: String(event.status || extra.status || ""),
    provider: String(event.provider || extra.provider || ""),
    machine: redactNotificationText(event.machine || extra.machine || ""),
    title: redactNotificationText(event.title || ""),
    message: redactNotificationText(event.message || ""),
    detail: redactNotificationText(event.detail || ""),
    prompt: redactNotificationText(notificationExcerpt(event.prompt || event.threadTitle || "", promptExcerptChars)),
    reply: redactNotificationText(notificationExcerpt(event.reply || "", excerptChars)),
    questionCount: Number(event.questionCount) || 0,
    minutes: Number(event.minutes) || 0,
    deadlineMinutes: Number(event.deadlineMinutes) || 0,
    threadId: event.threadId || "",
    threadTitle: redactNotificationText(event.threadTitle || ""),
    projectName: redactNotificationText(event.projectName || ""),
    severity,
    createdAt,
    url: stripTokenFromUrl(event.url || ""),
    color: machineColor(event.machine || extra.machine || "", event.color || extra.color || ""),
    extra,
  };
}

// "mini の Claude": the Mac first, because two Macs post to one channel and
// the Mac is what tells their messages apart.
function actorLabel(normalized) {
  const who = providerLabel(normalized.provider);
  return normalized.machine ? `${normalized.machine} の ${who}` : who;
}

// The name the message is posted under, where the channel supports one: the
// same "Claude mini" / "Codex Air" the Home Screen icons are called.
function notificationAuthor(normalized) {
  const machine = normalized.machine || "";
  if (normalized.type === "bridge_started" || normalized.type === "history_sync_failed") {
    return ["スマホブリッジ", machine].filter(Boolean).join(" ");
  }
  return [providerLabel(normalized.provider), machine].filter(Boolean).join(" ");
}

// The first line is the whole notification on a locked phone, so it says who
// did what, in words, before anything else.
function headline(normalized) {
  const who = actorLabel(normalized);
  const machinePrefix = normalized.machine ? `${normalized.machine} の` : "";
  switch (normalized.type) {
    case "turn_completed":
      return normalized.status === "interrupted" ? `⏹ ${who} の作業を途中で止めました` : `✅ ${who} の作業が終わりました`;
    case "approval_required":
      return normalized.questionCount ? `❓ ${who} から質問があります` : `🔔 ${who} が承認を待っています`;
    case "approval_expired":
      return normalized.questionCount ? `⌛ ${who} の質問は時間切れになりました` : `⌛ ${who} の承認待ちは時間切れになりました`;
    case "question_required":
      return `❓ ${who} から質問があります`;
    case "test_failed":
      return `❌ ${who} の作業が失敗しました`;
    case "connection_lost":
      return `⚠️ ${who} との接続が切れました`;
    case "history_sync_failed":
      return `⚠️ ${machinePrefix}チャット履歴の同期に失敗しました`;
    case "long_running":
      return `⏳ ${who} の作業が${normalized.minutes ? `${normalized.minutes}分以上` : "長時間"}続いています`;
    case "bridge_started":
      return `🟢 ${machinePrefix}スマホブリッジが起動しました`;
    default:
      return normalized.title || eventTypeLabel(normalized.type);
  }
}

// What the message has to say beyond its headline, and what the reader can do
// about it. `detail` is the one piece the caller supplies in prose: an error, a
// command, a question. Everything else is derived, so two call sites cannot
// describe the same thing in two ways.
function bodyLines(normalized) {
  const detail = normalized.detail || normalized.message;
  const lines = [];
  switch (normalized.type) {
    case "turn_completed":
      if (normalized.reply) lines.push(`${normalized.status === "interrupted" ? "途中までの返答" : "返答"}: ${normalized.reply}`);
      if (normalized.status === "interrupted") lines.push("", "続きが必要なら、アプリからもう一度送ってください。");
      break;
    case "approval_required":
      if (normalized.questionCount) {
        if (detail) lines.push(`質問: ${detail}`);
        lines.push("", "アプリを開いて答えてください。答えるまで作業は止まっています。");
      } else {
        if (detail) lines.push(`内容: ${detail}`);
        lines.push("", "アプリを開いて「承認」か「拒否」を選んでください。選ぶまで作業は止まっています。");
      }
      // The wait has an end, and the reader should know where it is: a card
      // that has vanished by the time the app is opened otherwise looks like a
      // decision nobody made.
      if (normalized.deadlineMinutes) lines.push(`${normalized.deadlineMinutes}分以内に答えがないときは「拒否」として作業を続けます。`);
      break;
    case "approval_expired":
      if (detail) lines.push(`${normalized.questionCount ? "質問" : "内容"}: ${detail}`);
      lines.push(
        "",
        `${normalized.deadlineMinutes ? `${normalized.deadlineMinutes}分たっても` : ""}答えがなかったため、「拒否」として作業を続けました。必要なら、アプリからもう一度指示してください。`,
      );
      break;
    case "question_required":
      if (detail) lines.push(`質問: ${detail}`);
      lines.push("", "アプリを開いて返信してください。返信するまで作業は進みません。");
      break;
    case "test_failed":
      if (detail) lines.push(`原因: ${detail}`);
      lines.push("", "アプリで内容を確認して、必要ならもう一度送ってください。");
      break;
    case "connection_lost":
      if (detail) lines.push(`詳細: ${detail}`);
      lines.push("", "しばらく待っても直らないときは、アプリの設定にある「再起動」を押すか、Mac側を確認してください。");
      break;
    case "history_sync_failed":
      if (detail) lines.push(`詳細: ${detail}`);
      lines.push("", "作業はそのまま続けられます。ほかのMacにこのチャットの履歴が届いていない可能性があります。");
      break;
    case "long_running":
      lines.push("まだ動いています。止めたい場合はアプリの「中断」を押してください。");
      break;
    case "bridge_started":
      lines.push("ホーム画面のアプリから接続できます。");
      break;
    default:
      if (detail) lines.push(detail);
  }
  return lines;
}

// The message in parts, for a channel that can show them apart: the headline
// as the message text, the rest in a block carrying the Mac's colour, posted
// under the Mac's name. A plain-text channel gets them joined.
function eventNotificationParts(event = {}) {
  const normalized = normalizeEvent(event);
  const lines = [];
  // The Mac is already in the headline; the folder is what the second line adds.
  if (normalized.projectName) lines.push(`フォルダ: ${normalized.projectName}`);
  if (normalized.prompt && normalized.type !== "bridge_started") lines.push(`依頼: ${normalized.prompt}`);
  const body = bodyLines(normalized);
  if (body.length) lines.push("", ...body);
  if (normalized.url) lines.push("", `開く: ${normalized.url}`);
  return {
    headline: headline(normalized),
    body: lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, ""),
    author: notificationAuthor(normalized),
    color: normalized.color,
  };
}

function eventNotificationMessage(event = {}) {
  const parts = eventNotificationParts(event);
  return parts.body ? `${parts.headline}\n${parts.body}` : parts.headline;
}

const statusToType = {
  approval: "approval_required",
  completed: "turn_completed",
  interrupted: "turn_completed",
  failed: "test_failed",
};

// A run event - a turn that finished, failed, was interrupted or is waiting -
// as the structured event the composer reads. The caller hands over what it
// knows: the prompt, the answer, the error, the Mac, the folder.
function runEvent(event = {}) {
  const status = event.status || "updated";
  return {
    type: statusToType[status] || status,
    status,
    provider: event.provider,
    machine: event.machine || "",
    projectName: event.projectName || event.workdir?.split(/[\\/]/).filter(Boolean).pop() || "",
    threadId: event.threadId,
    prompt: event.prompt || "",
    reply: event.reply || "",
    detail: event.message || "",
    excerptChars: event.excerptChars,
    severity: status === "failed" ? "error" : status === "approval" ? "warning" : "info",
    url: stripTokenFromUrl(event.url || ""),
    extra: {
      provider: event.provider,
      turnId: event.turnId,
      model: event.model,
    },
  };
}

function taskNotificationMessage(event = {}) {
  return eventNotificationMessage(runEvent(event));
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

// An HTTP header carries bytes, not Japanese: `fetch` refuses a header value
// with a character above Latin-1. ntfy reads RFC 2047 in its title header, so
// a Japanese title travels encoded and arrives readable.
function ntfyHeaderValue(value) {
  const text = String(value || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

async function postNtfy(target, urls, fetchImpl, timeoutMs, message) {
  return postNtfyNotification(
    target,
    {
      title: "スマホブリッジが起動しました",
      tags: "computer,phone",
      clickUrl: urls[0],
      message,
    },
    fetchImpl,
    timeoutMs,
  );
}

async function postNtfyNotification(target, notification, fetchImpl, timeoutMs) {
  const headers = {
    title: ntfyHeaderValue(notification.title),
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

async function postPushover(target, urls, fetchImpl, timeoutMs, message) {
  return postPushoverNotification(
    target,
    {
      title: "スマホブリッジが起動しました",
      clickUrl: urls[0],
      clickTitle: "スマホブリッジを開く",
      message,
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
    form.set("url_title", notification.clickTitle || "スマホブリッジを開く");
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

// A Discord post is three things the channel shows apart, and all three say
// which Mac it came from: the name it is posted under ("Claude mini"), the
// headline as the message text (what a lock screen shows), and the rest in an
// embed whose left edge carries that Mac's colour.
function discordPayload(notification) {
  const payload = {
    content: notification.headline || notification.message,
    allowed_mentions: { parse: [] },
  };
  if (notification.author) payload.username = notification.author;
  if (notification.headline && notification.body) {
    payload.embeds = [{ description: notification.body, color: colorInteger(notification.color) }];
  }
  return payload;
}

async function postDiscordNotification(target, notification, fetchImpl, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, discordEndpoint(target), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(discordPayload(notification)),
  }, timeoutMs);
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`);
}

async function notifyBridgeUrls(urls, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const targets = notificationTargets(env);
  const timeoutMs = notificationTimeoutMs(env);
  const parts = startupNotificationParts(urls, { machine: options.machine, project: options.project, color: options.color });
  const message = `${parts.headline}\n${parts.body}`;
  const results = [];

  for (const target of targets) {
    try {
      if (target.type === "ntfy") await postNtfy(target, urls, fetchImpl, timeoutMs, message);
      if (target.type === "pushover") await postPushover(target, urls, fetchImpl, timeoutMs, message);
      if (target.type === "discord") await postDiscordNotification(target, { ...parts, message }, fetchImpl, timeoutMs);
      results.push({ type: target.type, ok: true });
    } catch (error) {
      results.push({ type: target.type, ok: false, error: error.message });
    }
  }

  return results;
}

async function notifyTaskEvent(event = {}, options = {}) {
  const env = options.env || process.env;
  return notifyEvent(runEvent({ ...event, excerptChars: event.excerptChars ?? notificationExcerptChars(env) }), options);
}

const recentEventNotifications = new Map();

async function notifyEvent(event = {}, options = {}) {
  const env = options.env || process.env;
  if (!notificationEventsEnabled(env) && !options.force) return [];
  const fetchImpl = options.fetch || fetch;
  const targets = notificationTargets(env);
  const timeoutMs = notificationTimeoutMs(env);
  const dedupeMs = notificationEventDedupeMs(env);
  const normalized = normalizeEvent({ ...event, excerptChars: event.excerptChars ?? notificationExcerptChars(env) });
  const dedupeKey = `${normalized.type}:${normalized.threadId || normalized.projectName || normalized.url || "global"}`;
  const now = Date.now();
  const lastSentAt = recentEventNotifications.get(dedupeKey) || 0;
  if (!options.force && dedupeMs && now - lastSentAt < dedupeMs) return [];
  recentEventNotifications.set(dedupeKey, now);

  const parts = eventNotificationParts(normalized);
  const notification = {
    ...parts,
    title: parts.headline,
    tags: eventTags(normalized),
    clickUrl: normalized.url,
    clickTitle: "スマホブリッジを開く",
    message: parts.body ? `${parts.headline}\n${parts.body}` : parts.headline,
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
  approvalDetail,
  bridgeUrls,
  tokenNeedsUrlEncoding,
  discordPayload,
  eventNotificationMessage,
  eventNotificationParts,
  eventTypeLabel,
  machineColor,
  notificationEventDedupeMs,
  notificationEventsEnabled,
  notificationExcerpt,
  notificationExcerptChars,
  notificationMessage,
  notificationTargets,
  notificationTimeoutMs,
  ntfyHeaderValue,
  redactNotificationText,
  startupTokenUrlsEnabled,
  notifyEvent,
  notifyTaskEvent,
  notifyBridgeUrls,
  stripTokenFromUrl,
  taskNotificationMessage,
};
