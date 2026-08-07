const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bookmarkIconFiles,
  bridgeIconVariant,
  machineLabelForEnvironment,
  manifestHrefForRequest,
  manifestPayloadForRequest,
  maskTokenValue,
  requestTokenFromHeaders,
  safeProxyBasePath,
  tokenMetadata,
} = require("./start-phone");
const fs = require("node:fs");
const path = require("node:path");

test("manifest href and start_url never include bridge token", () => {
  const req = {
    url: "/?token=secret123&base=/proxy/45214",
    headers: { host: "127.0.0.1:45214" },
  };
  const href = manifestHrefForRequest(req, "secret123");
  assert.equal(href, "site.webmanifest?base=%2Fproxy%2F45214");
  assert.doesNotMatch(href, /token|secret123/);

  const manifest = manifestPayloadForRequest(new URL("http://127.0.0.1:45214/site.webmanifest?token=secret123&base=/proxy/45214"));
  assert.equal(manifest.start_url, "/proxy/45214/");
  assert.doesNotMatch(JSON.stringify(manifest), /secret123|[?&]token=/);
});

test("manifest proxy base is constrained to browser preview proxy paths", () => {
  assert.equal(safeProxyBasePath("/proxy/45214"), "/proxy/45214");
  assert.equal(safeProxyBasePath("/absproxy/45214"), "/absproxy/45214");
  assert.equal(safeProxyBasePath("/api/file/raw"), "");
});

test("bridge icons distinguish provider and machine identity", () => {
  assert.equal(machineLabelForEnvironment("", "minijironoMac-mini.local"), "minijironoMac-mini.local");
  assert.equal(machineLabelForEnvironment("", "MacBook-Air.local"), "MacBook-Air.local");
  assert.equal(machineLabelForEnvironment("Configured label", "ignored-host.local"), "Configured label");
  assert.equal(
    bridgeIconVariant({ provider: "claude", machineLabel: machineLabelForEnvironment("", "minijironoMac-mini.local") }),
    "mini",
  );
  assert.equal(
    bridgeIconVariant({ provider: "claude", machineLabel: machineLabelForEnvironment("", "MacBook-Air.local") }),
    "air",
  );
  assert.equal(bridgeIconVariant({ provider: "codex", appName: "AIRCodex 46214" }), "air");
  assert.equal(bridgeIconVariant({ provider: "codex", appName: "miniCodex 45224" }), "mini");
  assert.equal(bridgeIconVariant({ provider: "claude", appName: "Claude mini" }), "mini");
  assert.equal(bridgeIconVariant({ provider: "claude", appName: "Claude 8443 AIR" }), "air");
  assert.equal(bridgeIconVariant({ provider: "codex", appName: "WindowsCodex" }), "windows");
  assert.equal(bridgeIconVariant({ provider: "codex", appName: "Codex" }), "default");

  assert.deepEqual(bookmarkIconFiles({ provider: "codex", machineLabel: "MacBook Air" }), {
    icon180: "bridge-icons/codex-air-180.png",
    icon512: "bridge-icons/codex-air-512.png",
  });
  assert.deepEqual(bookmarkIconFiles({ provider: "claude", machineLabel: "Mac mini" }), {
    icon180: "bridge-icons/claude-mini-180.png",
    icon512: "bridge-icons/claude-mini-512.png",
  });
  assert.deepEqual(bookmarkIconFiles({ provider: "claude", machineLabel: "Windows" }), {
    icon180: "bookmark-claude.png",
    icon512: "bookmark-claude-512.png",
  });

  const iconCases = [
    { provider: "codex", appName: "Codex" },
    { provider: "codex", appName: "AIRCodex 46214" },
    { provider: "codex", appName: "miniCodex 45224" },
    { provider: "codex", appName: "WindowsCodex" },
    { provider: "claude", appName: "Claude mini" },
    { provider: "claude", appName: "Claude 8443 AIR" },
  ];
  for (const iconCase of iconCases) {
    const files = bookmarkIconFiles(iconCase);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", files.icon180)), files.icon180);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", files.icon512)), files.icon512);
  }
});

test("auth metadata and header helpers do not expose full token", () => {
  const token = "secret-token-123456";
  const metadata = tokenMetadata(token);
  assert.equal(metadata.present, true);
  assert.equal(metadata.masked, "secr…3456");
  assert.doesNotMatch(JSON.stringify(metadata), /secret-token-123456/);
  assert.equal(maskTokenValue(token), "secr…3456");
  assert.equal(requestTokenFromHeaders({ authorization: `Bearer ${token}` }), token);
});

test("service worker avoids caching tokenized API and bridge traffic", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "service-worker.js"), "utf8");
  assert.match(source, /CACHE_NAME/);
  assert.match(source, /searchParams\.has\("token"\)/);
  assert.match(source, /searchParams\.has\("key"\)/);
  assert.match(source, /appPath\.startsWith\("\/api\/"\)/);
  assert.match(source, /proxy/);
  assert.match(source, /appPath === "\/bridge"/);
});
