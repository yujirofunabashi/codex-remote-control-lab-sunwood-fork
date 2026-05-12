#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

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

function formatResetAt(value) {
  const numeric = numberOrNull(value);
  let date = null;
  if (numeric !== null) {
    date = new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000);
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

function labelForType(type) {
  if (type === "five_hour") return "5時間";
  if (type === "seven_day") return "週あたり";
  if (type === "seven_day_opus") return "週あたり Opus";
  if (type === "seven_day_sonnet") return "週あたり Sonnet";
  if (type === "overage") return "追加利用";
  return "制限";
}

function windowFromUsedPercent(rateLimits, type) {
  const camelType = type.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
  const item = rateLimits?.[type] || rateLimits?.[camelType];
  if (!item || typeof item !== "object") return null;
  const used = numberOrNull(item.used_percentage ?? item.usedPercentage);
  const remainingPercent = used === null ? null : clampPercent(100 - used);
  if (remainingPercent === null && !item.resets_at && !item.resetsAt) return null;
  return {
    label: labelForType(type),
    remainingPercent,
    resetsAt: formatResetAt(item.resets_at ?? item.resetsAt),
  };
}

function windowFromRateLimitInfo(info) {
  if (!info || typeof info !== "object") return null;
  const type = info.rate_limit_type || info.rateLimitType;
  const utilization = numberOrNull(info.utilization);
  const usedPercent = utilization === null ? null : utilization <= 1 ? utilization * 100 : utilization;
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent);
  if (remainingPercent === null && !info.resets_at && !info.resetsAt) return null;
  return {
    label: labelForType(type),
    remainingPercent,
    resetsAt: formatResetAt(info.resets_at ?? info.resetsAt),
  };
}

function snapshotFromPayload(payload) {
  const rateLimits = payload?.rate_limits || payload?.rateLimits;
  const windows = [];
  if (rateLimits && typeof rateLimits === "object") {
    for (const type of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]) {
      const window = windowFromUsedPercent(rateLimits, type);
      if (window) windows.push(window);
    }
  }
  const info = payload?.rate_limit_info || payload?.rateLimitInfo || payload?.data?.rate_limit_info || payload?.data?.rateLimitInfo;
  const eventWindow = windowFromRateLimitInfo(info);
  if (eventWindow) windows.push(eventWindow);
  return {
    provider: "claude",
    source: "claude-statusline",
    updatedAt: new Date().toISOString(),
    windows,
  };
}

function cachePath() {
  return path.resolve(process.env.PHONE_CLAUDE_RATE_LIMIT_CACHE_PATH || process.env.CLAUDE_RATE_LIMIT_CACHE_PATH || path.join(root, ".phone-rate-limits.claude.json"));
}

function writeCache(snapshot) {
  fs.writeFileSync(cachePath(), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(cachePath(), 0o600);
  } catch {
    // Best effort; the snapshot contains only normalized limit metadata.
  }
}

function statusText(snapshot) {
  if (!snapshot.windows.length) return "Claude limits: unavailable";
  return snapshot.windows
    .map((item) => {
      const percent = item.remainingPercent === null ? "--" : `${item.remainingPercent}%`;
      return item.resetsAt ? `${item.label} ${percent} ${item.resetsAt}` : `${item.label} ${percent}`;
    })
    .join(" | ");
}

function main() {
  try {
    const input = fs.readFileSync(0, "utf8").trim();
    if (!input) {
      process.stdout.write("Claude limits: unavailable\n");
      return;
    }
    const payload = JSON.parse(input);
    const snapshot = snapshotFromPayload(payload);
    if (snapshot.windows.length) writeCache(snapshot);
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    else process.stdout.write(`${statusText(snapshot)}\n`);
  } catch (error) {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ provider: "claude", source: "claude-statusline", windows: [], error: error.message })}\n`);
      return;
    }
    process.stdout.write("Claude limits: unavailable\n");
  }
}

if (require.main === module) main();

module.exports = { snapshotFromPayload, statusText };
