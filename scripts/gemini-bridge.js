// Gemini uses Antigravity's documented headless stream, not Gemini CLI ACP.
// Credentials remain in the CLI's machine-local credential store.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { redactSensitiveText, debugLog } = require("./debug-log");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-high";
const GEMINI_CAPABILITIES = Object.freeze({ backend: "antigravity-cli", experimental: true, attachments: false, approvals: false, mode: "plan" });
const googleLoginMessage = "このPCのAntigravity（agy）でGoogleアカウントに初回ログインしてください。Gemini CLIの保存済みログインとは別です。ログイン後は元の依頼を再送してください。追加課金の接続へは切り替えません。";

function antigravityBin(env = process.env, home = os.homedir()) {
  if (env.ANTIGRAVITY_BIN) return env.ANTIGRAVITY_BIN;
  const local = process.platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "agy", "bin", "agy.exe")
    : path.join(home, ".local", "bin", "agy");
  return fs.existsSync(local) ? local : "agy";
}

function assertAccountBilling({ home = os.homedir(), cwd } = {}) {
  const files = new Set([path.join(home, ".gemini", "antigravity-cli", "settings.json")]);
  if (cwd) files.add(path.join(cwd, ".gemini", "antigravity-cli", "settings.json"));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw new Error("Antigravityの設定を確認できないため起動しません。PC側の設定を確認してください。"); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Antigravityの設定形式を確認してください。");
    if (settings.useG1Credits === true || (settings.modelProvider && settings.modelProvider !== "antigravity")) {
      throw new Error("Antigravityに追加クレジットまたは別の課金接続が設定されています。このリモコンはアカウントの通常枠だけを使うため起動しません。設定は変更していません。");
    }
    if (settings.toolPermission === "always-proceed") {
      throw new Error("Antigravityで全操作の自動承認が設定されています。リモコンのGeminiは承認操作に未対応のため、この設定では起動しません。");
    }
  }
}

function geminiArgs({ model = DEFAULT_GEMINI_MODEL, effort = "high", sessionId } = {}) {
  if (!/^gemini-[a-z0-9.-]+$/i.test(model)) throw new Error("Geminiのモデル名を指定してください。他のAIへは切り替えません。");
  if (!["low", "medium", "high"].includes(effort)) throw new Error("Geminiの思考の深さは low / medium / high から指定してください。");
  if (sessionId && !UUID.test(sessionId)) throw new Error("Invalid Gemini native conversation id");
  // Plan is an instruction, NOT a filesystem sandbox. Never map Codex's
  // read-only/full-access settings onto it or silently grant tool permissions.
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--mode", "plan", "--model", model, "--effort", effort];
  if (sessionId) args.push("--conversation", sessionId);
  return args;
}

class GeminiSessionStore {
  constructor(directory) { this.directory = directory; }
  file(id) {
    const uuid = String(id || "").replace(/^gemini:/, "");
    if (!String(id).startsWith("gemini:") || !UUID.test(uuid)) throw new Error("Invalid Gemini conversation id");
    return path.join(this.directory, uuid + ".json");
  }
  read(id) {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(id), "utf8"));
      if (data.id !== id || data.provider !== "gemini" || data.backend !== "antigravity-cli" || !path.isAbsolute(data.workdir) || !Array.isArray(data.history)) throw new Error("Invalid Gemini conversation record");
      if (data.sessionId && !UUID.test(data.sessionId)) throw new Error("Invalid Gemini native conversation id");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  write(data) {
    const file = this.file(data.id);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }
  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
      .map(name => this.read("gemini:" + name.slice(0, -5))).filter(Boolean);
  }
}

