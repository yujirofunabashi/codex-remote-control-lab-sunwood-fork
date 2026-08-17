const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PHONE_AGENT_PROVIDER = "claude";

const { claudeStallVerdict } = require("./start-phone");

const WARN_MS = 90 * 1000;
const KILL_MS = 5 * 60 * 1000;

function verdictAfter(silentMs, extra = {}) {
  return claudeStallVerdict({
    now: 1_000_000 + silentMs,
    lastOutputAt: 1_000_000,
    warnMs: WARN_MS,
    killMs: KILL_MS,
    ...extra,
  });
}

test("a turn that is still emitting is left alone", () => {
  const verdict = verdictAfter(20 * 1000);

  assert.equal(verdict.action, "none");
  assert.equal(verdict.silentMs, 20 * 1000);
});

test("silence past the warning threshold is said out loud, once", () => {
  assert.equal(verdictAfter(WARN_MS).action, "warn");
  assert.equal(verdictAfter(WARN_MS + 60 * 1000, { warned: true }).action, "none");
});

test("silence past the kill threshold ends the turn", () => {
  const verdict = verdictAfter(KILL_MS, { warned: true });

  assert.equal(verdict.action, "kill");
  assert.equal(verdict.toolInFlight, false);
});

// The failure this guards against is the opposite of the bug: a suite that runs
// for twenty minutes is silent and healthy, and killing it would be worse than
// the stall ever was.
test("a turn waiting on a tool is never killed for waiting", () => {
  const verdict = verdictAfter(KILL_MS * 4, { pendingToolCount: 1, warned: true });

  assert.equal(verdict.action, "none");
  assert.equal(verdict.toolInFlight, true);
});

test("a long-running tool still gets one honest note about the wait", () => {
  const verdict = verdictAfter(WARN_MS, { pendingToolCount: 2 });

  assert.equal(verdict.action, "warn");
  assert.equal(verdict.toolInFlight, true);
});

test("a returned tool result puts the turn back under the kill threshold", () => {
  const waiting = verdictAfter(KILL_MS, { pendingToolCount: 1, warned: true });
  const answered = verdictAfter(KILL_MS, { pendingToolCount: 0, warned: true });

  assert.equal(waiting.action, "none");
  assert.equal(answered.action, "kill");
});

test("zero turns a single stage off without turning the other off with it", () => {
  assert.equal(verdictAfter(KILL_MS, { killMs: 0, warned: true }).action, "none");
  assert.equal(verdictAfter(KILL_MS, { killMs: 0 }).action, "warn");
  assert.equal(verdictAfter(WARN_MS, { warnMs: 0 }).action, "none");
  assert.equal(verdictAfter(KILL_MS, { warnMs: 0 }).action, "kill");
});

test("a clock that jumps backwards cannot manufacture a stall", () => {
  const verdict = claudeStallVerdict({
    now: 1_000_000,
    lastOutputAt: 1_500_000,
    warnMs: WARN_MS,
    killMs: KILL_MS,
  });

  assert.equal(verdict.action, "none");
  assert.equal(verdict.silentMs, 0);
});
