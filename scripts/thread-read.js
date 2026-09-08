const { isUnavailableHistoryError, emptyCodexThreadWorkdir } = require("./codex-empty-thread");

function liveBridgeSnapshot(bridge, threadId) {
  if (!bridge) return null;
  const matchesThread = bridge.threadId === threadId || bridge.requestedThreadId === threadId;
  if (!matchesThread) return null;
  if (!bridge.ready && bridge.startupFailed) return null;
  return {
    threadId,
    ready: !!bridge.ready,
    history: Array.isArray(bridge.history) ? bridge.history : [],
    source: "live-bridge",
  };
}

function normalizeWorkdirKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function bridgeMatchesWorkdir(bridge, targetWorkdir = "") {
  const target = normalizeWorkdirKey(targetWorkdir);
  if (!target) return true;
  return normalizeWorkdirKey(bridge?.workdir || "") === target;
}

function findLiveBridge(bridges, threadId, options = {}) {
  if (!bridges || !threadId) return null;
  const direct = bridges.get?.(threadId);
  if (direct && bridgeMatchesWorkdir(direct, options.workdir)) return direct;
  for (const bridge of bridges.values?.() || []) {
    if ((bridge.threadId === threadId || bridge.requestedThreadId === threadId) && bridgeMatchesWorkdir(bridge, options.workdir)) return bridge;
  }
  return null;
}

async function readThreadSnapshot({ threadId, liveBridge, request, historyFromThread }) {
  const liveSnapshot = liveBridgeSnapshot(liveBridge, threadId);
  if (liveSnapshot) return liveSnapshot;

  let thread;
  try {
    const result = await request("thread/read", {
      threadId,
      includeTurns: true,
    });
    thread = result.thread || result;
  } catch (readError) {
    // A GET must never resume a thread with this bridge's default folder or
    // overwrite its model/permissions. Inspect only verified empty records.
    if (!isUnavailableHistoryError(readError)) throw readError;
    try {
      const result = await request("thread/read", { threadId, includeTurns: false });
      const metadata = result.thread || result;
      if (metadata.id === threadId && emptyCodexThreadWorkdir(metadata)) {
        return { threadId, history: [], empty: true, source: "empty-thread" };
      }
    } catch { /* Keep the original history error; no recovery has been proven. */ }
    throw readError;
  }

  return {
    threadId: thread.id || threadId,
    history: historyFromThread(thread),
    source: "app-server",
  };
}

module.exports = {
  findLiveBridge,
  liveBridgeSnapshot,
  readThreadSnapshot,
};
