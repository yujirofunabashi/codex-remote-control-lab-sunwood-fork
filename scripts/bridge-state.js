function bridgeKeyForRequest(threadId, connectionId, options = {}) {
  if (threadId) return threadId;
  if (options.fresh) return `new:${connectionId || "fresh"}`;
  return "new:shared";
}

function shouldDisposeIdleBridge({ clientCount, active = false }) {
  return clientCount === 0 && !active;
}

function shouldPromoteBridgeKey({ bridgeKey, threadId }) {
  return Boolean(threadId && bridgeKey && bridgeKey !== threadId && bridgeKey.startsWith("new:"));
}

function normalizeWorkdirKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function bridgeMatchesWorkdir({ bridgeWorkdir, targetWorkdir }) {
  const target = normalizeWorkdirKey(targetWorkdir);
  if (!target) return true;
  return normalizeWorkdirKey(bridgeWorkdir) === target;
}

function shouldReplaceBridgeForWorkdir({ bridgeWorkdir, targetWorkdir, active = false }) {
  return Boolean(normalizeWorkdirKey(targetWorkdir) && !active && !bridgeMatchesWorkdir({ bridgeWorkdir, targetWorkdir }));
}

module.exports = {
  bridgeKeyForRequest,
  bridgeMatchesWorkdir,
  normalizeWorkdirKey,
  shouldDisposeIdleBridge,
  shouldPromoteBridgeKey,
  shouldReplaceBridgeForWorkdir,
};
