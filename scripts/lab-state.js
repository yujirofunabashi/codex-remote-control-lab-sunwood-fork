// Trusted relay state. The guest never receives the phone's fleet registry.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { idleRunStateFromHistory } = require("./question-state");

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function labPath(value, root) {
  const input = String(value || root);
  if (input.includes("\\") || input.includes("\0") || input.split("/").some(part => part === ".." || part.startsWith("."))) {
    throw failure("実験用の作業フォルダだけを選べます。");
  }
  const target = path.posix.normalize(input);
  if (target !== root && !target.startsWith(`${root}/`)) throw failure("実験用の作業フォルダの外は操作できません。", 403);
  return target;
}

class LabState extends EventEmitter {
  constructor({ file, workRoot, now = Date.now }) {
    super();
    this.file = file;
    this.workRoot = labPath(workRoot, workRoot);
    this.now = now;
    this.waiters = new Map();
    this.state = { version: 1, threads: {}, jobs: {}, folders: {}, files: {}, artifacts: [], target: { vmState: "unknown", observedAt: 0 } };
    if (file && fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Lab state cannot be a symlink");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || saved.workRoot !== workRoot) throw new Error("Lab state belongs to a different workspace or version");
      this.state = saved;
    }
    // A relay restart does not prove that the remote computer is still online.
    this.lastHeartbeat = 0;
  }

