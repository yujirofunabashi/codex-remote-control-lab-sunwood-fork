const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { inspectServer, localEndpoint, serverVersion } = require("./codex-runtime-version");

async function withServer(reply, inspect) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages = [];
  server.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    if (message.method === "initialize") socket.send(JSON.stringify(reply(message)));
  }));
  try {
    await inspect(`ws://127.0.0.1:${server.address().port}`, messages);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

test("runtime inspection reports an older running server without changing it", async () => {
  await withServer(message => ({ id: message.id, result: {
    userAgent: "codex_cli_rs/0.153.4 (Mac OS 26; arm64)", codexHome: "/synthetic-private-home",
  } }), async (url, messages) => {
    const result = await inspectServer(url);
    assert.equal(result.source, "running_app_server");
    assert.equal(result.version, "0.153.4");
    assert.equal(result.versionConfirmed, true);
    assert.equal(JSON.stringify(result).includes("synthetic-private-home"), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(messages.some(message => message.method === "initialize"));
    assert.ok(messages.every(message => ["initialize", "initialized"].includes(message.method)));
  });
});

test("runtime inspection recognizes the existing phone bridge API identity", async () => {
  await withServer(message => ({ id: message.id, result: {
    userAgent: "codex-phone-bridge-api/0.153.4 (Mac OS 26.6.2; arm64) codex-runtime-version/0.1.0",
  } }), async url => {
    const result = await inspectServer(url);
    assert.equal(result.version, "0.153.4");
    assert.equal(result.versionConfirmed, true);
  });
});

test("runtime version must follow an exact recognized leading identity", () => {
  for (const userAgent of [
    "unknown/0.153.4 (Mac OS 26.6.2; arm64) codex-runtime-version/0.1.0",
    "codex-phone-bridge-api (Mac OS 26.6.2; arm64) codex-runtime-version/0.1.0",
    "codex-phone-bridge-api-test/0.153.4 (Mac OS 26.6.2; arm64)",
    "Mac OS 26.6.2; codex-phone-bridge-api/0.153.4",
  ]) {
    assert.equal(serverVersion(userAgent), null);
  }
});

test("an unknown server identity stays unverified instead of borrowing the dependency version", async () => {
  await withServer(message => ({ id: message.id, result: { userAgent: "unknown/0.154.0" } }), async url => {
    const result = await inspectServer(url);
    assert.equal(result.version, null);
    assert.equal(result.versionConfirmed, false);
  });
});

test("initialization errors do not echo server-provided private data", async () => {
  await withServer(message => ({ id: message.id, error: { message: "synthetic-private-error" } }), async url => {
    await assert.rejects(inspectServer(url), error => !error.message.includes("synthetic-private-error"));
  });
});

test("runtime inspection requires the explicit loopback endpoint and rejects URL credentials", () => {
  assert.equal(localEndpoint("ws://127.0.0.1:45213"), "ws://127.0.0.1:45213/");
  for (const value of [undefined, "ws://192.0.2.2:45213", "ws://localhost", "http://localhost:45213",
    "ws://sample:synthetic-secret@localhost:45213", "ws://localhost:45213/?token=synthetic-secret"]) {
    assert.throws(() => localEndpoint(value));
  }
  assert.equal(serverVersion("codex_cli_rs/0.154.0 (Mac OS 26; arm64)"), "0.154.0");
  // The native 0.154.0 initialization response uses our client name and its
  // own runtime version, independently of clientInfo.version (0.1.0).
  assert.equal(serverVersion("codex-runtime-version/0.154.0 (Mac OS 26; arm64)"), "0.154.0");
  assert.equal(serverVersion("synthetic-private-text"), null);
});

test("local version inspection cannot fall back to a global Codex executable", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(config.scripts["version:codex"], "node node_modules/@openai/codex/bin/codex.js --version");
});
