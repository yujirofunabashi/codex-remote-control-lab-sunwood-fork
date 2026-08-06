// Debug instrumentation for the phone bridge.
//
// A stalled turn or a message that never reaches the phone is expensive to
// chase interactively: every question costs a round trip and carries back one
// slice of state. This writes the state to a file instead, so a single failing
// run answers what a dozen exchanges would have.
//
// Off unless `PHONE_DEBUG` is set. Output is one JSON object per line, so the
// log stays greppable and machine-readable. Every value passes through the
// same redaction the terminal history uses - a debug file is still a file, and
// it lives next to a repository that is meant to stay public-safe.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const defaultLogPath = path.join(root, ".phone-debug.log");
const defaultMaxBytes = 5 * 1024 * 1024;

const maxStringLength = 800;
const maxArrayItems = 20;
const maxDepth = 4;

const writtenBytes = new Map();
let sequence = 0;

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/([?&](?:token|key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(PHONE_TOKEN=)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/\b(token:\s*)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
}

function isDebugEnabled() {
  const raw = String(process.env.PHONE_DEBUG || "").trim().toLowerCase();
  return Boolean(raw) && raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

function debugLogPath() {
  return process.env.PHONE_DEBUG_FILE || defaultLogPath;
}

function debugMaxBytes() {
  const raw = Number(process.env.PHONE_DEBUG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMaxBytes;
}

function truncateString(value) {
  const text = redactSensitiveText(value);
  if (text.length <= maxStringLength) return text;
  return `${text.slice(0, maxStringLength)}…[+${text.length - maxStringLength} chars]`;
}

// Long transcripts and tool payloads are the whole reason this file exists, but
// a log entry nobody can read is no better than no entry. Cap width and depth
// and say so in the output rather than dropping the field silently.
function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (value instanceof Error) {
    return { name: value.name, message: truncateString(value.message), stack: truncateString(value.stack || "") };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (depth >= maxDepth) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > maxArrayItems) items.push(`[+${value.length - maxArrayItems} more]`);
    return items;
  }
  if (value instanceof Map) return sanitizeValue(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return sanitizeValue([...value], depth + 1);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeValue(item, depth + 1);
    return out;
  }
  return String(value);
}

// One rolled generation is enough. The interesting window is almost always the
// most recent run, and an unbounded log on a machine that stays up for days
// costs more than it explains.
function rotateIfNeeded(filePath, incomingBytes) {
  const limit = debugMaxBytes();
  let current = writtenBytes.get(filePath);
  if (current === undefined) {
    try {
      current = fs.statSync(filePath).size;
    } catch {
      current = 0;
    }
  }
  if (current + incomingBytes > limit && current > 0) {
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      // A rename that fails leaves the log growing, which beats losing writes.
    }
    current = 0;
  }
  writtenBytes.set(filePath, current + incomingBytes);
}

function debugLog(event, fields = {}) {
  if (!isDebugEnabled()) return false;
  try {
    const entry = {
      ts: new Date().toISOString(),
      seq: (sequence += 1),
      pid: process.pid,
      event: String(event || "unknown"),
      ...sanitizeValue(fields, 0),
    };
    const line = `${JSON.stringify(entry)}\n`;
    const filePath = debugLogPath();
    rotateIfNeeded(filePath, Buffer.byteLength(line));
    fs.appendFileSync(filePath, line);
    return true;
  } catch {
    // Instrumentation must never take the bridge down with it.
    return false;
  }
}

// Wall-clock around a step, recorded only when the step ends. Returns a
// function so the call site reads as one statement at each end.
function debugTimer(event, fields = {}) {
  if (!isDebugEnabled()) return () => false;
  const startedAt = Date.now();
  return (extra = {}) => debugLog(event, { ...fields, ...extra, durationMs: Date.now() - startedAt });
}

function resetDebugLogState() {
  writtenBytes.clear();
  sequence = 0;
}

module.exports = {
  debugLog,
  debugLogPath,
  debugTimer,
  isDebugEnabled,
  redactSensitiveText,
  resetDebugLogState,
};
