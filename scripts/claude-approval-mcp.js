// Minimal stdio MCP server exposing a single permission-prompt tool.
//
// Claude Code spawns this as its own child, so it never binds a port: several
// phone bridges can run side by side without colliding. Each tool call opens a
// short-lived connection to the bridge that spawned it, over the Unix socket
// named by PHONE_APPROVAL_SOCKET, and waits for the operator's decision.
//
// Fails closed: any transport problem denies the tool call rather than
// silently letting it through.
const net = require("net");

const socketPath = process.env.PHONE_APPROVAL_SOCKET || "";
const requestTimeoutMs = Number(process.env.PHONE_APPROVAL_TIMEOUT_MS || 300000);
const serverName = process.env.PHONE_APPROVAL_SERVER_NAME || "phone_approval";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// `AskUserQuestion` has no interactive surface under `claude -p`: allowed as-is
// it comes straight back with "The user did not answer the questions." and the
// turn carries on having asked into the void. Its schema calls `answers` the
// field the permission component fills in, so the operator's choices ride back
// on the allow as part of the tool's own input.
function allowPayload(input, answers) {
  const updatedInput = { ...(input || {}) };
  if (answers && typeof answers === "object" && Object.keys(answers).length) updatedInput.answers = answers;
  return { behavior: "allow", updatedInput };
}

function denyPayload(message) {
  return { behavior: "deny", message: message || "ブラウザから拒否されました。" };
}

function toolResult(id, payload) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
}

function askBridge(request) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve(denyPayload("承認ソケットが設定されていないため拒否しました。"));
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish(denyPayload("承認がタイムアウトしました。"));
    }, requestTimeoutMs);

    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", (error) => finish(denyPayload(`承認ブリッジに接続できませんでした: ${error.message}`)));
    socket.on("close", () => finish(denyPayload("承認ブリッジとの接続が閉じました。")));

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let reply;
      try {
        reply = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(denyPayload(`承認応答を解釈できませんでした: ${error.message}`));
        return;
      }
      finish(reply.decision === "accept" ? allowPayload(request.input, reply.answers) : denyPayload(reply.message));
    });
  });
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "0.1.0" },
      },
    });
    return;
  }

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "approve",
            description: "Ask the phone bridge operator whether a tool call may proceed.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string", description: "Tool Claude wants to run." },
                input: { type: "object", description: "Arguments Claude wants to pass." },
                tool_use_id: { type: "string", description: "Identifier of the pending tool call." },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const args = msg.params?.arguments || {};
    askBridge({
      toolName: args.tool_name || "unknown",
      input: args.input || {},
      toolUseId: args.tool_use_id || msg.params?._meta?.["claudecode/toolUseId"] || null,
    })
      .then((payload) => toolResult(msg.id, payload))
      .catch((error) => toolResult(msg.id, denyPayload(`承認処理に失敗しました: ${error.message}`)));
    return;
  }

  // Requests we do not implement still need a reply so the client does not stall.
  if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

module.exports = { allowPayload, denyPayload };
