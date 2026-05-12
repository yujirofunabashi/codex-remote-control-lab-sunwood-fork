#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const defaultAppNames = ["Codex"];
const appNames = String(process.env.PHONE_RATE_LIMIT_DESKTOP_APP || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const defaultUsageUrl = "https://chatgpt.com/backend-api/wham/usage";

function appleScriptList(items) {
  return `{${items.map((item) => JSON.stringify(item)).join(", ")}}`;
}

function visibleAccessibilityText(targetApps) {
  const script = `
on joinLines(textItems)
  set AppleScript's text item delimiters to linefeed
  set outputText to textItems as text
  set AppleScript's text item delimiters to ""
  return outputText
end joinLines

on addText(textItems, valueText)
  try
    set cleanText to valueText as text
    if cleanText is not "" and cleanText is not "missing value" then set end of textItems to cleanText
  end try
  return textItems
end addText

on collectText(theElement)
  set collectedTexts to {}
  tell application "System Events"
    try
      set collectedTexts to my addText(collectedTexts, name of theElement)
    end try
    try
      set collectedTexts to my addText(collectedTexts, value of theElement)
    end try
    try
      set childElements to UI elements of theElement
    on error
      set childElements to {}
    end try
  end tell
  repeat with childElement in childElements
    set collectedTexts to collectedTexts & my collectText(contents of childElement)
  end repeat
  return collectedTexts
end collectText

set targetApps to ${appleScriptList(targetApps)}
set outputItems to {}
tell application "System Events"
  if UI elements enabled is false then error "Accessibility permission is disabled for System Events"
  repeat with appName in targetApps
    if exists process (appName as text) then
      tell process (appName as text)
        repeat with appWindow in windows
          set outputItems to outputItems & my collectText(contents of appWindow)
        end repeat
        repeat with appMenuBar in menu bars
          set outputItems to outputItems & my collectText(contents of appMenuBar)
        end repeat
      end tell
    end if
  end repeat
end tell
return my joinLines(outputItems)
`;
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: Number(process.env.PHONE_RATE_LIMIT_DESKTOP_TIMEOUT_MS || 5000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "osascript failed").trim());
  return result.stdout;
}

function runAppleScript(script, timeoutMs = Number(process.env.PHONE_RATE_LIMIT_DESKTOP_TIMEOUT_MS || 5000)) {
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "osascript failed").trim());
  return result.stdout;
}

function appleString(value) {
  return JSON.stringify(String(value));
}

function expandHome(input) {
  const value = String(input || "").trim();
  if (!value) return value;
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
  return value;
}

function codexAuthPath() {
  return expandHome(process.env.PHONE_RATE_LIMIT_CODEX_AUTH_PATH || "~/.codex/auth.json");
}

