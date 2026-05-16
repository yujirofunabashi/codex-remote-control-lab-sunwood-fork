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

  function workspaceKeyForThreadRecord(thread = {}, fallback = "") {
    const raw = thread.cwd || thread.workspaceLocation || thread.workdir || fallback || "";
    return String(raw).trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function sameWorkspaceThreadRecord(thread = {}, baseKey = "") {
    const normalizedBase = String(baseKey || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const candidate = workspaceKeyForThreadRecord(thread);
    if (!normalizedBase || !candidate) return true;
    return candidate === normalizedBase;
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
    return { ...registry, version: 1, bridges: next };
  }

  function removeBridgeFromRegistry(registry = {}, bridgeId = "") {
    const current = Array.isArray(registry.bridges) ? registry.bridges : [];
    return { ...registry, version: 1, bridges: current.filter((bridge) => bridge.id !== bridgeId) };
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
    done: { key: "done", label: "", tone: "done", group: "recent", priority: 10 },
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
      return threadTimestamp(b) - threadTimestamp(a);
    });
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
    isStandaloneDisplayMode,
    visualViewportVars,
    effectiveAppViewportHeight,
    terminalCompactState,
    shouldShowQuickBar,
    canSuggestPwaInstall,
    serviceWorkerRegistrationAllowed,
    pwaManifestTokenIssues,
    workspaceKeyForThreadRecord,
    sameWorkspaceThreadRecord,
    timestampValueMs,
    threadTimestamp,
    redactSensitiveText,
    maskToken,
    urlWithoutTokenParam,
    normalizeBridgeBaseUrl,
    bridgeIdFromBaseUrl,
    parseBridgeUrl,
    normalizeBridgeEntry,
    bridgeThreadKey,
    upsertBridgeRegistry,
    removeBridgeFromRegistry,
    normalizeTerminalKind,
    inferTerminalKindFromText,
    normalizeTerminalEntry,
    capTerminalHistory,
    terminalEntryMatches,
    visibleTerminalEntries,
    shouldConfirmDangerousKey,
    keyIntentText,
    deriveThreadStatus,
    sortThreadsForInbox,
    threadStatusFromKey,
  };
});