  save() {
    if (!this.file) return;
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...this.state, workRoot: this.workRoot }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.file);
  }

  target() {
    const hostOnline = this.lastHeartbeat > 0 && this.now() - this.lastHeartbeat < 15000;
    const vmState = hostOnline ? this.state.target.vmState : "unknown";
    const ready = hostOnline && vmState === "running" && this.state.target.guestReady === true;
    const pendingOperation = Object.values(this.state.jobs).find(job => ["start", "shutdown"].includes(job.op) && !job.finishedAt)?.op;
    const aiReady = ready && this.state.target.aiReady === true;
    return { ...this.state.target, vmState, hostOnline, ready, aiReady, stale: !ready,
      pendingOperation,
      label: !hostOnline ? "Windowsへの接続を確認できません" : pendingOperation === "start" ? "実験室へ起動を依頼しています" : pendingOperation === "shutdown" ? "実験室へ停止を依頼しています" : vmState === "off" ? "実験室は停止中" : aiReady ? "実験室を操作できます" : ready ? "ファイルは確認できます・AI作業は準備中" : "実験室を確認中" };
  }

  requireReady() {
    if (!this.target().ready) throw failure(this.target().label + "。起動状態を確認してから操作してください。", 409);
  }

  heartbeat(target = {}) {
    if (!["running", "off", "starting", "stopping", "unknown"].includes(target.vmState)) throw failure("Invalid VM state");
    this.lastHeartbeat = this.now();
    this.state.target = { vmState: target.vmState, guestReady: target.guestReady === true, aiReady: target.aiReady === true, observedAt: this.now() };
    this.save();
    this.emit("target", this.target());
    if (this.target().ready) {
      for (const [op, args] of [["browse", { path: this.workRoot }], ["snapshot", {}]]) {
        const hasCache = op === "browse" ? this.state.folders[this.workRoot] : this.state.snapshotAt;
        if (!hasCache && !Object.values(this.state.jobs).some(job => job.op === op && !job.finishedAt)) this.enqueue(op, args);
      }
    }
  }

  thread(id) {
    const thread = Object.hasOwn(this.state.threads, id) && this.state.threads[id];
    if (!thread) throw failure("実験室の会話が見つかりません。", 404);
    return thread;
  }

  createThread(workdir) {
    this.requireReady();
    const cwd = labPath(workdir, this.workRoot);
    if (!this.state.folders[cwd]) throw failure("先に実験室のフォルダを確認してください。", 409);
    const id = `lab-${crypto.randomUUID()}`;
    const thread = { id, provider: "codex", name: "新しい実験作業", cwd, createdAt: this.now(), updatedAt: 0, history: [], run: { state: "ready", label: "未実行・送信できます" } };
    this.state.threads[id] = thread;
    this.save();
    return thread;
  }

  threadRecords() {
    return Object.values(this.state.threads).filter(thread => thread.history.length).map(thread => ({
      id: thread.id, provider: "codex", name: thread.name, cwd: thread.cwd,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, runState: this.run(thread).state,
    }));
  }

  run(thread) {
    const target = this.target();
    const uncertain = !target.ready && ["running", "streaming", "interrupting"].includes(thread.run.state);
    return { ...thread.run, ...(uncertain ? { state: "disconnected", label: "実行結果を確認できません" } : {}),
      workdir: thread.cwd, workspaceLocation: thread.cwd, repoName: path.posix.basename(thread.cwd), gitBranch: "" };
  }

  enqueue(op, args = {}, { threadId, clientMessageId } = {}) {
    if (!["start", "shutdown", "browse", "read", "snapshot", "run", "interrupt"].includes(op)) throw failure("Unsupported lab operation");
    // Acknowledging a prior accepted submission is safe even while offline.
    if (op === "run" && clientMessageId) {
      const prior = Object.values(this.state.jobs).find(job => job.op === op && job.threadId === threadId && job.clientMessageId === clientMessageId);
      if (prior) return prior;
    }
    if (op !== "start") this.requireReady();
    else if (!this.target().hostOnline) throw failure("Windowsの中継処理が接続されていません。", 409);
    if (op === "run") {
      if (!this.target().aiReady) throw failure("この接続の作業権限の承認・実機検証が未完了です。入力は残し、AIは起動しません。", 409);
      if (Object.values(this.state.jobs).some(job => ["run", "shutdown"].includes(job.op) && !job.finishedAt)) throw failure("実験室で別の作業が動いています。終了後に送信してください。", 409);
      const thread = this.thread(threadId);
      if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20000) throw failure("指示は1〜20,000文字で入力してください。");
      args = { prompt: args.prompt, workdir: thread.cwd, threadId };
    }
    if (op === "shutdown" && Object.values(this.state.jobs).some(job => job.op === "run" && !job.finishedAt)) throw failure("作業中です。中断して結果を確認してから停止してください。", 409);
    if (["browse", "read", "snapshot", "start", "shutdown", "interrupt"].includes(op)) {
      const prior = Object.values(this.state.jobs).find(job => job.op === op && !job.finishedAt && JSON.stringify(job.args) === JSON.stringify(args));
      if (prior) return prior;
    }
    const id = crypto.randomUUID();
    const job = { id, op, args, ...(threadId ? { threadId } : {}), ...(clientMessageId ? { clientMessageId } : {}), createdAt: this.now(), leasedAt: 0 };
    this.state.jobs[id] = job;
    if (op === "run") {
      const thread = this.thread(threadId);
      thread.name = args.prompt.trim().split("\n")[0].slice(0, 100);
      thread.history.push({ type: "user", text: args.prompt, outputGroup: id });
      thread.updatedAt = this.now();
      thread.run = { state: "running", label: "Windowsへ送信済み・開始待ち", turnId: id, updatedAt: this.now() };
    }
    this.save();
    if (op === "run") {
      this.emit("message", threadId, { type: "user", text: args.prompt, clientMessageId });
      this.emit("message", threadId, { type: "turn", status: "started", turnId: id, run: this.run(this.thread(threadId)) });
    }
    return job;
  }

  lease() {
    // Undelivered owner actions must not unexpectedly start hours later.
    // Once leased, the guest's durable idempotency record is authoritative.
    for (const job of Object.values(this.state.jobs)) {
      if (!job.finishedAt && !job.leasedAt && this.now() - job.createdAt > 60000) this.complete(job.id, { ok: false, error: "接続待ちが長いため、未送信の依頼を取り消しました。状態を確認して再送信してください。" });
    }
    const jobs = Object.values(this.state.jobs).filter(job => !job.finishedAt && (!job.leasedAt || this.now() - job.leasedAt > 15000));
    const job = jobs.find(item => item.op === "interrupt") || jobs[0];
    if (!job) return null;
    job.leasedAt = this.now();
    this.save();
    return { id: job.id, op: job.op, args: job.args };
  }

  event(id, event) {
    const job = Object.hasOwn(this.state.jobs, id) && this.state.jobs[id];
    if (!job || job.finishedAt || job.op !== "run") return;
    const thread = this.thread(job.threadId);
    if (event.type === "status") {
      thread.run = { ...thread.run, state: "running", label: "Windowsで作業中", updatedAt: this.now() };
      this.emit("message", thread.id, { type: "runState", ...this.run(thread) });
    }
  }

  complete(id, result) {
    const job = Object.hasOwn(this.state.jobs, id) && this.state.jobs[id];
    if (!job) throw failure("Unknown lab job", 404);
    if (job.finishedAt) return;
    if (!result || typeof result.ok !== "boolean") throw failure("Invalid lab result");
    // Validate before changing the persisted job or notifying its caller.
    if (result.ok && job.op === "browse") {
      const folder = result.data;
      const expected = labPath(job.args.path, this.workRoot);
      if (labPath(folder?.path, this.workRoot) !== expected || !Array.isArray(folder.entries) || folder.entries.length > 200) throw failure("Wrong guest folder result");
      for (const entry of folder.entries) {
        if (path.posix.dirname(labPath(entry.path, this.workRoot)) !== expected || entry.name !== path.posix.basename(entry.path)) throw failure("Invalid guest folder entry");
      }
      this.state.folders[expected] = { ...folder, fetchedAt: this.now(), parent: expected === this.workRoot ? null : path.posix.dirname(expected) };
    }
    if (result.ok && job.op === "read") {
      const filename = labPath(job.args.path, this.workRoot);
      if (result.data?.path !== filename || typeof result.data.text !== "string" || Buffer.byteLength(result.data.text) > 80000) throw failure("Invalid guest file result");
      this.state.files[filename] = { ...result.data, fetchedAt: this.now() };
    }
    if (result.ok && job.op === "snapshot") this.acceptSnapshot(result.data);
    job.finishedAt = this.now();
    job.result = result;
    if (job.op === "run") {
      const thread = this.thread(job.threadId);
      const answer = typeof result.data?.text === "string" ? result.data.text.slice(0, 100000) : "";
      if (answer) thread.history.push({ type: "assistant", text: answer, outputGroup: id });
      const state = result.ok ? "done" : result.data?.interrupted ? "interrupted" : "error";
      const label = result.ok ? "完了しました" : state === "interrupted" ? "作業を中断しました" : "作業に失敗しました";
      if (!result.ok) thread.history.push({ type: "status", text: result.error || label });
      thread.run = { state, label, turnId: id, updatedAt: this.now() };
      if (result.ok) thread.run = { ...thread.run, ...idleRunStateFromHistory(thread.history, thread.run) };
      thread.updatedAt = this.now();
    }
    this.save();
    if (job.op === "run") {
      const thread = this.thread(job.threadId);
      this.emit("message", thread.id, { type: "historyChanged" });
      this.emit("message", thread.id, { type: "turn", status: "completed", turnId: id, run: this.run(thread) });
      if (this.target().ready) this.enqueue("snapshot");
    }
    if (["start", "shutdown"].includes(job.op)) this.emit("operation", { op: job.op, result });
    for (const waiter of this.waiters.get(id) || []) waiter(result);
    this.waiters.delete(id);
  }

  acceptSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.artifacts)) throw failure("Invalid guest snapshot");
    const artifacts = snapshot.artifacts.slice(0, 200).map(item => ({ ...item, path: labPath(item.path, this.workRoot), fetchedAt: this.now() }));
    const firstPlan = snapshot.firstPlan;
    if (firstPlan && (typeof firstPlan.text !== "string" || firstPlan.text.length > 40000 || labPath(firstPlan.path, this.workRoot) !== `${this.workRoot}/first-ai-task-01/PLAN.json`)) throw failure("Invalid first plan");
    this.state.artifacts = artifacts;
    this.state.snapshotAt = this.now();
    if (firstPlan && !this.state.threads["lab-first-plan"]) {
      const cwd = path.posix.dirname(firstPlan.path);
      this.state.threads["lab-first-plan"] = { id: "lab-first-plan", provider: "codex", name: "最初の実験計画", cwd,
        createdAt: firstPlan.modifiedAt || this.now(), updatedAt: firstPlan.modifiedAt || this.now(),
        history: [{ type: "status", text: "既存の計画草案を読み込みました。市場実験の完了を意味しません。" }, { type: "assistant", text: firstPlan.text }],
        run: { state: "done", label: "計画草案を取得済み", updatedAt: firstPlan.modifiedAt || this.now() } };
      this.state.files[firstPlan.path] = { path: firstPlan.path, kind: "text", text: firstPlan.text, fetchedAt: this.now() };
    }
  }

  async request(op, args = {}) {
    const job = this.enqueue(op, args);
    const result = await new Promise((resolve, reject) => {
      const callback = result => { clearTimeout(timer); resolve(result); };
      const timer = setTimeout(() => {
        this.waiters.set(job.id, (this.waiters.get(job.id) || []).filter(waiter => waiter !== callback));
        reject(failure("Windowsからの応答を待っています。再接続後に確認してください。", 504));
      }, 12000);
      this.waiters.set(job.id, [...(this.waiters.get(job.id) || []), callback]);
    });
    if (!result.ok) throw failure(result.error || "実験室の操作に失敗しました。", 409);
    return result.data;
  }
}

module.exports = { LabState, labPath, failure };
