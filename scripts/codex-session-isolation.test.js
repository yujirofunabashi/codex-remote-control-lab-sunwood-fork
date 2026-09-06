const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const os = require("node:os");

// No real server, phone, or notification channel participates in these tests.
// Loading start-phone may read local settings, so also block outbound fetches.
globalThis.fetch = async () => ({ ok: true, status: 204, text: async () => "" });
process.env.PHONE_NOTIFY_EVENTS = "0";
const { SharedBridge } = require("./start-phone");
for (const key of Object.keys(process.env)) {
  if (/^PHONE_(NOTIFY|NTFY|PUSHOVER|DISCORD)_/.test(key)) process.env[key] = "";
}

function bridge(threadId, turnId = "own-turn") {
  const instance = Object.create(SharedBridge.prototype);
  Object.assign(instance, {
    provider: "codex", model: "test", workdir: os.tmpdir(),
    threadId, requestedThreadId: threadId, activeTurnId: turnId,
    upstream: new EventEmitter(), pending: new Map(), clients: new Set(),
    history: [], runState: { state: "running", turnId },
    streamingStarted: false, turnStarted: false, interruptRequested: false,
    events: [], queuedStarts: 0,
    emit(type, payload) { this.events.push({ type, ...payload }); },
    flushPendingInterrupt() {}, syncHistory() {}, scheduleIdleDispose() {},
    startNextQueuedTurn() { this.queuedStarts += 1; },
  });
  instance.bindUpstream();
  return instance;
}

function deliver(instance, message) {
  instance.upstream.emit("message", Buffer.from(JSON.stringify(message)));
}

function messages(threadId) {
  const params = { threadId, turnId: "other-turn" };
  return [
    { method: "turn/started", params: { ...params, turn: { id: "other-turn" } } },
    { method: "item/agentMessage/delta", params: { ...params, delta: "other answer" } },
    { method: "item/started", params: { ...params, item: { type: "commandExecution", command: "other-command" } } },
    { method: "item/completed", params: { ...params, item: { type: "agentMessage", text: "other answer" } } },
    { method: "turn/completed", params: { ...params, turn: { id: "other-turn", status: "completed" } } },
    { id: 101, method: "item/commandExecution/requestApproval", params: { ...params, command: ["other-command"] } },
    { method: "error", params: { ...params, message: "other failure" } },
  ];
}

for (const source of ["other-project", "helper-of-other-project", undefined]) {
  test(`thread events from ${source || "an unknown thread"} cannot enter another session`, () => {
    for (const message of messages(source)) {
      const own = bridge("own-project");
      deliver(own, message);
      assert.deepEqual(own.events, [], message.method);
      assert.deepEqual(own.history, [], message.method);
      assert.equal(own.activeTurnId, "own-turn", message.method);
      assert.equal(own.runState.state, "running", message.method);
      assert.equal(own.pendingApproval, undefined, message.method);
      assert.equal(own.queuedStarts, 0, message.method);
      assert.equal(own.turnStarted, false, message.method);
    }
  });
}

test("two sessions receive only their own replies and completion", () => {
  const a = bridge("project-a", "turn-a");
  const b = bridge("project-b", "turn-b");
  const broadcast = (message) => { deliver(a, message); deliver(b, message); };
  for (const id of ["project-a", "project-b"]) {
    broadcast({ method: "item/agentMessage/delta", params: { threadId: id, delta: id } });
    broadcast({ method: "item/completed", params: { threadId: id, item: { type: "agentMessage", text: id } } });
  }
  broadcast({ method: "turn/completed", params: { threadId: "project-b", turn: { id: "turn-b", status: "completed" } } });
  assert.deepEqual(a.history.map((entry) => entry.text), ["project-a"]);
  assert.deepEqual(b.history.map((entry) => entry.text), ["project-b"]);
  assert.equal(a.activeTurnId, "turn-a");
  assert.equal(b.activeTurnId, null);
  assert.equal(a.queuedStarts, 0);
  assert.equal(b.queuedStarts, 1);
});

test("nested and legacy thread identifiers are checked, including before resume is ready", () => {
  const own = bridge("own-project");
  own.threadId = null;
  for (const params of [{ thread: { id: "foreign" } }, { thread_id: "foreign" }, { conversationId: "foreign" }]) {
    deliver(own, { method: "thread/started", params });
  }
  assert.deepEqual(own.events, []);
  deliver(own, { method: "thread/started", params: { thread: { id: "own-project" } } });
  assert.equal(own.events.at(-1).event.params.thread.id, "own-project");
  own.events = [];
  deliver(own, { method: "item/agentMessage/delta", params: { threadId: "own-project", conversationId: "foreign", delta: "foreign" } });
  assert.deepEqual(own.events, [], "conflicting scope identifiers are not accepted");
});

test("outbound session updates carry their conversation id", () => {
  const own = bridge("own-project");
  own.terminalHistory = [];
  const sent = [];
  own.clients.add({ readyState: 1, send: (body) => sent.push(JSON.parse(body)) });
  SharedBridge.prototype.emit.call(own, "assistantDelta", { text: "own reply" });
  assert.equal(sent[0].threadId, "own-project");
});

test("a server approval request cannot consume a pending client response with the same id", () => {
  const own = bridge("own-project");
  own.pending.set(101, "turn/start");
  const approval = messages("own-project").find((message) => message.id === 101);
  deliver(own, approval);
  assert.equal(own.pending.get(101), "turn/start");
  assert.deepEqual(own.pendingApproval, approval);
});

test("a correlated response and global account event still reach their own connection", () => {
  const own = bridge("own-project");
  own.pending.set(7, "turn/interrupt");
  deliver(own, { id: 7, result: {} });
  assert.equal(own.pending.has(7), false);
  assert.equal(own.runState.state, "interrupting");
  deliver(own, { method: "account/rateLimits/updated", params: { rateLimits: {} } });
  assert.equal(own.events.at(-1).event.method, "account/rateLimits/updated");
});

test("approval decisions must match the pending request and its thread, even when ids collide", () => {
  const own = bridge("own-project");
  const sent = [];
  own.upstream.send = (body) => sent.push(JSON.parse(body));
  const approval = messages("own-project").find((message) => message.id === 101);
  deliver(own, approval);
  own.approval({ ...approval, params: { ...approval.params, threadId: "other-project" } }, "accept");
  own.approval({ ...approval, id: 102 }, "accept");
  assert.deepEqual(sent, []);
  own.approval(approval, "accept");
  assert.deepEqual(sent, [{ id: 101, result: { decision: "accept" } }]);
  own.approval(approval, "accept");
  assert.equal(sent.length, 1, "an already answered request cannot be reused");
});
