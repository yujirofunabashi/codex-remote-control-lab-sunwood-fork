const test = require("node:test");
const assert = require("node:assert/strict");

const { snapshotFromPayload } = require("./capture-claude-rate-limits");

test("normalizes Claude status line subscription windows as remaining percentages", () => {
  const snapshot = snapshotFromPayload({
    rate_limits: {
      five_hour: { used_percentage: 75 },
      seven_day: { used_percentage: 40 },
    },
  });

  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.source, "claude-statusline");
  assert.deepEqual(
    snapshot.windows.map((item) => [item.label, item.remainingPercent]),
    [
      ["5時間", 25],
      ["週あたり", 60],
    ],
  );
});

test("normalizes Claude rate limit events from stream-json output", () => {
  const snapshot = snapshotFromPayload({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.91,
    },
  });

  assert.deepEqual(
    snapshot.windows.map((item) => [item.label, item.remainingPercent]),
    [["5時間", 9]],
  );
});