function readCodexAuth() {
  const filePath = codexAuthPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read Codex auth file: ${error.message}`);
  }
  const tokens = parsed?.tokens || {};
  const accessToken = tokens.access_token || parsed?.access_token || null;
  const accountId = tokens.account_id || parsed?.account_id || accountIdFromToken(accessToken);
  if (!accessToken) throw new Error("Codex auth file does not contain an access token");
  assertTokenFresh(accessToken);
  return { accessToken, accountId };
}

function jwtPayload(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function accountIdFromToken(token) {
  const auth = jwtPayload(token)?.["https://api.openai.com/auth"];
  return auth && typeof auth === "object" && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
}

function assertTokenFresh(token) {
  const exp = jwtPayload(token)?.exp;
  if (!Number.isFinite(exp)) return;
  if (exp * 1000 <= Date.now() + 30_000) {
    throw new Error("Codex auth token is expired; open Codex Desktop or run Codex to refresh it");
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function windowLabel(seconds) {
  const totalSeconds = numberOrNull(seconds);
  if (!totalSeconds || totalSeconds <= 0) return "制限";
  const minutes = totalSeconds / 60;
  if (minutes >= 10079) return "週あたり";
  if (minutes >= 1439) return `${Math.ceil(minutes / 1440)}日`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}時間`;
  return `${Math.ceil(minutes)}分`;
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatResetAt(resetAtSeconds) {
  const seconds = numberOrNull(resetAtSeconds);
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const locale = process.env.PHONE_RATE_LIMIT_LOCALE || "ja-JP";
  const now = new Date();
  if (sameLocalDay(date, now)) {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function whamWindowToRateLimit(window, labelPrefix = "") {
  if (!window || typeof window !== "object") return null;
  const usedPercent = numberOrNull(window.used_percent);
  const remainingPercent = usedPercent == null ? null : clampPercent(100 - usedPercent);
  const label = `${labelPrefix}${windowLabel(window.limit_window_seconds)}`.trim();
  const resetAt = numberOrNull(window.reset_at);
  const resetAfter = numberOrNull(window.reset_after_seconds);
  const fallbackResetAt = resetAfter == null ? null : Math.floor(Date.now() / 1000 + resetAfter);
  if (!label && remainingPercent == null && resetAt == null && fallbackResetAt == null) return null;
  return {
    label: label || "制限",
    remainingPercent,
    resetsAt: formatResetAt(resetAt ?? fallbackResetAt),
  };
}

function whamRateLimitWindows(rateLimit, labelPrefix = "") {
  return [
    whamWindowToRateLimit(rateLimit?.primary_window, labelPrefix),
    whamWindowToRateLimit(rateLimit?.secondary_window, labelPrefix),
  ].filter(Boolean);
}

function normalizeWhamUsage(data) {
  const windows = whamRateLimitWindows(data?.rate_limit);
  if (process.env.PHONE_RATE_LIMIT_INCLUDE_ADDITIONAL === "1" && Array.isArray(data?.additional_rate_limits)) {
    for (const limit of data.additional_rate_limits) {
      const name = String(limit?.limit_name || "").trim();
      if (!name || !limit?.rate_limit) continue;
      windows.push(...whamRateLimitWindows(limit.rate_limit, `${name} `));
    }
  }
  return windows;
}

async function codexUsageSnapshot() {
  const { accessToken, accountId } = readCodexAuth();
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "Codex Remote Rate Limit Reader",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const response = await fetch(process.env.PHONE_RATE_LIMIT_USAGE_URL || defaultUsageUrl, { headers });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error || response.statusText || "request failed";
    throw new Error(`Codex usage request failed with ${response.status}: ${detail}`);
  }
  if (!payload || typeof payload !== "object") throw new Error("Codex usage request returned no JSON payload");
  const windows = normalizeWhamUsage(payload);
  if (!windows.length) throw new Error("Codex usage payload contained no rate-limit windows");
  return {
    source: "codex-auth",
    updatedAt: new Date().toISOString(),
    windows,
  };
}

function chromeChatGptText() {
  const clickProfileMenuJs = `
(() => {
  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const textFor = (element) => [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-testid"),
    element.innerText,
  ].filter(Boolean).join(" ").trim();
  const candidates = Array.from(document.querySelectorAll("button,[role='button'],a,[data-testid]")).filter(visible);
  const menuButton = candidates.find((element) => /profile|account|avatar|user|プロフィール|アカウント/i.test(textFor(element)))
    || candidates.find((element) => /profile|account|user/i.test(String(element.outerHTML).slice(0, 1200)));
  if (!menuButton) return "no-profile-button";
  menuButton.click();
  return "clicked";
})()
`;
  const readTextJs = "document.body.innerText";
  const script = `
tell application "Google Chrome"
  repeat with appWindow in windows
    repeat with tabIndex from 1 to count of tabs of appWindow
      set appTab to tab tabIndex of appWindow
      if (URL of appTab as text) contains "chatgpt.com" then
        set active tab index of appWindow to tabIndex
        execute appTab javascript ${appleString(clickProfileMenuJs)}
        delay 0.8
        return execute appTab javascript ${appleString(readTextJs)}
      end if
    end repeat
  end repeat
end tell
error "No open chatgpt.com tab found in Google Chrome"
`;
  try {
    return runAppleScript(script, Number(process.env.PHONE_RATE_LIMIT_CHROME_TIMEOUT_MS || 5000));
  } catch (error) {
    if (/JavaScript.*Apple Events|Apple Events.*JavaScript|JavaScript の実行がオフ/i.test(error.message)) {
      throw new Error(
        "Google Chrome blocks JavaScript from Apple Events. Enable View > Developer > Allow JavaScript from Apple Events, or use the desktop Accessibility source.",
      );
    }
    throw error;
  }
}

function cleanLine(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRateLimitLabel(line) {
  return /(5\s*時間|5\s*h|週|week|weekly|週あたり|週当たり|制限)/i.test(line);
}

function looksLikeReset(line) {
  return /(\d{1,2}:\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|[A-Z][a-z]{2,8}\s+\d{1,2})/.test(line);
}

function labelNear(lines, index, fallback) {
  for (let offset = 1; offset <= 5; offset += 1) {
    const candidate = lines[index - offset];
    if (!candidate || /%|残り|rate|limit/i.test(candidate)) continue;
    if (isRateLimitLabel(candidate)) return candidate;
  }
  return fallback;
}

function resetNear(lines, index, inlineReset) {
  if (inlineReset && looksLikeReset(inlineReset)) return inlineReset.trim();
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = lines[index + offset];
    if (candidate && looksLikeReset(candidate)) return candidate;
  }
  return inlineReset.trim();
}

function parseRateLimits(text) {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const windows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/(\d{1,3})\s*%\s*(.*)$/);
    if (!match) continue;
    const remainingPercent = Number(match[1]);
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) continue;
    const fallback = windows.length === 0 ? "5時間" : "週あたり";
    windows.push({
      label: labelNear(lines, index, fallback),
      remainingPercent,
      resetsAt: resetNear(lines, index, match[2] || ""),
    });
    if (windows.length >= 2) break;
  }
  return windows;
}

async function main() {
  const targetApps = appNames.length ? appNames : defaultAppNames;
  const source = String(process.env.PHONE_RATE_LIMIT_SOURCE || "auto").trim().toLowerCase();
  let text = "";
  let sourceUsed = "desktop-ui";
  const errors = [];
  if (source === "auto" || source === "codex" || source === "codex-auth") {
    try {
      process.stdout.write(`${JSON.stringify(await codexUsageSnapshot())}\n`);
      return;
    } catch (error) {
      errors.push(`codex: ${error.message}`);
      if (source === "codex" || source === "codex-auth") throw error;
    }
  }
  if (source === "auto" || source === "desktop") {
    try {
      text = visibleAccessibilityText(targetApps);
      if (parseRateLimits(text).length) sourceUsed = "desktop-ui";
    } catch (error) {
      errors.push(`desktop: ${error.message}`);
    }
  }
  if (!parseRateLimits(text).length && (source === "auto" || source === "chrome")) {
    try {
      text = chromeChatGptText();
      sourceUsed = "chrome-dom";
    } catch (error) {
      errors.push(`chrome: ${error.message}`);
    }
  }
  const windows = parseRateLimits(text);
  if (!windows.length) {
    const detail = errors.length ? ` (${errors.join("; ")})` : "";
    throw new Error(`No visible rate-limit text found${detail}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      source: sourceUsed,
      updatedAt: new Date().toISOString(),
      windows,
    })}\n`,
  );
}

try {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
