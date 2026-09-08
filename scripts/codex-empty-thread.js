const fs = require("node:fs");
const path = require("node:path");

function isUnavailableHistoryError(error) {
  return /list_turns is not supported yet|no rollout found for thread id|not materialized yet/i.test(error?.message || "");
}

// Creating a thread can return a path before Codex has written anything there.
// Inspect its own header, never invent a transcript or send a synthetic turn.
function hasSavedCodexThread(thread) {
  if (!thread?.id || thread.ephemeral || !path.isAbsolute(thread.path || "")) return false;
  let descriptor;
  try {
    if (!fs.lstatSync(thread.path).isFile()) return false;
    descriptor = fs.openSync(thread.path, "r");
    const buffer = Buffer.alloc(512 * 1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0);
    if (!bytes || newline < 0 || newline >= bytes) return false;
    const row = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    return row.type === "session_meta" && row.payload?.id === thread.id
      && path.isAbsolute(row.payload?.cwd || "");
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

// A failed history request is not proof that a conversation is empty. Only
// accept a local, complete transcript consisting of its matching header alone.
// In particular, never replace a fork, a partial/unreadable file or real work.
function emptyCodexThreadWorkdir(thread) {
  if (!thread?.id || thread.ephemeral || thread.preview || !["idle", "notLoaded"].includes(thread.status?.type)) return "";
  if (!path.isAbsolute(thread.path || "")) return "";
  try {
    const stat = fs.lstatSync(thread.path);
    if (!stat.isFile() || stat.size === 0 || stat.size > 512 * 1024) return "";
    const lines = fs.readFileSync(thread.path, "utf8").trim().split(/\r?\n/);
    if (lines.length !== 1) return "";
    const row = JSON.parse(lines[0]);
    const meta = row.payload;
    if (row.type !== "session_meta" || meta?.id !== thread.id || meta.forked_from_id
      || meta.forked_from || typeof meta.source !== "string" || !path.isAbsolute(meta.cwd || "")) return "";
    return meta.cwd;
  } catch { return ""; }
}

module.exports = { isUnavailableHistoryError, emptyCodexThreadWorkdir, hasSavedCodexThread };
