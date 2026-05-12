function bridgeKeyForRequest(threadId, connectionId) {
  if (threadId) return threadId;
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