class GeminiStreamClient {
  constructor({ cwd, prompt, model, effort, sessionId, bin = antigravityBin(), spawnProcess = spawn, env = process.env, timeoutMs = 30 * 60 * 1000, onEvent = () => {}, onDiagnostic = () => {} }) {
    this.closed = false;
    this.result = null;
    this.failure = null;
    this.stderr = "";
    const args = geminiArgs({ model, effort, sessionId });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    const childEnv = { ...env, NO_BROWSER: "true", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GOOGLE_GENAI_USE_VERTEXAI: "", GOOGLE_APPLICATION_CREDENTIALS: "", GOOGLE_GEMINI_BASE_URL: "" };
    this.child = spawnProcess(bin, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    const errorDecoder = new StringDecoder("utf8");
    let buffer = "";
    const receive = line => {
      if (!line.trim() || this.failure) return;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error("Geminiの応答形式を読み取れませんでした。"); }
      if (!event || typeof event.event !== "string") throw new Error("Geminiの応答形式に対応していません。");
      if (event.event === "result") {
        if (this.result) throw new Error("Geminiが重複した終了結果を返しました。");
        this.result = event.result;
      }
      onEvent(event);
    };
    this.child.stdout.on("data", chunk => {
      try {
        buffer += decoder.write(chunk);
        if (buffer.length > 16 * 1024 * 1024) throw new Error("Geminiの応答が通信上限を超えました。");
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); receive(line);
        }
      } catch (error) { this.stop(error); }
    });
    this.child.stderr.on("data", chunk => {
      const text = redactSensitiveText(errorDecoder.write(chunk));
      this.stderr = (this.stderr + text).slice(-8000);
      debugLog("gemini.stderr", { text: text.slice(-2000) });
      onDiagnostic(text);
    });
    this.child.stdin.on("error", error => this.stop(error));
    this.child.on("error", error => {
      this.failure = error.code === "ENOENT" ? new Error("このPCにAntigravity（agy）が見つかりません。") : error;
    });
    this.child.on("close", (code, signal) => {
      this.closed = true; clearTimeout(this.timer); clearTimeout(this.killTimer);
      try {
        buffer += decoder.end(); receive(buffer);
        if (this.failure) throw this.failure;
        if (code !== 0 || !this.result) throw new Error(redactSensitiveText(this.result?.error || this.stderr.trim() || "Geminiが回答を完了せず終了しました（" + (signal || code) + "）。"));
        this.resolve(this.result);
      } catch (error) { this.reject(error); }
    });
    this.timer = setTimeout(() => this.stop(new Error("Geminiの応答待ちが時間切れになりました。")), timeoutMs);
    // EOF ends this one turn. Resume its explicit native id next time, never
    // another terminal or phone conversation's "most recent" session.
    this.child.stdin.end(JSON.stringify({ event: "user", message: { content: String(prompt) } }) + "\n");
  }
  stop(error = new Error("Geminiの実行を中断しました。")) {
    if (this.closed) return;
    this.failure ||= error;
    this.child.kill("SIGTERM");
    if (!this.closed && !this.killTimer) {
      this.killTimer = setTimeout(() => { if (!this.closed) this.child.kill("SIGKILL"); }, 5000);
      this.killTimer.unref?.();
    }
  }
}

