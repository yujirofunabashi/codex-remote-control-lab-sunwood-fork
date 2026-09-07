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

test("a terminal-started turn can be interrupted and queued behind from the phone", () => {
  const own = bridge("shared", null);
  own.turnQueue = [];
  own.ready = true;
  const sent = [];
  own.request = (method, params) => { sent.push({ method, params }); return 1; };
  deliver(own, { method: "turn/started", params: { threadId: "shared", turn: { id: "terminal-turn" } } });
  assert.equal(own.activeTurnId, "terminal-turn");
  assert.equal(own.runState.state, "running");
  own.prompt("next from phone");
  assert.equal(own.turnQueue.length, 1);
  own.interrupt();
  assert.deepEqual(sent, [{ method: "turn/interrupt", params: { threadId: "shared", turnId: "terminal-turn" } }]);
});

test("terminal user input appears once on the phone, including repeated text in later turns", () => {
  const own = bridge("shared", null);
  for (const id of ["one", "two"]) {
    deliver(own, { method: "turn/started", params: { threadId: "shared", turn: { id } } });
    const params = { threadId: "shared", turnId: id, item: { type: "userMessage", id: `input-${id}`, content: [{ type: "text", text: "continue" }] } };
    deliver(own, { method: "item/started", params });
    deliver(own, { method: "item/completed", params });
  }
  assert.deepEqual(own.history.map((entry) => entry.text), ["continue", "continue"]);
  assert.equal(own.events.filter((event) => event.type === "user").length, 2);
});

test("the phone's immediate user echo is not duplicated by shared server events", () => {
  const own = bridge("shared", null);
  own.request = () => 42;
  own.startPrompt("from phone");
  deliver(own, { id: 42, result: { turn: { id: "phone-turn" } } });
  const params = { threadId: "shared", turnId: "phone-turn", item: { type: "userMessage", id: "phone-input", content: [{ type: "text", text: "from phone" }] } };
  deliver(own, { method: "item/started", params });
  deliver(own, { method: "item/completed", params });
  assert.equal(own.history.filter((entry) => entry.type === "user").length, 1);
  assert.equal(own.events.filter((event) => event.type === "user").length, 1);
});

test("a delayed turn/start reply cannot reset an already streaming turn", () => {
  const own = bridge("shared", null);
  own.pending.set(42, "turn/start");
  deliver(own, { method: "turn/started", params: { threadId: "shared", turn: { id: "turn-1" } } });
  deliver(own, { method: "item/agentMessage/delta", params: { threadId: "shared", turnId: "turn-1", delta: "partial" } });
  deliver(own, { id: 42, result: { turn: { id: "turn-1" } } });
  assert.equal(own.turnStarted, true);
  assert.equal(own.streamingStarted, true);
  assert.equal(own.runState.state, "streaming");
  assert.equal(own.events.filter((event) => event.type === "turn" && event.status === "started").length, 1);
});

test("reopening the phone during terminal work restores the active turn", () => {
  const own = bridge("shared", null);
  own.promoteBridgeKey = () => {};
  own.readyPayload = () => ({ run: own.runPayload() });
  own.pending.set(7, "thread/resume");
  deliver(own, { id: 7, result: { thread: { id: "shared", turns: [{ id: "terminal-turn", status: "inProgress",
    items: [{ type: "agentMessage", id: "partial", text: "Partial " }] }] } } });
  assert.equal(own.activeTurnId, "terminal-turn");
  assert.equal(own.turnStarted, true);
  assert.equal(own.history[0].text, "Partial ");
  assert.equal(own.events.find((event) => event.type === "ready").run.state, "running");
});

test("joining a terminal's conversation preserves its model and permission choices", () => {
  const own = bridge("shared", null);
  const requests = [];
  own.request = (method, params) => { requests.push({ method, params }); return requests.length; };
  own.upstream.send = () => {};
  own.upstream.emit("open");
  assert.deepEqual(requests.find((request) => request.method === "thread/resume").params,
    { threadId: "shared", cwd: own.workdir });
});

test("an approval answered on the terminal disappears from the phone", () => {
  const own = bridge("shared");
  const approval = messages("shared").find((message) => message.id === 101);
  deliver(own, approval);
  deliver(own, { method: "serverRequest/resolved", params: { threadId: "foreign", requestId: 101 } });
  assert.deepEqual(own.pendingApproval, approval);
  deliver(own, { method: "serverRequest/resolved", params: { threadId: "shared", requestId: 102 } });
  assert.deepEqual(own.pendingApproval, approval);
  deliver(own, { method: "serverRequest/resolved", params: { threadId: "shared", requestId: 101 } });
  assert.equal(own.pendingApproval, null);
  assert.equal(own.runPayload().state, "running");
});
