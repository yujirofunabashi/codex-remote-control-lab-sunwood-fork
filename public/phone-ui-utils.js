(function initPhoneUiUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.CodexPhoneUiUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const defaultThreadPalette = [
    "#ff5d22",
    "#7c3aed",
    "#2563eb",
    "#0f766e",
    "#3f7f4b",
    "#ca8a04",
    "#dc2626",
    "#db2777",
    "#475569",
  ];
  const terminalKinds = new Set(["status", "command", "file", "approval", "user", "assistant", "error", "lifecycle"]);
  const terminalHistoryLimit = 300;

  // Scope a conversation by Mac and provider, not by the currently open tab.
  function sessionActivityKey(item = {}) {
    return JSON.stringify([item.machineKey || item.bridgeId, item.provider, item.threadId]);
  }

  function sessionActivityStatus(run = {}, pendingApproval = null) {
    const request = pendingApproval || run.pendingApproval;
    if (request?.params?.toolName === "AskUserQuestion" || /requestUserInput$/.test(request?.method || "")) return "question";
    if (request || run.state === "approval") return "approval";
    if (["running", "streaming", "syncing", "interrupting"].includes(run.state)) return "running";
    if (["done", "completed"].includes(run.state)) return "done";
    if (["question", "question_required"].includes(run.state)) return "question";
    if (["error", "test_failed"].includes(run.state)) return "error";
    if (run.state === "interrupted") return "interrupted";
    if (["disconnected", "offline"].includes(run.state)) return "offline";
    return "idle";
  }

  function reconcileSessionActivity(previous = [], observations = [], options = {}) {
    const knownBridges = options.bridgeIds && new Set(options.bridgeIds);
    const records = new Map(previous.filter((item) => item?.key && (!knownBridges || knownBridges.has(item.bridgeId))).map((item) => [item.key, { ...item }]));
    const sources = new Map();
    for (const observation of observations) {
      const key = sessionActivityKey(observation);
      const other = sources.get(key);
      const online = sessionActivityStatus(observation.run, observation.pendingApproval) !== "offline";
      const otherOnline = other && sessionActivityStatus(other.run, other.pendingApproval) !== "offline";
      if (!other || (online && !otherOnline) || (online === otherOnline && timestampValueMs(observation.run?.updatedAt) > timestampValueMs(other.run?.updatedAt))) sources.set(key, observation);
    }
    for (const observation of sources.values()) {
      if (!observation.threadId || !["codex", "claude"].includes(observation.provider)) continue;
      const key = sessionActivityKey(observation);
      const old = records.get(key) || Array.from(records.values()).find((item) => item.bridgeId === observation.bridgeId && item.provider === observation.provider && item.threadId === observation.threadId);
      if (old && old.key !== key) records.delete(old.key);
      const status = sessionActivityStatus(observation.run, observation.pendingApproval);
      if (!old && status === "idle") continue;
      const group = JSON.stringify([observation.machineKey || observation.bridgeId, observation.provider]);
      const ordinal = old?.ordinal || 1 + Math.max(0, ...Array.from(records.values()).filter((item) => item.group === group).map((item) => item.ordinal || 0));
      const completion = status === "done"
        ? String(observation.run?.turnId || observation.run?.updatedAt || (old?.status === "done" && old.completion) || options.now || Date.now())
        : old?.completion || "";
      const next = {
        key, group, ordinal,
        bridgeId: observation.bridgeId,
        machineKey: observation.machineKey,
        machineLabel: observation.machineLabel,
        threadId: observation.threadId,
        provider: observation.provider,
        title: observation.title || old?.title || "名前未設定のチャット",
        workdir: observation.workdir || old?.workdir || "",
        status, completion,
        acknowledged: status === "running" ? "" : old?.acknowledged || "",
      };
      // An idle reconnect or an expired watcher is not evidence that the
      // owner has read the completed answer.
      if (status === "idle" && old?.status === "done" && old.acknowledged !== old.completion) next.status = "done";
      records.set(key, next);
    }
    return Array.from(records.values());
  }

  function visibleSessionActivity(records = []) {
    return records.filter((item) => item.status !== "idle" && !(item.status === "done" && item.acknowledged === item.completion));
  }

  function acknowledgeSessionActivity(records = [], key = "") {
    return records.map((item) => item.key === key && item.status === "done" ? { ...item, acknowledged: item.completion } : item);
  }

  function safeJsonParse(value, fallback, options = {}) {
    if (value === undefined || value === null || value === "") return fallback;
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (options.objectOnly && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) return fallback;
      if (options.arrayOnly && !Array.isArray(parsed)) return fallback;
      return parsed;
    } catch {
      return fallback;
    }
  }

  function safeJsonStringify(value, fallback = "{}") {
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  function sanitizeHexColor(value) {
    const text = String(value || "").trim();
    const match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return "";
    if (match[1].length === 6) return `#${match[1].toLowerCase()}`;
    return `#${match[1]
      .split("")
      .map((char) => `${char}${char}`)
      .join("")
      .toLowerCase()}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value || "")) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function fallbackThreadColor(key, palette = defaultThreadPalette) {
    const colors = Array.isArray(palette) && palette.length ? palette : defaultThreadPalette;
    return colors[hashString(key || "thread") % colors.length];
  }

  function contrastColorFor(hex) {
    const color = sanitizeHexColor(hex) || "#000000";
    const r = Number.parseInt(color.slice(1, 3), 16) / 255;
    const g = Number.parseInt(color.slice(3, 5), 16) / 255;
    const b = Number.parseInt(color.slice(5, 7), 16) / 255;
    const linear = [r, g, b].map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    return luminance > 0.58 ? "#141414" : "#ffffff";
  }

  function compactWorkspacePath(value, options = {}) {
    const text = String(value || "").trim();
    if (!text || text === ".") return text;
    const normalized = text.replace(/\\/g, "/").replace(/^\/Users\/[^/]+/, "~");
    const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
    const rest = prefix ? normalized.slice(prefix.length) : normalized;
    const parts = rest.split("/").filter(Boolean);
    const keepStart = Math.max(0, Number(options.keepStart ?? 1));
    const keepEnd = Math.max(1, Number(options.keepEnd ?? 1));
    if (parts.length <= keepStart + keepEnd) return normalized;
    return `${prefix}${parts.slice(0, keepStart).join("/")}/.../${parts.slice(-keepEnd).join("/")}`;
  }

  function middleEllipsis(value, options = {}) {
    const text = String(value || "");
    const max = Math.max(4, Number(options.max || 32));
    if (text.length <= max) return text;
    const marker = String(options.marker || "...");
    const available = Math.max(1, max - marker.length);
    const head = Math.max(1, Number(options.head || Math.ceil(available * 0.55)));
    const tail = Math.max(1, Number(options.tail || available - head));
    if (head + tail + marker.length >= text.length) return text;
    return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
  }

  function isMobileViewport(width) {
    return Number(width || 0) > 0 && Number(width) <= 820;
  }

  // Names the UI invented for a bridge that has not told us its own yet. They
  // are display text, not names: a bridge seeded with one has to take the label
  // it reports over `/api/bridge/info` the moment it answers, and must never
  // show the seed as though someone had chosen it. `現在の接続先` is here because
  // it was once written into the registry verbatim, so registries in the wild
  // still carry it and have to heal on the next refresh.
  const placeholderBridgeLabels = new Set(["Home", "Home bridge", "現在の接続先", "接続先"]);

  function isPlaceholderBridgeLabel(label) {
    const text = String(label || "").trim();
    return !text || placeholderBridgeLabels.has(text);
  }

  // The drawer's edge strip. A drag that starts here belongs to the drawer, and
  // the chat-switch swipe sharing the same screen has to let it go: the two
  // gestures are told apart by where the finger lands, not by which way it
  // travels, because both of them are a rightward drag over the conversation.
  const sidebarEdgeSwipeZone = 26;

  // Anything drawn above the drawer owns the screen while it is open. Opening a
  // drawer underneath a sheet would look like the swipe did nothing, so these
  // surfaces hold the gesture back until they are dismissed.
  const sidebarEdgeSwipeBlockerSelector = [
    ".prompt-modal:not(.hidden)",
    ".command-sheet:not(.hidden)",
    ".bridge-fleet-sheet:not(.hidden)",
    ".terminal-tools-sheet:not(.hidden)",
    ".thread-switcher:not(.hidden)",
    ".thread-color-popover:not(.hidden)",
    ".model-menu:not(.hidden)",
  ].join(",");

  function startsSidebarEdgeSwipe(options = {}) {
    if (options.sidebarOpen) return false;
    if (!isMobileViewport(options.width)) return false;
    const x = Number(options.x);
    if (!Number.isFinite(x)) return false;
    return x >= 0 && x <= sidebarEdgeSwipeZone;
  }

  function completesSidebarEdgeSwipe(options = {}) {
    const dx = Number(options.dx || 0);
    const dy = Number(options.dy || 0);
    if (Number(options.elapsed || 0) > 900) return false;
    if (dx < 64) return false;
    // Looser than the chat-switch swipe: this one already proved its intent by
    // starting on the edge, so a drag that drifts downward still counts.
    return dx >= Math.abs(dy) * 1.2;
  }

  // Every control that opens the connection sheet sits outside it, so the same
  // click that opens the sheet also reaches the click-outside rule that closes
  // it. Openers carry this marker instead of being listed one by one, so a new
  // opener cannot be added without the rule knowing about it - the failure it
  // causes is a button that looks dead, with the sheet opening and closing
  // inside one tap.
  const bridgeFleetOpenerSelector = "[data-opens-bridge-fleet]";

  function clickClosesBridgeFleet(target, sheet) {
    if (!sheet || !target) return false;
    if (typeof sheet.contains === "function" && sheet.contains(target)) return false;
    if (typeof target.closest === "function" && target.closest(bridgeFleetOpenerSelector)) return false;
    return true;
  }

  function isStandaloneDisplayMode(env = {}) {
    const target = env || {};
    const nav = target.navigator || {};
    const standaloneMedia =
      typeof target.matchMedia === "function" &&
      target.matchMedia("(display-mode: standalone)")?.matches;
    return Boolean(standaloneMedia || nav.standalone === true);
  }

  function visualViewportVars(env = {}) {
    const target = env || {};
    const viewport = target.visualViewport || null;
    const innerHeight = Number(target.innerHeight || viewport?.height || 0);
    const height = Math.max(0, Math.round(Number(viewport?.height || innerHeight || 0)));
    const offsetTop = Math.max(0, Math.round(Number(viewport?.offsetTop || 0)));
    const keyboardInset = viewport && innerHeight ? Math.max(0, Math.round(innerHeight - viewport.height - offsetTop)) : 0;
    return {
      visualViewportHeight: height,
      visualViewportOffsetTop: offsetTop,
      keyboardInset,
    };
  }

  function effectiveAppViewportHeight(env = {}, options = {}) {
    const vars = options.viewportVars || visualViewportVars(env);
    const innerHeight = Math.max(0, Math.round(Number(env?.innerHeight || vars.visualViewportHeight || 0)));
    const visualHeight = Math.max(0, Math.round(Number(vars.visualViewportHeight || innerHeight || 0)));
    const keyboardInset = Math.max(0, Math.round(Number(vars.keyboardInset || 0)));
    const keyboardThreshold = Math.max(0, Math.round(Number(options.keyboardThreshold ?? 80)));
    const standalone =
      typeof options.standalone === "boolean" ? options.standalone : isStandaloneDisplayMode(env);

    if (keyboardInset > keyboardThreshold && !standalone && innerHeight > visualHeight) return innerHeight;
    return visualHeight || innerHeight;
  }

  function terminalCompactState(options = {}) {
    const mainViewMode = options.mainViewMode === "terminal" ? "terminal" : "chat";
    const mobile = Boolean(options.mobile ?? isMobileViewport(options.width));
    const maxMode = Boolean(options.maxMode);
    const standalone = Boolean(options.standalone);
    return {
      compact: mobile && mainViewMode === "terminal",
      max: mainViewMode === "terminal" && maxMode,
      standaloneCompact: mobile && mainViewMode === "terminal" && standalone,
    };
  }

  function shouldShowQuickBar(options = {}) {
    return (
      options.mainViewMode === "terminal" &&
      (options.inputFocused === true || options.inputMode === "keys" || options.pinned === true)
    );
  }

  function canSuggestPwaInstall(options = {}) {
    return Boolean(
      options.mobile &&
        !options.standalone &&
        !options.dismissed &&
        (options.secureContext || options.isLocalhost || options.allowInsecureHint),
    );
  }

  function serviceWorkerRegistrationAllowed(options = {}) {
    return Boolean(options.enableSw && options.secureContext);
  }

  function pwaManifestTokenIssues(manifest = {}) {
    const text = safeJsonStringify(manifest, "");
    return {
      hasTokenParam: /[?&]token=/i.test(text),
      hasSecretField: /"(?:token|secret|authorization)"\s*:/i.test(text),
    };
  }

  function shouldReloadInstallWithStoredToken(options = {}) {
    const pathname = String(options.pathname || "").replace(/\/+$/, "") || "/";
    const search = new URLSearchParams(String(options.search || ""));
    return Boolean(
      pathname.endsWith("/install") &&
        options.storedToken &&
        !search.has("token") &&
        !options.standalone,
    );
  }

  async function loadThreadsAfterProviderSync(syncProvider, loadThreads, options = {}) {
    try {
      if (typeof syncProvider === "function") await syncProvider();
    } catch {
      // A provider lookup can fail while a bridge is waking. The thread loader
      // still gets one chance to recover from the provider it already knows.
    }
    if (typeof loadThreads !== "function") return undefined;
    return loadThreads(options);
  }

  function workspaceKeyForThreadRecord(thread = {}, fallback = "") {
    const record = thread || {};
    const raw = record.cwd || record.workspaceLocation || record.workdir || fallback || "";
    return String(raw).trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function sameWorkspaceThreadRecord(thread = {}, baseKey = "") {
    const normalizedBase = String(baseKey || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const candidate = workspaceKeyForThreadRecord(thread);
    if (!normalizedBase || !candidate) return true;
    return candidate === normalizedBase;
  }

  function isOpaqueThreadId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
  }

  // The command always resumes on the owner, never on whichever Mac happened
  // to receive the paste. Air/mini use the operator's existing SSH aliases;
  // other hosts use their hostname and require ordinary SSH configuration.
  function codexRemoteEndpoint({ codexUrl = "", codexSocketPath = "" } = {}) {
    if (codexSocketPath) {
      const socket = String(codexSocketPath);
      return socket.startsWith("/") && !/[\r\n\0]/.test(socket) ? `unix://${socket}` : "";
    }
    try {
      const url = new URL(codexUrl);
      // The command runs on the owning Mac after the SSH hop. Never copy
      // credentials or dial an unrelated network service from that Mac.
      if (!["ws:", "wss:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) return "";
      return String(codexUrl);
    } catch {
      return "";
    }
  }

  function resumeCommandForThread(thread = {}, options = {}) {
    const { hostName = "" } = options;
    const provider = String(thread.provider || "").trim().toLowerCase();
    if (!["codex", "claude"].includes(provider)) return "";
    const id = String(thread.id || "").trim();
    const cwd = String(thread.cwd || "").trim().replace(/\/+$/, "") || (thread.cwd === "/" ? "/" : "");
    const host = String(hostName || "").trim();
    // Missing ownership, placeholder IDs and relative folders must not turn
    // into a plausible command that accidentally starts another conversation.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || !cwd.startsWith("/") || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) return "";
    const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const machine = machineLabelFromHost(host).toLowerCase();
    const destination = ["air", "mini"].includes(machine) ? machine : host;
    const endpoint = provider === "codex" ? codexRemoteEndpoint(options) : "";
    // A plain resume creates another writer and fails while the phone owns
    // the conversation. Both interfaces must join the same app-server.
    if (provider === "codex" && !endpoint) return "";
    const resume = `${provider} ${provider === "codex" ? "resume" : "--resume"} ${quote(id)}${endpoint ? ` --remote ${quote(endpoint)}` : ""}`;
    const local = `cd -- ${quote(cwd)} && exec ${resume}`;
    // Check again after SSH: a stale alias must fail, not resume a session on
    // the wrong host. A login/interactive shell loads the owner's CLI PATH.
    const guard = `[ "$(hostname)" = ${quote(host)} ] || { printf '%s\\n' 'Resume stopped: unexpected host.' >&2; exit 1; }`;
    const remote = `zsh -lic ${quote(`${guard}; ${local}`)}`;
    return `if [ "$(hostname)" = ${quote(host)} ]; then (${local}); else ssh -t ${quote(destination)} ${quote(remote)}; fi`;
  }

  function threadDisplayTitle(thread = {}, options = {}) {
    const fallback = String(options.fallback || "名前未設定のチャット");
    const max = Math.max(12, Number(options.max || 54));
    const raw = String(thread.displayTitle || thread.name || thread.preview || thread.cwd || "").trim();
    const firstLine = raw.split("\n").find(Boolean) || "";
    if (!firstLine || firstLine === thread.id || isOpaqueThreadId(firstLine)) return fallback;
    return firstLine.length > max ? `${firstLine.slice(0, max)}...` : firstLine;
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

  function threadTimestamp(thread = {}) {
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

  function threadSortTimestamp(thread = {}) {
    const localFields = [
      ["lastViewedAt", "auto"],
      ["last_viewed_at", "auto"],
      ["localViewedAt", "auto"],
    ];
    for (const [field, unit] of localFields) {
      const timestamp = timestampValueMs(thread[field], unit);
      if (timestamp) return timestamp;
    }
    return threadTimestamp(thread);
  }

  function redactSensitiveText(value) {
    return String(value || "")
      .replace(/([?&](?:token|key)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/\b(PHONE_TOKEN=)[^\s]+/gi, "$1[redacted]")
      .replace(/\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
      .replace(/\b(token:\s*)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
  }

  function maskToken(value) {
    const text = String(value || "");
    if (!text) return "";
    const mask = (token) => {
      const secret = String(token || "");
      if (!secret) return "";
      if (secret.length <= 8) return "****";
      return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
    };
    if (/[?&](?:token|key)=/i.test(text)) {
      return text.replace(/([?&](?:token|key)=)([^&\s]+)/gi, (_, prefix, secret) => `${prefix}${mask(secret)}`);
    }
    return mask(text);
  }

  function urlWithoutTokenParam(value) {
    try {
      const url = new URL(String(value));
      url.searchParams.delete("token");
      return url.toString();
    } catch {
      return String(value || "").replace(/([?&])token=[^&\s]*&?/gi, (match, prefix) => (match.endsWith("&") ? prefix : ""));
    }
  }

  function normalizeBridgeBaseUrl(value, fallbackOrigin = "") {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const url = new URL(withProtocol, fallbackOrigin || undefined);
      url.search = "";
      url.hash = "";
      let pathname = url.pathname.replace(/\/+$/, "");
      if (!/^\/(?:abs)?proxy\/\d+(?:\/|$)/.test(pathname)) pathname = "";
      return `${url.protocol}//${url.host}${pathname}`;
    } catch {
      return "";
    }
  }

  function bridgeIdFromBaseUrl(baseUrl) {
    const normalized = normalizeBridgeBaseUrl(baseUrl);
    return normalized ? `bridge-${hashString(normalized).toString(36)}` : "";
  }

  // A loopback address names whichever device reads it, so a bridge registered
  // at one is reachable only from the Mac that registered it. The backup is
  // shared - the phone restores the list from it - and on the phone the same
  // address points at the phone, which runs no bridge. That is where the second
  // `mini Claude` came from: one row for the Mac that works, one for the same
  // Mac that can never connect and shows as 切断 for good.
  function isDeviceLocalBridgeUrl(baseUrl) {
    const normalized = normalizeBridgeBaseUrl(baseUrl);
    if (!normalized) return false;
    let host = "";
    try {
      host = new URL(normalized).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    // URL keeps IPv6 hosts bracketed, and ::1 is spelled several ways.
    if (/^\[(?:0*:)*0*1\]$/.test(host)) return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  }

  function parseBridgeUrl(input, options = {}) {
    const text = String(input || "").trim();
    if (!text) return null;
    let urlText = text;
    let explicitToken = options.token || "";
    const parts = text.split(/[,\s]+/).filter(Boolean);
    if (!/[/?#]/.test(text) && parts.length >= 2) {
      const host = parts[0];
      const port = parts.find((part, index) => index > 0 && /^\d{2,5}$/.test(part));
      const tokenPart = parts.find((part) => !/^\d{2,5}$/.test(part) && part !== host);
      if (host && port) {
        urlText = `http://${host}:${port}/`;
        explicitToken = explicitToken || tokenPart || "";
      }
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText)) urlText = `http://${urlText}`;
    try {
      const url = new URL(urlText, options.fallbackOrigin || undefined);
      const token = explicitToken || url.searchParams.get("token") || url.searchParams.get("key") || "";
      const baseUrl = normalizeBridgeBaseUrl(url.href, options.fallbackOrigin || "");
      if (!baseUrl) return null;
      const base = new URL(baseUrl);
      return {
        baseUrl,
        token,
        host: base.hostname,
        port: base.port || (base.protocol === "https:" ? "443" : "80"),
        label: options.label || "",
      };
    } catch {
      return null;
    }
  }

  function normalizeBridgeEntry(entry = {}, options = {}) {
    const parsed = parseBridgeUrl(entry.url || entry.baseUrl || "", {
      token: entry.token || options.token || "",
      fallbackOrigin: options.fallbackOrigin || "",
      label: entry.label || "",
    });
    const baseUrl = parsed?.baseUrl || normalizeBridgeBaseUrl(entry.baseUrl || "", options.fallbackOrigin || "");
    if (!baseUrl) return null;
    const url = new URL(baseUrl);
    const id = String(entry.id || bridgeIdFromBaseUrl(baseUrl)).trim();
    const now = Number(options.now || Date.now());
    const label =
      String(entry.label || parsed?.label || entry.workdirLabel || entry.workdirBasename || url.hostname || id).trim() || id;
    return {
      id,
      name: String(entry.name || label).trim() || label,
      label,
      group: String(entry.group || "").trim(),
      baseUrl,
      token: String(entry.token || parsed?.token || ""),
      kind: ["lan", "ssh-forward", "vpn", "mesh", "local"].includes(String(entry.kind || "").trim())
        ? String(entry.kind || "").trim()
        : "lan",
      status: String(entry.status || "").trim(),
      note: String(entry.note || "").trim(),
      color: sanitizeHexColor(entry.color) || "",
      workdir: String(entry.workdir || entry.cwd || "").trim(),
      port: Number(entry.port || parsed?.port || url.port || 0) || null,
      rememberToken: entry.rememberToken !== false,
      createdAt: Number(entry.createdAt || now),
      lastUsedAt: Number(entry.lastUsedAt || entry.updatedAt || now),
      updatedAt: now,
    };
  }

  function bridgeThreadKey(bridgeId, threadId) {
    return `${String(bridgeId || "home") || "home"}::${String(threadId || "new") || "new"}`;
  }

  // The service worker fetches each shell file on its own, so a phone can end
  // up running a new main.js beside a cached older copy of this file. main.js
  // checks this number before it will sync anything: without it the merge
  // helpers below are absent, and syncing would mean pushing an unmerged list
  // over the backup. Raise it when a change here would make an older main.js
  // merge incorrectly.
  const bridgeRegistrySyncVersion = 1;

  function registryTombstones(registry = {}) {
    return Array.isArray(registry.deleted) ? registry.deleted.filter((record) => record && record.id) : [];
  }

  function upsertBridgeRegistry(registry = {}, entry = {}) {
    const normalized = normalizeBridgeEntry(entry);
    if (!normalized) return registry && typeof registry === "object" ? registry : { version: 1, bridges: [] };
    const current = Array.isArray(registry.bridges) ? registry.bridges : [];
    const next = [];
    let inserted = false;
    for (const bridge of current) {
      if (bridge.id === normalized.id || normalizeBridgeBaseUrl(bridge.baseUrl) === normalized.baseUrl) {
        next.push({ ...bridge, ...normalized, token: "", createdAt: bridge.createdAt || normalized.createdAt });
        inserted = true;
      } else {
        next.push({ ...bridge, token: "" });
      }
    }
    if (!inserted) next.push({ ...normalized, token: "" });
    // Adding a bridge back is a deliberate act and outranks the record of it
    // having once been removed.
    return { ...registry, version: 1, bridges: next, deleted: registryTombstones(registry).filter((record) => record.id !== normalized.id) };
  }

  // Removal leaves a dated marker behind. Without one, the next restore cannot
  // tell "this device deleted it" from "this device has not heard of it yet",
  // and every deletion comes back on the following sync.
  function removeBridgeFromRegistry(registry = {}, bridgeId = "", options = {}) {
    const id = String(bridgeId || "");
    const current = Array.isArray(registry.bridges) ? registry.bridges : [];
    const deletedAt = Number(options.now || Date.now());
    const deleted = registryTombstones(registry).filter((record) => record.id !== id);
    if (id) deleted.push({ id, deletedAt });
    return { ...registry, version: 1, bridges: current.filter((bridge) => bridge.id !== id), deleted };
  }

  function mergeBridgeEntries(local, remote) {
    const winner = Number(remote.updatedAt || 0) > Number(local.updatedAt || 0) ? remote : local;
    const loser = winner === local ? remote : local;
    const createdCandidates = [Number(local.createdAt || 0), Number(remote.createdAt || 0)].filter((value) => value > 0);
    return {
      ...loser,
      ...winner,
      token: "",
      // Whether this device may write the token down is this device's answer,
      // so another phone's choice never overrides it. Syncing it would let a
      // remembering device turn off "this screen only" here, and the token
      // would then be adopted into storage the owner kept it out of.
      rememberToken: local.rememberToken !== false,
      createdAt: createdCandidates.length ? Math.min(...createdCandidates) : Number(winner.createdAt || 0),
      lastUsedAt: Math.max(Number(local.lastUsedAt || 0), Number(remote.lastUsedAt || 0)),
    };
  }

  function mergeTombstones(local = {}, remote = {}) {
    const byId = new Map();
    for (const record of [...registryTombstones(local), ...registryTombstones(remote)]) {
      const id = String(record.id);
      const deletedAt = Number(record.deletedAt || 0);
      if (!id || deletedAt <= 0) continue;
      const existing = byId.get(id);
      if (!existing || deletedAt > existing.deletedAt) byId.set(id, { id, deletedAt });
    }
    return byId;
  }

  // Restoring a backup is a union of what both sides still have, minus what
  // either side has since deleted. The device may hold bridges the backup
  // predates, and the backup holds the ones the device lost; dropping either
  // half turns a recovery into a second act of forgetting, while ignoring the
  // deletions turns every removal into something that grows back.
  function mergeBridgeRegistries(local = {}, remote = {}) {
    const localBridges = Array.isArray(local.bridges) ? local.bridges : [];
    const remoteBridges = Array.isArray(remote.bridges) ? remote.bridges : [];
    const tombstones = mergeTombstones(local, remote);
    const remoteById = new Map();
    for (const bridge of remoteBridges) {
      if (bridge && bridge.id) remoteById.set(String(bridge.id), bridge);
    }
    const merged = [];
    const used = new Set();
    const survives = (entry) => {
      const tombstone = tombstones.get(String(entry.id));
      if (!tombstone) return true;
      // Only a bridge registered again after the deletion outlives its own
      // tombstone, and registering is the one thing that moves createdAt.
      // updatedAt cannot be the test: the fleet poll rewrites it every few
      // seconds, so an app merely left open would look like a deliberate
      // re-add and would take the removal record down with it.
      if (Number(entry.createdAt || 0) > tombstone.deletedAt) {
        tombstones.delete(String(entry.id));
        return true;
      }
      return false;
    };
    for (const bridge of localBridges) {
      if (!bridge || !bridge.id) continue;
      const id = String(bridge.id);
      if (used.has(id)) continue;
      used.add(id);
      const remoteEntry = remoteById.get(id);
      const entry = remoteEntry ? mergeBridgeEntries(bridge, remoteEntry) : { ...bridge, token: "" };
      if (survives(entry)) merged.push(entry);
    }
    for (const bridge of remoteBridges) {
      if (!bridge || !bridge.id) continue;
      const id = String(bridge.id);
      if (used.has(id)) continue;
      used.add(id);
      const entry = { ...bridge, token: "" };
      if (survives(entry)) merged.push(entry);
    }
    return { ...local, version: 1, bridges: merged, deleted: Array.from(tombstones.values()) };
  }

  function tokenRecord(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value ? { token: value, updatedAt: 0 } : null;
    if (typeof value !== "object") return null;
    const token = String(value.token === undefined || value.token === null ? "" : value.token);
    return token ? { token, updatedAt: Number(value.updatedAt || 0) } : null;
  }

  // The newest token wins, not the nearest one. A device that has been closed
  // since before a rotation would otherwise push its stale key back over the
  // working one. Tokens only survive for bridges that still exist and that the
  // owner asked this device to remember.
  function mergeBridgeTokens(localTokens = {}, remoteTokens = {}, bridges = []) {
    const remembered = new Map();
    for (const bridge of Array.isArray(bridges) ? bridges : []) {
      if (bridge && bridge.id && bridge.rememberToken !== false) remembered.set(String(bridge.id), bridge);
    }
    const out = {};
    for (const source of [remoteTokens, localTokens]) {
      if (!source || typeof source !== "object") continue;
      for (const [rawId, value] of Object.entries(source)) {
        const id = String(rawId);
        if (!remembered.has(id)) continue;
        const record = tokenRecord(value);
        if (!record) continue;
        const existing = out[id];
        if (!existing || record.updatedAt >= existing.updatedAt) out[id] = record;
      }
    }
    return out;
  }

  function normalizeTerminalKind(kind) {
    const value = String(kind || "").toLowerCase();
    if (terminalKinds.has(value)) return value;
    return "status";
  }

  function inferTerminalKindFromText(text) {
    const value = String(text || "");
    if (/^\$\s/.test(value) || /\b(command|コマンド)\b/i.test(value)) return "command";
    if (/file changes|ファイル|changed|modified/i.test(value)) return "file";
    if (/approval|承認/i.test(value)) return "approval";
    if (/error|failed|失敗|エラー/i.test(value)) return "error";
    if (/turn |接続|再接続|ready|completed|完了|切断/i.test(value)) return "lifecycle";
    return "status";
  }

  function normalizeTerminalEntry(entry = {}) {
    const message = redactSensitiveText(entry.message || entry.text || "").slice(0, 1200);
    const detail = entry.detail ? redactSensitiveText(entry.detail).slice(0, 4000) : "";
    const explicitKind = normalizeTerminalKind(entry.kind);
    const kind = entry.kind ? explicitKind : inferTerminalKindFromText(message);
    return {
      id: entry.id || `terminal-${entry.ts || Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: Number(entry.ts) || Date.now(),
      kind,
      message,
      detail,
      turnId: entry.turnId || null,
      source: entry.source || null,
    };
  }

  function capTerminalHistory(entries, limit = terminalHistoryLimit) {
    return (entries || []).slice(-limit);
  }

  function terminalEntryMatches(entry, options = {}) {
    const filter = String(options.filter || "all").toLowerCase();
    const query = String(options.query || "").trim().toLowerCase();
    const kind = normalizeTerminalKind(entry.kind);
    const filterOk =
      filter === "all" ||
      kind === filter ||
      (filter === "errors" && kind === "error") ||
      (filter === "files" && kind === "file") ||
      (filter === "cmd" && kind === "command");
    if (!filterOk) return false;
    if (!query) return true;
    return `${entry.message || ""}\n${entry.detail || ""}`.toLowerCase().includes(query);
  }

  function visibleTerminalEntries(entries, options = {}) {
    return (entries || []).filter((entry) => terminalEntryMatches(entry, options));
  }

  function shouldConfirmDangerousKey(key) {
    return ["Ctrl+C", "SIGINT", "Interrupt"].includes(String(key || ""));
  }

  function keyIntentText(key) {
    const value = String(key || "");
    if (value === "$") return "次のコマンドを安全に実行して結果を確認してください: ";
    if (value === "/") return "/";
    if (value === "Tab") return "\t";
    if (value === "Backspace") return "";
    if (["↑", "↓", "←", "→", "Esc", "Ctrl+L", "Enter"].includes(value)) return `[${value}]`;
    return value;
  }

  const threadStatusMeta = {
    approval_required: { key: "approval_required", label: "許可待ち", tone: "approval", group: "attention", priority: 100 },
    question_required: { key: "question_required", label: "返信待ち", tone: "question", group: "attention", priority: 90 },
    test_failed: { key: "test_failed", label: "確認必要", tone: "error", group: "attention", priority: 80 },
    error: { key: "error", label: "確認必要", tone: "error", group: "attention", priority: 70 },
    running: { key: "running", label: "処理中", tone: "running", group: "running", priority: 60 },
    syncing: { key: "syncing", label: "同期中", tone: "syncing", group: "running", priority: 50 },
    diff_available: { key: "diff_available", label: "変更あり", tone: "diff", group: "recent", priority: 40 },
    disconnected: { key: "disconnected", label: "再接続必要", tone: "error", group: "attention", priority: 35 },
    done: { key: "done", label: "", tone: "done", group: "recent", priority: 20 },
    recent: { key: "recent", label: "", tone: "recent", group: "recent", priority: 20 },
  };

  function threadStatusFromKey(key) {
    return threadStatusMeta[key] || threadStatusMeta.recent;
  }

  function textLooksLikeTestFailure(text) {
    const value = String(text || "");
    if (
      /\b(?:tests?|test suites?)\s+failed\b|\bfailed\s+(?:tests?|test suites?)\b|\btest failed\b|\btest failure\b|テスト(?:が|は)?失敗|テスト失敗/i.test(
        value,
      )
    ) {
      return true;
    }
    const hasTestCommand = /\b(?:npm (?:run )?(?:test|check)|pnpm test|yarn test|pytest|vitest|jest|docs:build)\b/i.test(value);
    if (!hasTestCommand) return false;
    return /(?:^|\n)[^\n]*(?:\bfail\s+[1-9]\d*\b|\b[1-9]\d*\s+failed\b|\bnot ok\b|\bexit(?:ed)?(?: code| with)?\s+[1-9]\d*)/i.test(
      value,
    );
  }

  function deriveThreadStatus(thread = {}, runtimeState = {}) {
    const threadId = String(thread.id || runtimeState.threadId || "");
    const selected = runtimeState.selectedThread && threadId && runtimeState.selectedThread === threadId;
    const runs = Array.isArray(runtimeState.bridgeRuns) ? runtimeState.bridgeRuns : [];
    const runForThread =
      runs.find((item) => String(item.threadId || "") === threadId) ||
      (selected ? { run: { state: runtimeState.currentRunState }, pendingApproval: runtimeState.pendingApproval } : null);
    const runState = String(runForThread?.run?.state || (selected ? runtimeState.currentRunState : thread.runState || "") || "");
    const pendingApproval = Boolean(runForThread?.pendingApproval || (selected && runtimeState.pendingApproval));
    const operationalText = [
      thread.status,
      thread.error,
      ...(Array.isArray(runForThread?.terminalTail)
        ? runForThread.terminalTail.map((entry) => `${entry.message || ""}\n${entry.detail || ""}`)
        : []),
      ...(Array.isArray(runtimeState.terminalEntries) && selected
        ? runtimeState.terminalEntries.map((entry) => `${entry.message || ""}\n${entry.detail || ""}`)
        : []),
    ].join("\n");

    const hasTestFailure = textLooksLikeTestFailure(operationalText);

    if (pendingApproval || runState === "approval") return threadStatusFromKey("approval_required");
    if (runState === "question") return threadStatusFromKey("question_required");
    if (hasTestFailure) return threadStatusFromKey("test_failed");
    if (runState === "error") return threadStatusFromKey("error");
    if (["running", "streaming", "interrupting"].includes(runState)) return threadStatusFromKey("running");
    if (runState === "syncing") return threadStatusFromKey("syncing");
    if (runState === "disconnected") return threadStatusFromKey("disconnected");
    if (thread.dirty || thread.hasDiff || thread.diffAvailable) return threadStatusFromKey("diff_available");
    if (["done", "completed", "interrupted"].includes(runState)) return threadStatusFromKey("done");
    return threadStatusFromKey("recent");
  }

  function sortThreadsForInbox(threads = [], runtimeState = {}) {
    return [...threads].sort((a, b) => {
      const aStatus = deriveThreadStatus(a, runtimeState);
      const bStatus = deriveThreadStatus(b, runtimeState);
      if (bStatus.priority !== aStatus.priority) return bStatus.priority - aStatus.priority;
      return threadSortTimestamp(b) - threadSortTimestamp(a);
    });
  }

  function limitThreadList(threads = [], limit = 6) {
    const list = Array.isArray(threads) ? threads : [];
    const max = Math.max(0, Number(limit || 0));
    return list.slice(0, max);
  }

  function prioritizeSelectedThread(threads = [], selectedThreadId = "", limit = 6) {
    const list = Array.isArray(threads) ? threads : [];
    const max = Math.max(0, Number(limit || 0));
    if (!selectedThreadId) return list.slice(0, max);
    const selectedIndex = list.findIndex((thread) => String(thread?.id || "") === String(selectedThreadId));
    if (selectedIndex < 0) return list.slice(0, max);
    const selected = list[selectedIndex];
    const rest = list.filter((_, index) => index !== selectedIndex);
    return [selected, ...rest].slice(0, max);
  }

  // Apple puts the model in the default hostname, and the model is what anyone
  // actually calls the machine - "Air", not "Yujiro-no-MacBook-Air". Checked
  // longest-first so a MacBook Pro is not read as a Mac Pro.
  const macModelLabels = [
    [/macbook[\s_-]*air/i, "Air"],
    [/macbook[\s_-]*pro/i, "Pro"],
    [/macbook/i, "MacBook"],
    [/mac[\s_-]*mini/i, "mini"],
    [/mac[\s_-]*studio/i, "Studio"],
    [/imac/i, "iMac"],
    [/mac[\s_-]*pro/i, "Mac Pro"],
  ];

  function stripHostSuffix(hostName) {
    return String(hostName || "")
      .trim()
      .replace(/\.(local|lan|home|internal)\.?$/i, "")
      .replace(/\.$/, "");
  }

  // A hostname that names no model falls back to its tail, which is still the
  // half that tells two machines apart.
  function machineLabelFromHost(hostName) {
    const host = stripHostSuffix(hostName);
    if (!host) return "";
    for (const [pattern, label] of macModelLabels) {
      if (pattern.test(host)) return label;
    }
    return shortHostLabel(host);
  }

  // Hostnames identify the machine at their tail: `Yujiro-no-MacBook-Air` and
  // `minijiro-Mac-mini` agree on nothing that matters until the last segments,
  // so a label trimmed from the front is the one that stays distinguishable in
  // a narrow line. Two segments is what carries an Apple model name.
  function shortHostLabel(hostName, segments = 2) {
    const host = stripHostSuffix(hostName);
    if (!host) return "";
    const parts = host.split("-").filter(Boolean);
    const keep = Math.max(1, Number(segments) || 2);
    if (parts.length <= keep) return parts.join("-");
    return parts.slice(-keep).join("-");
  }

  // What a bridge calls the Mac it runs on. PHONE_MACHINE_LABEL wins outright,
  // because a machine whose owner renamed it is not identified by its hostname.
  function machineLabelForBridge(info = {}) {
    const explicit = String(info?.machineLabel || "").trim();
    if (explicit) return explicit;
    return machineLabelFromHost(info?.hostName || info?.host || "");
  }

  // The label is for reading; this is for comparing. Falls back to the bridge id
  // so two unnamed bridges still count as two machines rather than merging.
  function machineScopeKey(machine = "", fallback = "") {
    const text = String(machine || "").trim() || String(fallback || "").trim();
    return text.toLowerCase().replace(/\s+/g, "-");
  }

  // Both Macs keep a `00_受け渡し`, and the Air's copy of this repo is a folder
  // with the same tail as the mini's. A heading keyed on the folder name alone
  // therefore files one machine's sessions under the other's project, so the
  // machine goes into the key, separated by the one character neither a folder
  // name nor a hostname can contain.
  function threadProjectGroupKey(project = "", machine = "") {
    const name = String(project || "").trim() || "No project";
    const scope = machineScopeKey(machine);
    return scope ? `${scope}/${name}` : name;
  }

  // A list that never arrived looks exactly like a Mac with one chat on it: the
  // open chat leaves a stand-in row in the sidebar, and with nothing fetched to
  // argue with it that single row reads as the whole truth. The rows cannot tell
  // the two apart, so the state that produced them has to say which one it is.
  // Silence was the bug: a refresh that returned early left the same screen as a
  // refresh that found one chat.
  function threadListNotice(state = {}) {
    if (state.loaded) return null;
    if (state.blocked === "no-token") {
      return { text: "接続キーが確認できないため、チャット一覧を読み込めていません。", retry: true };
    }
    if (state.error) return { text: `チャット一覧を読み込めませんでした: ${state.error}`, retry: true };
    return { text: "チャット一覧を読み込んでいます…", retry: false };
  }

  // The two Macs already have colours their owner recognises before reading
  // anything: the mini's icon is amber, the Air's is blue. The label carries the
  // same two, so the machine registers at a glance. A machine that is neither
  // gets a stable colour from the shared palette instead, which is why this
  // answers with a name rather than a colour.
  function machineAccentToken(machine = "") {
    const key = machineScopeKey(machine);
    if (!key) return "";
    if (/(?:^|[^a-z])mini(?:[^a-z]|$)/.test(key)) return "mini";
    if (/(?:^|[^a-z])air(?:[^a-z]|$)/.test(key)) return "air";
    return "";
  }

  // How many machines the visible list actually spans. One is the normal case,
  // and naming the machine on every row there would be noise.
  function machineScopeCount(records = []) {
    const seen = new Set();
    for (const record of records || []) {
      const key = machineScopeKey(record?.machineLabel, record?.bridgeId);
      if (key) seen.add(key);
    }
    return seen.size;
  }

  // A pipe table is only a table once the row under the header says so, which
  // is what keeps a line of prose containing "|" from being eaten. The cells
  // come back as raw markdown - inline rendering belongs to the caller.
  function splitMarkdownTableRow(line) {
    const text = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let current = "";
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\" && text[index + 1] === "|") {
        current += "|";
        index += 1;
        continue;
      }
      if (char === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  function markdownTableAlignment(cell) {
    const text = String(cell || "").trim();
    if (!/^:?-{1,}:?$/.test(text)) return null;
    if (text.startsWith(":") && text.endsWith(":")) return "center";
    if (text.endsWith(":")) return "right";
    if (text.startsWith(":")) return "left";
    return "";
  }

  function isMarkdownTableStart(lines = [], index = 0) {
    const header = lines[index];
    const divider = lines[index + 1];
    if (!header || !divider || !header.includes("|") || !divider.includes("|")) return false;
    const alignments = splitMarkdownTableRow(divider).map(markdownTableAlignment);
    if (!alignments.length || alignments.some((value) => value === null)) return false;
    return splitMarkdownTableRow(header).length === alignments.length;
  }

  // iOS resumes a Home Screen app without reloading its page, so a fix that has
  // shipped stays out of reach until the app is killed by hand. The bridge names
  // the main.js it serves; when that is not the one running, the page reloads
  // itself - once per served build, and never while a turn or a draft is live.
  function knownBridgeBuild(build) {
    return build?.schema === 1 && build.available === true
      && /^[a-f0-9]{40,64}$/.test(build.head || "") && /^[a-f0-9]{64}$/.test(build.fingerprint || "")
      && typeof build.dirty === "boolean" && typeof build.restartRequired === "boolean";
  }

  function bridgeBuildIssues(build) {
    if (!knownBridgeBuild(build)) return ["アプリの版を確認できません"];
    const issues = [];
    if (build.dirty) issues.push("未共有の編集");
    if (build.restartRequired) issues.push("再起動待ち");
    const upstream = build.upstream;
    if (!upstream || !Number.isInteger(upstream.ahead) || !Number.isInteger(upstream.behind)
      || upstream.ahead < 0 || upstream.behind < 0) issues.push("共有先を確認できません");
    else {
      if (upstream.ahead > 0) issues.push("未送信の保存版");
      if (upstream.behind > 0) issues.push("取り込み待ち");
    }
    return issues;
  }

  function bridgeBuildLabel(build) {
    if (!knownBridgeBuild(build)) return "アプリの版を確認できません";
    return `アプリ ${build.head.slice(0, 7)} · ${bridgeBuildIssues(build).join(" / ") || "最終確認した共有版と一致"}`;
  }

  function bridgeBuildNotice(peers = []) {
    const messages = [];
    const known = [];
    for (const peer of peers) {
      const label = String(peer.label || "接続先");
      if (!peer.connected || !knownBridgeBuild(peer.build)) {
        messages.push(`${label}: アプリの更新状況を確認できません`);
        continue;
      }
      known.push(peer);
      const issues = bridgeBuildIssues(peer.build);
      if (issues.length) messages.push(`${label}: ${issues.join(" / ")}`);
    }
    if (new Set(known.map(peer => `${peer.build.head}:${peer.build.fingerprint}`)).size > 1) {
      messages.unshift(`${known.map(peer => peer.label || "接続先").join("・")}でアプリの版が異なります`);
    }
    return messages.join("。 ");
  }

  function shellVersionOf(href) {
    const match = /[?&]v=([^&#]+)/.exec(String(href || ""));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function shellUpdateDecision({ servedMain, ownMain, busy = false, lastReloadFor = "" } = {}) {
    const served = shellVersionOf(servedMain);
    const own = shellVersionOf(ownMain);
    if (!served || !own || served === own) return "same";
    if (lastReloadFor === served) return "skip";
    if (busy) return "wait";
    return "reload";
  }

  function parseMarkdownTable(lines = [], index = 0) {
    if (!isMarkdownTableStart(lines, index)) return null;
    const header = splitMarkdownTableRow(lines[index]);
    const align = splitMarkdownTableRow(lines[index + 1]).map(markdownTableAlignment);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes("|")) {
      const cells = splitMarkdownTableRow(lines[cursor]);
      // Ragged rows are common in generated markdown. Pad or trim to the header
      // so the table still renders instead of collapsing back into prose.
      while (cells.length < header.length) cells.push("");
      rows.push(cells.slice(0, header.length));
      cursor += 1;
    }
    return { header, align, rows, endIndex: cursor };
  }

  return {
    defaultThreadPalette,
    terminalHistoryLimit,
    safeJsonParse,
    safeJsonStringify,
    sanitizeHexColor,
    hashString,
    fallbackThreadColor,
    contrastColorFor,
    compactWorkspacePath,
    middleEllipsis,
    isMobileViewport,
    isPlaceholderBridgeLabel,
    sidebarEdgeSwipeZone,
    sidebarEdgeSwipeBlockerSelector,
    startsSidebarEdgeSwipe,
    completesSidebarEdgeSwipe,
    bridgeFleetOpenerSelector,
    clickClosesBridgeFleet,
    isStandaloneDisplayMode,
    visualViewportVars,
    effectiveAppViewportHeight,
    terminalCompactState,
    shouldShowQuickBar,
    canSuggestPwaInstall,
    serviceWorkerRegistrationAllowed,
    pwaManifestTokenIssues,
    shouldReloadInstallWithStoredToken,
    loadThreadsAfterProviderSync,
    workspaceKeyForThreadRecord,
    sameWorkspaceThreadRecord,
    isOpaqueThreadId,
    resumeCommandForThread,
    portableResumeVersion: 2,
    threadDisplayTitle,
    timestampValueMs,
    threadTimestamp,
    redactSensitiveText,
    maskToken,
    urlWithoutTokenParam,
    normalizeBridgeBaseUrl,
    bridgeIdFromBaseUrl,
    isDeviceLocalBridgeUrl,
    parseBridgeUrl,
    normalizeBridgeEntry,
    bridgeThreadKey,
    upsertBridgeRegistry,
    removeBridgeFromRegistry,
    bridgeRegistrySyncVersion,
    mergeBridgeRegistries,
    mergeBridgeTokens,
    normalizeTerminalKind,
    inferTerminalKindFromText,
    normalizeTerminalEntry,
    capTerminalHistory,
    terminalEntryMatches,
    visibleTerminalEntries,
    shouldConfirmDangerousKey,
    keyIntentText,
    deriveThreadStatus,
    sessionActivityKey,
    sessionActivityStatus,
    reconcileSessionActivity,
    visibleSessionActivity,
    acknowledgeSessionActivity,
    sortThreadsForInbox,
    limitThreadList,
    prioritizeSelectedThread,
    threadStatusFromKey,
    machineLabelFromHost,
    machineLabelForBridge,
    machineScopeKey,
    machineScopeCount,
    machineAccentToken,
    threadListNotice,
    threadProjectGroupKey,
    shortHostLabel,
    splitMarkdownTableRow,
    isMarkdownTableStart,
    parseMarkdownTable,
    shellUpdateDecision,
    bridgeBuildLabel,
    bridgeBuildNotice,
    shellVersionOf,
  };
});
