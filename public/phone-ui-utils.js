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

  function redactSensitiveText(value) {
    return String(value || "")
      .replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]")
      .replace(/\b(PHONE_TOKEN=)[^\s]+/gi, "$1[redacted]")
      .replace(/\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
      .replace(/\b(token:\s*)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
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
    redactSensitiveText,
    normalizeTerminalKind,
    inferTerminalKindFromText,
    normalizeTerminalEntry,
    capTerminalHistory,
    terminalEntryMatches,
    visibleTerminalEntries,
    shouldConfirmDangerousKey,
    keyIntentText,
  };
});
