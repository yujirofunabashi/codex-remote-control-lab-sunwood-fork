// Inspect an existing app-server without creating/resuming a thread or running AI.
const WebSocket = require("ws");

function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Specify an explicit loopback WebSocket URL"); }
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Use the bridge's loopback app-server URL with an explicit port and no credentials");
  }
  return url.toString();
}

function serverVersion(userAgent) {
  if (typeof userAgent !== "string") return null;
  // Do not substitute the installed dependency or the client's version when
  // the server does not report a recognized Codex runtime identity.
  const match = userAgent.match(/^(?:codex-runtime-version|codex_cli_rs|codex-cli|codex)\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/);
  return match ? match[1] : null;
}

function inspectServer(value, { timeoutMs = 5000 } = {}) {
  const endpoint = localEndpoint(value);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) socket.terminate();
      else socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Codex server version was not received before timeout")), timeoutMs);
    socket.on("open", () => socket.send(JSON.stringify({
      id: "runtime-version", method: "initialize",
      params: { clientInfo: { name: "codex-runtime-version", title: "Codex Runtime Version", version: "0.1.0" } },
    })));
    socket.on("message", data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { finish(new Error("Invalid Codex initialization response")); return; }
      if (message?.id !== "runtime-version") return;
      if (message.error || !message.result) { finish(new Error("Codex server initialization was rejected")); return; }
      const version = serverVersion(message.result.userAgent);
      // Do not print raw userAgent, codexHome, errors, notifications or auth data.
      const result = { source: "running_app_server", endpoint, connected: true, version, versionConfirmed: Boolean(version) };
      socket.send(JSON.stringify({ method: "initialized", params: {} }), error => {
        finish(error ? new Error("Codex initialization acknowledgement failed") : null, result);
      });
    });
    socket.on("error", () => finish(new Error("Cannot connect to the specified Codex app-server")));
    socket.on("close", () => {
      if (!finished) finish(new Error("Codex app-server closed before reporting its version"));
    });
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 1) throw new Error("Usage: npm run version:codex:server -- ws://127.0.0.1:PORT");
    return inspectServer(args[0]);
  }).then(result => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.versionConfirmed) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ source: "running_app_server", versionConfirmed: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { inspectServer, localEndpoint, serverVersion };
