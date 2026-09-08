const fs = require("node:fs");
const path = require("node:path");

function isUnavailableHistoryError(error) {
  return /list_turns is not supported yet|no rollout found for thread id|not materialized yet/i.test(error?.message || "");
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

module.exports = { isUnavailableHistoryError, emptyCodexThreadWorkdir };
