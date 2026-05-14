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

module.exports = {
  bridgeKeyForRequest,
  shouldDisposeIdleBridge,
  shouldPromoteBridgeKey,
};
