const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";

const { normalizeClaudeRateLimitPayload } = require("./start-phone");

// Captured from a real `claude -p --output-format stream-json` run. Note what is
// absent: there is no utilization field, so no percentage can be derived here.
const liveEvent = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1785870000,
    rateLimitType: "five_hour",
    overageStatus: "allowed",
    overageResetsAt: 1785862800,
    isUsingOverage: false,
  },
};

test("a live event yields the window and its reset time", () => {
  const snapshot = normalizeClaudeRateLimitPayload(liveEvent, "claude-rate-limit-event");

  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].label, "5時間");
  assert.ok(snapshot.windows[0].resetsAt, "the reset time is the useful part of a live event");
});

test("a live event cannot invent a percentage", () => {
  const snapshot = normalizeClaudeRateLimitPayload(liveEvent, "claude-rate-limit-event");

  // Reporting a number here would be a fabrication; the field carrying it is
  // simply not in the event.
  assert.equal(snapshot.windows[0].remainingPercent, null);
});

test("overage is surfaced rather than discarded", () => {
  const snapshot = normalizeClaudeRateLimitPayload(
    { rate_limit_info: { ...liveEvent.rate_limit_info, isUsingOverage: true } },
    "claude-rate-limit-event",
  );

  assert.equal(snapshot.windows[0].label, "5時間（追加利用中）");
});

test("a status other than allowed is surfaced", () => {
  const snapshot = normalizeClaudeRateLimitPayload(
    { rate_limit_info: { ...liveEvent.rate_limit_info, status: "rejected" } },
    "claude-rate-limit-event",
  );

  assert.equal(snapshot.windows[0].label, "5時間（rejected）");
});

test("overage takes precedence over a plain status", () => {
  const snapshot = normalizeClaudeRateLimitPayload(
    { rate_limit_info: { ...liveEvent.rate_limit_info, status: "rejected", isUsingOverage: true } },
    "claude-rate-limit-event",
  );

  assert.equal(snapshot.windows[0].label, "5時間（追加利用中）");
});

test("the statusLine payload is where percentages come from", () => {
  const snapshot = normalizeClaudeRateLimitPayload(
    {
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 1785870000 },
        seven_day: { used_percentage: 12.4, resets_at: 1786000000 },
      },
    },
    "claude-statusline",
  );

  const byLabel = Object.fromEntries(snapshot.windows.map((item) => [item.label, item]));
  assert.equal(byLabel["5時間"].remainingPercent, 60);
  assert.equal(byLabel["週あたり"].remainingPercent, 88);
});

test("a payload with neither source yields no windows rather than empty ones", () => {
  const snapshot = normalizeClaudeRateLimitPayload({}, "claude");
  assert.deepEqual(snapshot.windows, []);
});
