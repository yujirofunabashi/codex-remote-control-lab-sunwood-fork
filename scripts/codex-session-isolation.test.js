const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { sessionActivityStatus } = require("../public/phone-ui-utils");

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

for (const [text, expected] of [
  ["実装が完了しました。質問・許可待ちは?、エラーは!で表示します。", "done"],
  ["実装が完了しました。画面で確認してください。", "done"],
  ["作業先はminiとAirのどちらにしますか？", "question"],
  ["希望する端末名を返信してください。", "question"],
]) {
  test(`completion and reopening deliver ${expected} for: ${text}`, (t) => {
    const own = bridge("reply-state", "current-turn");
    deliver(own, { method: "item/completed", params: { threadId: "reply-state", turnId: "current-turn", item: { type: "agentMessage", text } } });
    deliver(own, { method: "turn/completed", params: { threadId: "reply-state", turn: { id: "current-turn", status: "completed" } } });
    const completed = own.events.find((event) => event.type === "turn" && event.status === "completed");
    assert.equal(completed.run.state, expected);
    assert.equal(sessionActivityStatus(completed.run), expected);

    // The authoritative session file says the turn stopped executing, not
    // whether its answer asks the owner to reply. Restoring it must agree.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reply-state-"));
    t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
    const sessionPath = path.join(fixtureDir, "session.jsonl");
    fs.writeFileSync(sessionPath, JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "task_complete", turn_id: "current-turn" } }) + "\n");
    const reopened = bridge("reply-state", null);
    reopened.promoteBridgeKey = () => {};
    reopened.readyPayload = () => ({ run: reopened.runPayload() });
    reopened.pending.set(7, "thread/resume");
    deliver(reopened, { id: 7, result: { thread: { id: "reply-state", path: sessionPath, turns: [{ id: "current-turn", status: "completed", items: [{ type: "agentMessage", text }] }] } } });
    const ready = reopened.events.find((event) => event.type === "ready");
    assert.equal(ready.run.state, expected);
    assert.equal(sessionActivityStatus(ready.run), expected);
  });
}

test("an empty completed turn does not inherit a previous question", () => {
  const own = bridge("reply-state", "new-turn");
  own.history = [{ type: "assistant", text: "続行しますか？", outputGroup: "previous-turn" }];
  deliver(own, { method: "turn/completed", params: { threadId: "reply-state", turn: { id: "new-turn", status: "completed" } } });
  assert.equal(own.runPayload().state, "done");
});

test("a nonblocking progress question cannot become a final reply wait", () => {
  const own = bridge("reply-state", "current-turn");
  deliver(own, { method: "item/completed", params: { threadId: "reply-state", turnId: "current-turn", item: { type: "agentMessage", phase: "commentary", text: "こちらで続行しますか？" } } });
  assert.equal(own.history[0].phase, "commentary");
  deliver(own, { method: "turn/completed", params: { threadId: "reply-state", turn: { id: "current-turn", status: "completed" } } });
  assert.equal(own.runPayload().state, "done");
});

test("joining a terminal's conversation preserves its model and permission choices", () => {
  const own = bridge("shared", null);
  const requests = [];
  own.request = (method, params) => { requests.push({ method, params }); return requests.length; };
  own.upstream.send = () => {};
  own.upstream.emit("open");
  assert.deepEqual(requests.find((request) => request.method === "thread/resume").params,
    { threadId: "shared", excludeTurns: true, initialTurnsPage: { limit: 80, sortDirection: "desc", itemsView: "summary" } });
});

test("resume hydrates recent summaries in order without receiving full tool output", () => {
  const own = bridge("shared", null);
  own.promoteBridgeKey = () => {};
  own.readyPayload = () => ({ history: own.history, run: own.runPayload() });
  own.pending.set(7, "thread/resume");
  deliver(own, { id: 7, result: {
    thread: { id: "shared", turns: [] },
    initialTurnsPage: { data: [
      { id: "active", status: "inProgress", items: [{ type: "userMessage", id: "user", content: [{ type: "text", text: "continue" }] }] },
      { id: "previous", status: "completed", items: [{ type: "agentMessage", text: "saved answer" }] },
    ], nextCursor: "older" },
  } });
  assert.deepEqual(own.history.map(entry => entry.text), ["saved answer", "continue"]);
  assert.equal(own.activeTurnId, "active");
  assert.equal(own.ready, true);
});

