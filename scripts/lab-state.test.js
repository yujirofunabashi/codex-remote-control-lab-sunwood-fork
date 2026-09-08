const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LabState, labPath } = require("./lab-state");
const root = "/home/agent-lab/work";

function ready(store) {
  store.heartbeat({ vmState: "running", guestReady: true, aiReady: true });
  for (const job of Object.values(store.state.jobs)) {
    if (job.finishedAt) continue;
    if (job.op === "browse") store.complete(job.id, { ok: true, data: { path: root, entries: [] } });
    if (job.op === "snapshot") store.complete(job.id, { ok: true, data: { artifacts: [] } });
  }
  return store;
}

test("only the explicit lab directory is addressable", () => {
  assert.equal(labPath(`${root}/計画 & 作業`, root), `${root}/計画 & 作業`);
  for (const name of ["/etc/passwd", `${root}2`, `${root}/../.codex/auth.json`, `${root}/.env`, `${root}/a/./b`, "C:\\Users\\USER", `${root}/a\0b`]) assert.throws(() => labPath(name, root));
});

test("file availability alone never authorizes or queues an AI turn", () => {
  const store = ready(new LabState({ workRoot: root }));
  const thread = store.createThread(root);
  for (const aiReady of [undefined, false, "true"]) {
    store.heartbeat({ vmState: "running", guestReady: true, aiReady });
    assert.equal(store.target().ready, true);
    assert.equal(store.target().aiReady, false);
    assert.match(store.target().label, /AI作業は準備中/);
    assert.throws(() => store.enqueue("run", { prompt: "test" }, { threadId: thread.id }), /承認・実機検証/);
    assert.equal(thread.history.length, 0);
    assert.equal(Object.values(store.state.jobs).filter(job => job.op === "run").length, 0);
  }
});

test("accepted submissions survive reconnect/restart and are not accepted twice", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-lab-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  let now = 100000;
  const store = ready(new LabState({ file, workRoot: root, now: () => now }));
  const thread = store.createThread(root);
  const options = { threadId: thread.id, clientMessageId: "submission-1" };
  const job = store.enqueue("run", { prompt: "計画を書いて" }, options);
  assert.equal(store.lease().id, job.id);
  now += 20000;
  assert.equal(store.target().ready, false);
  assert.equal(store.run(thread).state, "disconnected");
  assert.equal(store.enqueue("run", { prompt: "再送" }, options).id, job.id);
  assert.equal(thread.history.length, 1);
  const restored = new LabState({ file, workRoot: root, now: () => now });
  assert.equal(restored.target().hostOnline, false);
  assert.equal(restored.enqueue("run", { prompt: "再送" }, options).id, job.id);
  assert.equal(restored.lease().id, job.id);
  restored.complete(job.id, { ok: true, data: { text: "計画を作りました。" } });
  restored.complete(job.id, { ok: true, data: { text: "重複" } });
  assert.equal(restored.thread(thread.id).history.length, 2);
  assert.equal(restored.thread(thread.id).run.state, "done");
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("a current direct question is reply-waiting; an explanatory question mark is not", () => {
  const store = ready(new LabState({ workRoot: root }));
  const thread = store.createThread(root);
  for (const [text, expected] of [["どちらを選びますか？", "question"], ["説明書の『なぜ？』という見出しを修正しました。作業は完了です。", "done"]]) {
    const job = store.enqueue("run", { prompt: "確認して" }, { threadId: thread.id, clientMessageId: expected });
    store.complete(job.id, { ok: true, data: { text } });
    assert.equal(thread.run.state, expected);
  }
});

test("offline mutation and parallel runs are refused; stopping is not an approval", () => {
  const store = new LabState({ workRoot: root });
  assert.throws(() => store.createThread(root));
  assert.throws(() => store.enqueue("start"));
  ready(store);
  const thread = store.createThread(root);
  store.enqueue("run", { prompt: "検査して" }, { threadId: thread.id, clientMessageId: "one" });
  assert.throws(() => store.enqueue("shutdown"));
  assert.throws(() => store.enqueue("publish"));
  assert.throws(() => store.enqueue("run", { prompt: "次" }, { threadId: thread.id, clientMessageId: "two" }));
  store.heartbeat({ vmState: "off", guestReady: false });
  assert.equal(store.run(thread).state, "disconnected");
});

test("unleased actions expire but an already leased action retains its identity", () => {
  let now = 100000;
  const store = ready(new LabState({ workRoot: root, now: () => now }));
  const thread = store.createThread(root);
  const job = store.enqueue("run", { prompt: "検査して" }, { threadId: thread.id, clientMessageId: "one" });
  now += 61000;
  assert.equal(store.lease(), null);
  assert.equal(job.result.ok, false);
  assert.equal(thread.run.state, "error");
});

test("malformed results cannot write an outside cache or complete the job", () => {
  const store = ready(new LabState({ workRoot: root }));
  const job = store.enqueue("browse", { path: root });
  assert.throws(() => store.complete(job.id, { ok: true, data: { path: root, entries: [{ name: "secret", path: "/etc/secret" }] } }));
  assert.equal(job.finishedAt, undefined);
  assert.throws(() => store.acceptSnapshot({ artifacts: [], firstPlan: { path: "/etc/secret", text: "bad" } }));
});

module.exports = { ready };