class GeminiBridge {
  constructor(requestedThreadId, baseBridgeKey, options = {}, dependencies = {}) {
    this.dependencies = dependencies;
    this.provider = "gemini";
    this.store = dependencies.store || new GeminiSessionStore(path.join(os.homedir(), ".gemini", "phone-bridge"));
    this.threadId = requestedThreadId || "gemini:" + crypto.randomUUID();
    const saved = requestedThreadId ? this.store.read(requestedThreadId) : null;
    if (requestedThreadId && !saved) throw Object.assign(new Error("Geminiの会話記録が見つかりません。新しい会話を作成してください。"), { retryable: false });
    this.baseBridgeKey = baseBridgeKey;
    this.bridgeKey = dependencies.bridgeMapKey?.("gemini", baseBridgeKey) || "gemini:" + baseBridgeKey;
    this.requestedThreadId = requestedThreadId;
    this.workdir = saved?.workdir || options.workdir || dependencies.workdir || process.cwd();
    this.model = saved?.model || dependencies.model || DEFAULT_GEMINI_MODEL;
    this.sessionId = saved?.sessionId || null;
    this.history = saved?.history || [];
    this.terminalHistory = saved?.terminalHistory || [];
    this.createdAt = saved?.createdAt || Date.now();
    this.listUpdatedAt = saved?.updatedAt || 0;
    this.clients = new Set();
    this.ready = true;
    this.activeTurnId = null;
    this.activeProcess = null;
    this.turnQueue = [];
    this.pendingApproval = null;
    this.slashCommands = [];
    this.runState = saved?.runState || { state: "ready", label: "未実行・送信できます", updatedAt: Date.now() };
    if (["running", "streaming", "interrupting"].includes(this.runState.state)) this.runState = { state: "interrupted", label: "前回の接続終了・履歴を確認してください", updatedAt: Date.now() };
    if (!saved) this.persist();
  }
  persist() {
    this.store.write({ id: this.threadId, provider: "gemini", backend: "antigravity-cli", sessionId: this.sessionId, workdir: this.workdir, model: this.model, history: this.history, terminalHistory: this.terminalHistory, createdAt: this.createdAt, updatedAt: this.listUpdatedAt, runState: this.runState });
  }
  workspaceMeta() { return this.dependencies.workspaceMeta?.(this.workdir) || {}; }
  runPayload() { return { ...this.runState, turnId: this.activeTurnId, ...this.workspaceMeta() }; }
  readyPayload() {
    return { provider: "gemini", threadId: this.threadId, model: this.model, workdir: this.workdir, ...this.workspaceMeta(), shared: true, clients: this.clients.size, history: this.history, terminalHistory: this.terminalHistory, slashCommands: [], run: this.runPayload(), capabilities: GEMINI_CAPABILITIES };
  }
  addClient(client) {
    clearTimeout(this.idleDisposeTimer);
    this.clients.add(client); this.emitTo(client, "ready", this.readyPayload());
    client.on("close", () => { this.clients.delete(client); this.scheduleIdleDispose(); });
  }
  emitTo(client, type, payload) { if (client.readyState === 1) client.send(JSON.stringify({ type, ...payload })); }
  emit(type, payload = {}) {
    if (type === "status" || type === "error") {
      const entry = { id: crypto.randomUUID(), ts: Date.now(), kind: type, message: redactSensitiveText(payload.text || ""), turnId: this.activeTurnId };
      this.terminalHistory.push(entry); this.terminalHistory = this.terminalHistory.slice(-400);
      payload = { ...payload, terminalEntry: entry };
    }
    for (const client of this.clients) this.emitTo(client, type, payload);
  }
  setState(state, label) {
    this.runState = { state, label, updatedAt: Date.now() };
    this.emit("runState", this.runPayload());
  }
  hasActiveWork() { return Boolean(this.activeTurnId || this.activeProcess); }
  isReusable() { return !this.disposed; }
  scheduleIdleDispose() {
    clearTimeout(this.idleDisposeTimer);
    if (this.clients.size || this.hasActiveWork()) return;
    this.idleDisposeTimer = setTimeout(() => this.dispose(), 60 * 60 * 1000);
    this.idleDisposeTimer.unref?.();
  }
  dispose() {
    this.disposed = true; clearTimeout(this.idleDisposeTimer);
    this.interrupt(); this.dependencies.onDispose?.(this);
  }
  prompt(text, attachments = [], options = {}, clientMessageId = null, context) {
    if (attachments.length) { this.emit("error", { text: "Geminiは現在、文章のみ対応しています。添付を外して送信してください。", clientMessageId }); return; }
    if (this.disposed) { this.emit("error", { text: "Geminiの会話に再接続してください。" }); return; }
    // No acknowledgement means the phone keeps this draft, including after a
    // failed login or interruption. Do not accept a queue we cannot preserve.
    if (this.hasActiveWork()) { this.emit("error", { text: "Geminiの回答を待ってから送信してください。今回の入力は下書きに残しています。", clientMessageId }); return; }
    this.activeTurnId = "gemini-turn:" + crypto.randomUUID();
    this.execute(text, options, clientMessageId, context).catch(error => this.emit("error", { text: redactSensitiveText(error.message) }));
  }
  async execute(text, options, clientMessageId, context) {
    const turnId = this.activeTurnId;
    this.interruptRequested = false;
    let answer = "", succeeded = false, permissionDenied = false;
    try {
      this.history.push({ type: "user", text, attachments: [] });
      this.listUpdatedAt = Date.now(); this.persist();
      this.emit("user", { text, attachments: [], clientMessageId });
      this.setState("running", "Geminiを起動しています");
      this.emit("turn", { status: "started", turnId, run: this.runPayload() });
      (this.dependencies.checkAccountBilling || assertAccountBilling)({ cwd: this.workdir });
      this.model = options.model || this.model;
      const operatorContext = this.dependencies.modelContext?.(context);
      const promptText = operatorContext ? operatorContext + "\n\n[ユーザーの入力]\n" + text : text;
      const expectedId = this.sessionId;
      const acceptId = id => {
        if (!UUID.test(id || "") || (expectedId && id !== expectedId) || (this.sessionId && id !== this.sessionId)) throw new Error("Geminiの会話番号が一致しません。別の会話としては続行しません。");
        if (!this.sessionId) { this.sessionId = id; this.persist(); }
      };
      this.stream = new GeminiStreamClient({
        ...this.dependencies.streamOptions, cwd: this.workdir, prompt: promptText, model: this.model, effort: options.effort || "high", sessionId: this.sessionId,
        onEvent: event => {
          if (event.event === "init") {
            acceptId(event.conversation_id);
            if (event.init?.permission_mode === "always-proceed") throw new Error("Geminiが全操作の自動承認で起動したため停止しました。");
          } else if (event.event === "step_update") {
            const step = event.step_update || {};
            acceptId(step.conversation_id);
            if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
              answer += step.text_delta;
              this.setState("streaming", "回答生成中");
              this.emit("assistantDelta", { text: step.text_delta, turnId });
            } else if (step.step_type === "tool") {
              this.emit("status", { text: "Gemini: " + (step.tool_name || "処理") + (step.state === "DONE" ? " 終了" : " 実行中") });
              if (step.tool_info?.error) { permissionDenied = true; this.emit("status", { text: "Geminiの処理に制限またはエラーがありました: " + redactSensitiveText(step.tool_info.error.message || "詳細をPC側で確認してください") }); }
            }
          }
        },
        onDiagnostic: diagnostic => {
          if (/soft.denied|permission.*denied|approval|requires?.*(?:permission|confirmation)/i.test(diagnostic)) {
            permissionDenied = true;
            this.emit("status", { text: "Geminiで確認が必要な処理は実行されていない可能性があります。この接続では承認ボタンを使えません。" });
          }
        },
      });
      this.activeProcess = this.stream.child;
      const result = await this.stream.finished;
      if (result.status !== "SUCCESS") throw new Error(redactSensitiveText(result.error || "Geminiの回答が完了しませんでした（" + (result.status || "unknown") + "）。"));
      acceptId(result.conversation_id);
      answer = typeof result.response === "string" ? result.response : answer;
      succeeded = true;
    } catch (error) {
      if (!this.interruptRequested) {
        const message = /auth(?:entication)? (?:required|failed)|please sign in|not authenticated|credentials?.*(?:missing|not found)/i.test(error.message)
          ? googleLoginMessage + " 原因: " + redactSensitiveText(error.message).slice(0, 400)
          : redactSensitiveText(error.message);
        this.setState("error", "Geminiの実行を確認してください");
        this.emit("error", { text: message, turnId });
      }
    } finally {
      if (answer) this.history.push({ type: "assistant", text: answer, turnId });
      this.stream = null; this.activeProcess = null; this.activeTurnId = null;
      if (this.interruptRequested) this.setState("interrupted", "中断しました");
      else if (succeeded) this.setState("done", permissionDenied ? "回答終了・未実行の処理を確認" : "完了・送信できます");
      this.listUpdatedAt = Date.now();
      try { this.persist(); }
      catch { this.setState("error", "Geminiの履歴保存に失敗しました"); this.emit("error", { text: "履歴を保存できませんでした。画面の回答を確認してください。" }); }
      this.emit("turn", { status: "completed", turnId, run: this.runPayload() });
      this.scheduleIdleDispose();
    }
  }
  approval() { this.emit("status", { text: "Geminiのこの接続方法は承認ボタンに対応していません。" }); }
  interrupt() {
    if (!this.activeTurnId) return;
    this.interruptRequested = true; this.setState("interrupting", "中断中");
    this.stream?.stop();
  }
}

module.exports = { GeminiBridge, GeminiStreamClient, GeminiSessionStore, geminiArgs, assertAccountBilling, antigravityBin, DEFAULT_GEMINI_MODEL, GEMINI_CAPABILITIES };