test("an external writer keeps the original conversation and reports actionable recovery", () => {
  const own = bridge("shared", null);
  own.ready = false;
  own.pending.set(7, "thread/resume");
  own.history = [{ type: "assistant", text: "saved answer" }];
  own.request = () => assert.fail("a writer conflict must not take over or create a conversation");
  deliver(own, { id: 7, error: { message: "thread shared already has an active writer" } });
  const error = own.events.find(event => event.type === "error");
  assert.equal(error.code, "thread_writer_conflict");
  assert.equal(error.retryable, false);
  assert.match(error.text, /同じ会話/);
  assert.equal(own.requestedThreadId, "shared");
  assert.equal(own.ready, false);
  assert.equal(own.history[0].text, "saved answer");
});

test("an oversized startup response reports an error instead of remaining connecting", () => {
  const own = bridge("large", null);
  own.ready = false;
  own.runState = { state: "connecting" };
  own.upstream.emit("error", new Error("Max payload size exceeded"));
  assert.equal(own.startupFailed, true);
  assert.equal(own.runState.state, "error");
  assert.equal(own.events.find(event => event.type === "error").code, "codex_payload_too_large");
});

test("a missing conversation is inspected and fails without starting a replacement", () => {
  const own = bridge("missing", null);
  own.threadId = null;
  own.ready = false;
  own.pending.set(7, "thread/resume");
  const requests = [];
  own.request = (method, params) => { requests.push({ method, params }); return 8; };
  deliver(own, { id: 7, error: { message: "no rollout found for thread id missing" } });
  assert.deepEqual(requests, [{ method: "thread/read", params: { threadId: "missing", includeTurns: false } }]);
  deliver(own, { id: 8, error: { message: "no rollout found for thread id missing" } });
  assert.equal(own.requestedThreadId, "missing");
  assert.equal(own.startupFailed, true);
  assert.equal(own.runState.state, "error");
  assert.equal(requests.length, 1);
});

test("a new conversation is not ready until Codex has saved its matching header", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-new-persistence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, "rollout.jsonl");
  const own = bridge(null, null);
  own.ready = false;
  own.promoteBridgeKey = () => {};
  own.readyPayload = () => ({ threadId: own.threadId });
  const requests = [];
  own.request = (method, params) => { requests.push({ method, params }); return 8; };
  own.pending.set(7, "thread/start");
  deliver(own, { id: 7, result: { thread: { id: "new-thread", path: sessionPath, turns: [] } } });
  assert.equal(own.ready, false, "a generated id alone does not survive a restart");
  assert.deepEqual(requests, [{ method: "thread/read", params: { threadId: "new-thread", includeTurns: true } }]);
  fs.writeFileSync(sessionPath, JSON.stringify({ type: "session_meta", payload: { id: "new-thread", cwd: directory } }) + "\n");
  deliver(own, { id: 8, error: { message: "list_turns is not supported yet" } });
  assert.equal(own.ready, true);
  assert.equal(own.threadId, "new-thread");
  assert.equal(own.events.filter(event => event.type === "ready").length, 1);
});

for (const savedId of [null, "some-other-thread"]) {
  test(`a new conversation fails safely when persistence is ${savedId ? "for another id" : "missing"}`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-save-failure-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sessionPath = path.join(directory, "rollout.jsonl");
    const own = bridge(null, null);
    own.ready = false;
    own.promoteBridgeKey = () => {};
    own.readyPayload = () => ({});
    own.request = () => 8;
    own.pending.set(7, "thread/start");
    deliver(own, { id: 7, result: { thread: { id: "new-thread", path: sessionPath, turns: [] } } });
    if (savedId) fs.writeFileSync(sessionPath, JSON.stringify({ type: "session_meta", payload: { id: savedId, cwd: directory } }) + "\n");
    deliver(own, { id: 8, result: { thread: { id: "new-thread", path: sessionPath, turns: [] } } });
    assert.equal(own.ready, false);
    assert.equal(own.startupFailed, true);
    assert.equal(own.events.some(event => event.type === "ready"), false);
  });
}

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
