const test = require("node:test");
const assert = require("node:assert/strict");
const { sessionActivityKey, sessionActivityStatus, reconcileSessionActivity, visibleSessionActivity, acknowledgeSessionActivity } = require("../public/phone-ui-utils");

function observation(state, options = {}) {
  return { bridgeId: "mini", machineKey: "mini", machineLabel: "mini", provider: "codex", threadId: "one", run: { state, updatedAt: 100 }, ...options };
}

test("identities include Mac, provider and conversation; two bridges on one Mac deduplicate", () => {
  const one = observation("running");
  const two = observation("running", { provider: "claude" });
  const three = observation("running", { bridgeId: "air", machineKey: "air" });
  assert.equal(new Set([one, two, three].map(sessionActivityKey)).size, 3);
  assert.equal(reconcileSessionActivity([], [one, { ...one, bridgeId: "mini-other-port" }]).length, 1);
});

test("only executing states count as processing; cancellation and lost connection are not completion", () => {
  for (const state of ["running", "streaming", "syncing", "interrupting"]) assert.equal(sessionActivityStatus({ state }), "running");
  for (const state of ["done", "question", "approval", "error", "interrupted", "offline"]) assert.notEqual(sessionActivityStatus({ state }), "running");
  assert.equal(sessionActivityStatus({ state: "running" }, { id: "approval" }), "approval");
  assert.equal(sessionActivityStatus({ state: "interrupted" }), "interrupted");
  assert.equal(sessionActivityStatus({ state: "disconnected" }), "offline");
  assert.equal(sessionActivityStatus({ state: "approval", pendingApproval: { params: { toolName: "AskUserQuestion" } } }), "question");
  assert.equal(sessionActivityStatus({ state: "approval" }, { method: "item/tool/requestUserInput" }), "question");
});

test("a disconnected duplicate cannot overwrite a live source, and new machine metadata does not duplicate a session", () => {
  const live = observation("running", { run: { state: "running", updatedAt: 200 } });
  const offline = observation("offline", { bridgeId: "other", run: { state: "offline", updatedAt: 300 } });
  for (const list of [[live, offline], [offline, live]]) assert.equal(reconcileSessionActivity([], list)[0].status, "running");
  let records = reconcileSessionActivity([], [observation("running", { machineKey: "unresolved" })]);
  records = reconcileSessionActivity(records, [live]);
  assert.equal(records.length, 1);
  assert.equal(records[0].machineKey, "mini");
});

test("completion persists through idle, missing observations and reload until acknowledged", () => {
  let records = reconcileSessionActivity([], [observation("running")]);
  records = reconcileSessionActivity(records, [observation("done")]);
  records = reconcileSessionActivity(JSON.parse(JSON.stringify(records)), [observation("ready")]);
  records = reconcileSessionActivity(records, []);
  assert.equal(visibleSessionActivity(records).length, 1);
  records = acknowledgeSessionActivity(records, records[0].key);
  records = reconcileSessionActivity(records, [observation("done")]);
  assert.equal(visibleSessionActivity(records).length, 0);
  records = reconcileSessionActivity(records, [observation("done", { run: { state: "done", updatedAt: 200 } })]);
  assert.equal(visibleSessionActivity(records).length, 1);
});

test("viewing questions, approvals and errors does not dismiss them; a new run resolves them", () => {
  for (const state of ["question", "approval", "error"]) {
    let records = reconcileSessionActivity([], [observation(state)]);
    records = acknowledgeSessionActivity(records, records[0].key);
    assert.equal(visibleSessionActivity(records)[0].status, state);
    records = reconcileSessionActivity(records, [observation("running")]);
    assert.equal(visibleSessionActivity(records)[0].status, "running");
  }
});

test("ordinals and positions remain stable when a sibling completes or polling order changes", () => {
  const one = observation("running");
  const two = observation("question", { threadId: "two" });
  let records = reconcileSessionActivity([], [one, two]);
  records = reconcileSessionActivity(records, [two, { ...one, run: { state: "done", updatedAt: 200 } }]);
  assert.deepEqual(records.map((item) => [item.threadId, item.ordinal]), [["one", 1], ["two", 2]]);
  records = acknowledgeSessionActivity(records, records[0].key);
  assert.equal(visibleSessionActivity(records)[0].ordinal, 2);
  assert.equal(reconcileSessionActivity(records, [], { bridgeIds: [] }).length, 0);
});

test("a new observed run clears acknowledgement even without a server completion timestamp", () => {
  let records = reconcileSessionActivity([], [observation("done", { run: { state: "done" } })], { now: 1 });
  records = acknowledgeSessionActivity(records, records[0].key);
  records = reconcileSessionActivity(records, [observation("running")]);
  records = reconcileSessionActivity(records, [observation("done", { run: { state: "done" } })], { now: 2 });
  assert.equal(visibleSessionActivity(records).length, 1);
});
