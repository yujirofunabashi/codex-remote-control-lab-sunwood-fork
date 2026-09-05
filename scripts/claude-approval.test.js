const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

process.env.PHONE_AGENT_PROVIDER = "claude";

const { ClaudeBridge, SharedBridge, approvalMcpConfig, claudePermissionMode } = require("./start-phone");

const approvalMcpScript = path.join(__dirname, "claude-approval-mcp.js");

// The bridge emits over `ws`-style clients; a socket stub is enough to observe it.
function fakeClient() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(body) {
      sent.push(JSON.parse(body));
    },
    on() {},
    messagesOfType(type) {
      return sent.filter((msg) => msg.type === type);
    },
  };
}

function connectAndAsk(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
}

// Drives the stdio MCP server the way Claude Code does: initialize, then tools/call.
function callApprovalMcp(env, toolArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [approvalMcpScript], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = [];
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        replies.push(msg);
        if (msg.id === 2) {
          child.stdin.end();
          resolve({ replies, stderr });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", () => resolve({ replies, stderr }));

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: toolArgs } })}\n`,
    );
  });
}

function decisionFrom(reply) {
  return JSON.parse(reply.result.content[0].text);
}

test("確認モード keeps the run in a permission mode that can prompt", () => {
  assert.equal(claudePermissionMode({ approvalPolicy: "on-request", sandboxMode: "workspace-write" }), "default");
  assert.equal(claudePermissionMode({ approvalPolicy: "never", sandboxMode: "danger-full-access" }), "bypassPermissions");
});

test("フルアクセス is given an approval channel too", async () => {
  // bypassPermissions does not mean nothing can ask: a PreToolUse hook
  // answering "ask" still stops the tool call. With no prompt tool to route it
  // to, headless Claude records a permission denial and says it needs
  // confirmation - which reached the phone as a run that never finished.
  const bridge = new ClaudeBridge(null, "bridge-bypass");
  const spawned = [];
  bridge.spawnTurn = (...args) => spawned.push(args);
  try {
    bridge.startPrompt("フルアクセスで実行", [], { approvalPolicy: "never", sandboxMode: "danger-full-access" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(spawned.length, 1);
    const [, , , , permissionMode, approvalSocketPath] = spawned[0];
    assert.equal(permissionMode, "bypassPermissions");
    assert.ok(approvalSocketPath, "the turn is handed a socket to ask over");
    assert.ok(fs.existsSync(approvalSocketPath));
  } finally {
    bridge.closeApprovalServer();
  }
});

test("a phone that reconnects mid-approval is handed the question back", async () => {
  // The turn is still active while it waits, so the run reported itself as
  // 処理中 and carried nothing to answer with: reloading the page left a
  // spinner and no card, and the only way on was another client.
  const bridge = new ClaudeBridge(null, "bridge-reconnect");
  const client = fakeClient();
  bridge.clients.add(client);
  bridge.activeTurnId = "claude-turn:waiting";
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, { toolName: "Bash", input: { command: "npm test" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [approval] = client.messagesOfType("approval");

    const run = bridge.runPayload();
    assert.equal(run.state, "approval");
    assert.equal(run.label, "承認待ち");
    assert.equal(run.pendingApproval?.id, approval.request.id, "the arriving phone is told what is being asked");
    assert.equal(bridge.readyPayload().run.pendingApproval?.id, approval.request.id);

    bridge.approval(approval.request, "accept");
    assert.deepEqual(await pending, { decision: "accept" });
    assert.equal(bridge.pendingApproval, null, "an answered question is not handed back");
    assert.notEqual(bridge.runPayload().state, "approval");
  } finally {
    bridge.closeApprovalServer();
  }
});

// The card that would not go away. An unanswered question ends when the turn
// that asked it does, and Claude Code kills the prompt tool's child on the way
// out. Only the settle entry was dropped then, so the held copy stayed and every
// status poll handed the same dead question back - 承認 could never reach it,
// and the banner survived any number of taps.
test("a question whose asker has gone stops being handed back to the phone", async () => {
  const bridge = new ClaudeBridge(null, "bridge-orphan");
  const client = fakeClient();
  bridge.clients.add(client);
  bridge.activeTurnId = "claude-turn:abandoned";
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.write(`${JSON.stringify({ toolName: "AskUserQuestion", input: { questions: [] } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const [approval] = client.messagesOfType("approval");
    assert.equal(bridge.runPayload().pendingApproval?.id, approval.request.id);

    // The asker walks away without a decision.
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(bridge.pendingApproval, null, "the dead question is not held any more");
    assert.notEqual(bridge.runPayload().state, "approval");
    assert.ok(!bridge.runPayload().pendingApproval, "no status poll can hand it back");
    assert.ok(!bridge.readyPayload().run.pendingApproval, "a reconnecting phone is not given it either");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("the turn a dead question interrupted is still reported as running", async () => {
  const bridge = new ClaudeBridge(null, "bridge-orphan-running");
  const client = fakeClient();
  bridge.clients.add(client);
  bridge.activeTurnId = "claude-turn:still-working";
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.write(`${JSON.stringify({ toolName: "Bash", input: { command: "npm test" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Forgetting the question must not read as "the turn ended".
    assert.equal(bridge.runPayload().state, "running");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("answering a question that already ended clears the card instead of bouncing", async () => {
  // Two phones, or one phone on a stale card: the request is over, but a card is
  // still on screen. The tap has to be able to dismiss it.
  const bridge = new ClaudeBridge(null, "bridge-stale-card");
  const client = fakeClient();
  bridge.clients.add(client);
  const stale = { id: "claude-approval:9", method: "claude/requestApproval", params: { toolName: "Bash", input: {} } };
  bridge.pendingApproval = stale;
  bridge.setBridgeRunState("approval", "承認待ち", null);
  bridge.pendingApproval = stale;

  bridge.approval(stale, "accept");

  assert.equal(bridge.pendingApproval, null, "the tap dismisses the card it was aimed at");
  assert.notEqual(bridge.runPayload().state, "approval");
  const [status] = client.messagesOfType("status").slice(-1);
  assert.match(status.text, /既に終了/);
});

test("approval mcp config points Claude at this process's socket without binding a port", () => {
  const config = JSON.parse(approvalMcpConfig("/tmp/example.sock"));
  const server = config.mcpServers.phone_approval;

  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [approvalMcpScript]);
  assert.equal(server.env.PHONE_APPROVAL_SOCKET, "/tmp/example.sock");
  assert.ok(!JSON.stringify(config).includes("port"));
});

test("concurrent bridges listen on distinct approval sockets", async () => {
  const first = new ClaudeBridge(null, "bridge-a");
  const second = new ClaudeBridge(null, "bridge-b");
  try {
    const firstPath = await first.ensureApprovalServer();
    const secondPath = await second.ensureApprovalServer();

    assert.notEqual(firstPath, secondPath);
    assert.ok(fs.existsSync(firstPath));
    assert.ok(fs.existsSync(secondPath));
    assert.ok(firstPath.startsWith(os.tmpdir()));
  } finally {
    first.closeApprovalServer();
    second.closeApprovalServer();
  }
});

test("accepting in the browser allows the tool call", async () => {
  const bridge = new ClaudeBridge(null, "bridge-accept");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, {
      toolName: "Bash",
      input: { command: "npm test" },
      toolUseId: "toolu_accept",
    });

    // Wait for the bridge to surface the request to the browser.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [approval] = client.messagesOfType("approval");
    assert.ok(approval, "bridge should emit an approval message");
    assert.equal(approval.request.params.toolName, "Bash");
    assert.equal(approval.request.params.input.command, "npm test");

    bridge.approval(approval.request, "accept");
    assert.deepEqual(await pending, { decision: "accept" });
  } finally {
    bridge.closeApprovalServer();
  }
});

test("declining in the browser blocks the tool call", async () => {
  const bridge = new ClaudeBridge(null, "bridge-decline");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, { toolName: "Bash", input: { command: "rm -rf /" } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const [approval] = client.messagesOfType("approval");
    bridge.approval(approval.request, "decline");

    const reply = await pending;
    assert.equal(reply.decision, "decline");
    assert.match(reply.message, /拒否/);
  } finally {
    bridge.closeApprovalServer();
  }
});

// The phone is usually not connected when a question is asked - the app is in
// the background and iOS has dropped the socket - and the notification is how
// the person finds out. Declining on the spot in that case threw the question
// away before anyone could see it: no card, no notification, and the turn
// carried on as if a decision had been made.
test("a question asked while no phone is connected is held and announced, not declined", async () => {
  const bridge = new ClaudeBridge(null, "bridge-away");
  bridge.operatorReachable = () => true;
  const announced = [];
  bridge.announceApproval = (request, timeoutMs) => announced.push({ request, timeoutMs });
  bridge.activeTurnId = "claude-turn:away";
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, { toolName: "AskUserQuestion", input: { questions: [{ question: "どちら？" }] } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(announced.length, 1, "the person is told");
    assert.ok(announced[0].timeoutMs > 0, "and told how long the question waits");
    const run = bridge.runPayload();
    assert.equal(run.state, "approval");
    assert.equal(run.pendingApproval?.id, announced[0].request.id, "the phone that opens later is handed the card");

    bridge.approval(announced[0].request, "accept", { "どちら？": "A" });
    assert.deepEqual(await pending, { decision: "accept", answers: { "どちら？": "A" } });
  } finally {
    bridge.closeApprovalServer();
  }
});

test("with no phone connected and no way to notify anyone, an approval is declined rather than left hanging", async () => {
  const bridge = new ClaudeBridge(null, "bridge-empty");
  bridge.operatorReachable = () => false;
  bridge.announceApproval = () => assert.fail("nothing to announce to");
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const reply = await connectAndAsk(socketPath, { toolName: "Bash", input: { command: "echo hi" } });

    assert.equal(reply.decision, "decline");
    assert.match(reply.message, /端末も通知先も/);
  } finally {
    bridge.closeApprovalServer();
  }
});

test("an unanswered question expires into a decline, and the expiry is announced", async () => {
  const bridge = new ClaudeBridge(null, "bridge-expire");
  bridge.clients.add(fakeClient());
  bridge.approvalTimeoutMs = 60;
  const announced = [];
  bridge.announceApproval = (request) => announced.push(["asked", request.id]);
  bridge.announceApprovalExpired = (request, timeoutMs) => announced.push(["expired", request.id, timeoutMs]);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const reply = await connectAndAsk(socketPath, { toolName: "AskUserQuestion", input: { questions: [{ question: "A?" }] } });

    assert.equal(reply.decision, "decline");
    assert.match(reply.message, /タイムアウト/);
    assert.equal(announced.length, 2);
    assert.equal(announced[0][0], "asked");
    assert.deepEqual(announced[1], ["expired", announced[0][1], 60]);
    assert.equal(bridge.pendingApproval, null, "the expired question is not handed back");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("a stream update while a question is open does not drop the held card", async () => {
  const bridge = new ClaudeBridge(null, "bridge-hold-through-stream");
  const client = fakeClient();
  bridge.clients.add(client);
  bridge.activeTurnId = "claude-turn:streaming";
  bridge.announceApproval = () => {};
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, { toolName: "Bash", input: { command: "npm test" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [approval] = client.messagesOfType("approval");

    bridge.setBridgeRunState("streaming", "回答生成中", bridge.activeTurnId);
    assert.equal(bridge.pendingApproval?.id, approval.request.id, "still held: the asker is still waiting");
    assert.equal(bridge.runPayload().state, "approval");

    bridge.approval(approval.request, "accept");
    assert.deepEqual(await pending, { decision: "accept" });
    bridge.setBridgeRunState("streaming", "回答生成中", bridge.activeTurnId);
    assert.equal(bridge.pendingApproval, null, "answered: nothing left to hold");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("a Codex approval outlives a stream update and is handed to a reconnecting phone", () => {
  // Codex waits on the answer for as long as the turn runs. The bridge used to
  // drop its copy on the next stream update and report the run as 処理中, so a
  // phone that reconnected threw away the card and Codex waited on nobody.
  const proto = SharedBridge.prototype;
  const bridge = { pendingApproval: null, activeTurnId: "turn-1", workdir: process.cwd(), runState: null, streamingStarted: false, emit() {} };
  bridge.pendingApproval = { id: 7, method: "item/commandExecution/requestApproval", params: { command: ["ls"] } };
  proto.setBridgeRunState.call(bridge, "approval", "承認待ち", "turn-1");
  proto.setBridgeRunState.call(bridge, "streaming", "回答生成中", "turn-1");
  assert.equal(bridge.pendingApproval?.id, 7);

  const run = proto.runPayload.call(bridge);
  assert.equal(run.state, "approval");
  assert.equal(run.label, "承認待ち");
  assert.equal(run.pendingApproval?.id, 7);

  proto.setBridgeRunState.call(bridge, "done", "完了しました", "turn-1");
  assert.equal(bridge.pendingApproval, null, "the turn ended: nothing left to answer");
  assert.notEqual(proto.runPayload.call({ ...bridge, activeTurnId: null }).state, "approval");
});

test("mcp server translates an accept into the allow payload Claude Code expects", async () => {
  const bridge = new ClaudeBridge(null, "bridge-mcp-allow");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const input = { command: "git status", description: "check tree" };
    const call = callApprovalMcp({ PHONE_APPROVAL_SOCKET: socketPath }, {
      tool_name: "Bash",
      input,
      tool_use_id: "toolu_mcp",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [approval] = client.messagesOfType("approval");
    assert.ok(approval, "mcp server should reach the bridge");
    assert.equal(approval.request.params.toolUseId, "toolu_mcp");
    bridge.approval(approval.request, "accept");

    const { replies } = await call;
    const decision = decisionFrom(replies.find((msg) => msg.id === 2));
    assert.deepEqual(decision, { behavior: "allow", updatedInput: input });
  } finally {
    bridge.closeApprovalServer();
  }
});

test("mcp server translates a decline into the deny payload Claude Code expects", async () => {
  const bridge = new ClaudeBridge(null, "bridge-mcp-deny");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const call = callApprovalMcp({ PHONE_APPROVAL_SOCKET: socketPath }, {
      tool_name: "Write",
      input: { file_path: "/etc/hosts", content: "" },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [approval] = client.messagesOfType("approval");
    bridge.approval(approval.request, "decline");

    const { replies } = await call;
    const decision = decisionFrom(replies.find((msg) => msg.id === 2));
    assert.equal(decision.behavior, "deny");
    assert.match(decision.message, /拒否/);
  } finally {
    bridge.closeApprovalServer();
  }
});

test("mcp server fails closed when the bridge socket is unreachable", async () => {
  const missing = path.join(os.tmpdir(), `phone-approval-missing-${process.pid}.sock`);
  const { replies } = await callApprovalMcp({ PHONE_APPROVAL_SOCKET: missing }, {
    tool_name: "Bash",
    input: { command: "echo hi" },
  });

  const decision = decisionFrom(replies.find((msg) => msg.id === 2));
  assert.equal(decision.behavior, "deny");
});

test("mcp server advertises the approve tool over stdio", async () => {
  const child = spawn(process.execPath, [approvalMcpScript], {
    env: { ...process.env, PHONE_APPROVAL_SOCKET: "/tmp/unused.sock" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const tools = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) resolve(msg.result.tools);
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
  child.stdin.end();

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "approve");
  assert.deepEqual(tools[0].inputSchema.required, ["tool_name", "input"]);
});

test("disposing a bridge removes its socket file and releases pending approvals", async () => {
  const bridge = new ClaudeBridge(null, "bridge-dispose");
  const client = fakeClient();
  bridge.clients.add(client);

  const socketPath = await bridge.ensureApprovalServer();
  const pending = connectAndAsk(socketPath, { toolName: "Bash", input: { command: "sleep 60" } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  bridge.closeApprovalServer();

  const reply = await pending;
  assert.equal(reply.decision, "decline");
  assert.ok(!fs.existsSync(socketPath));
});

// The gap the phone fell into. `AskUserQuestion` arrives on this same channel,
// and 許可 alone is not an answer to it: allowed with nothing filled in, headless
// Claude gets back "The user did not answer the questions." and proceeds on its
// own guess, which is what the operator saw - a question in the transcript with
// no way to answer it and a turn that carried on regardless.
test("an answered question reaches Claude as the tool's own answers", async () => {
  const bridge = new ClaudeBridge(null, "bridge-question-allow");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const input = {
      questions: [
        { question: "実装方針は？", header: "方針", options: [{ label: "自前実装" }, { label: "外部サービス" }] },
        { question: "着手はいつ？", header: "時期", options: [{ label: "今週" }, { label: "来週" }] },
      ],
    };
    const call = callApprovalMcp({ PHONE_APPROVAL_SOCKET: socketPath }, {
      tool_name: "AskUserQuestion",
      input,
      tool_use_id: "toolu_question",
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [approval] = client.messagesOfType("approval");
    assert.ok(approval, "the question has to reach the phone at all");
    bridge.approval(approval.request, "accept", { "実装方針は？": "自前実装", "着手はいつ？": "今週" });

    const { replies } = await call;
    const decision = decisionFrom(replies.find((msg) => msg.id === 2));
    assert.equal(decision.behavior, "allow");
    assert.deepEqual(decision.updatedInput.answers, { "実装方針は？": "自前実装", "着手はいつ？": "今週" });
    assert.deepEqual(decision.updatedInput.questions, input.questions, "the questions go back untouched");
  } finally {
    bridge.closeApprovalServer();
  }
});

test("only answers to questions that were actually asked are passed on", async () => {
  const bridge = new ClaudeBridge(null, "bridge-question-filter");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, {
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "進めますか？", header: "確認", options: [{ label: "はい" }] }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const [approval] = client.messagesOfType("approval");

    // A client is not trusted to say what was asked, only what was chosen.
    bridge.approval(approval.request, "accept", {
      "進めますか？": "  はい  ",
      "聞かれていない質問": "任意の文字列",
      "空の回答": "   ",
    });

    const reply = await pending;
    assert.deepEqual(reply.answers, { "進めますか？": "はい" });
  } finally {
    bridge.closeApprovalServer();
  }
});

test("an ordinary tool call carries no answers back", async () => {
  const bridge = new ClaudeBridge(null, "bridge-question-none");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, { toolName: "Bash", input: { command: "npm test" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const [approval] = client.messagesOfType("approval");

    bridge.approval(approval.request, "accept", { "npm test": "はい" });

    const reply = await pending;
    assert.equal(reply.decision, "accept");
    assert.equal(reply.answers, undefined);
  } finally {
    bridge.closeApprovalServer();
  }
});

// Declining a question is a real answer to give - "decide it yourself" - and it
// has to read as that rather than as a blocked tool call.
test("declining a question tells Claude to proceed with its premises stated", async () => {
  const bridge = new ClaudeBridge(null, "bridge-question-decline");
  const client = fakeClient();
  bridge.clients.add(client);
  try {
    const socketPath = await bridge.ensureApprovalServer();
    const pending = connectAndAsk(socketPath, {
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "どちらにしますか？", header: "方針", options: [{ label: "A" }] }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const [approval] = client.messagesOfType("approval");

    bridge.approval(approval.request, "decline");

    const reply = await pending;
    assert.equal(reply.decision, "decline");
    assert.match(reply.message, /前提を明示/);
  } finally {
    bridge.closeApprovalServer();
  }
});
