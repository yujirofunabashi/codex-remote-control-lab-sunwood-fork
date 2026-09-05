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

test("normal manifest href and start_url never include bridge token", () => {
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

test("authenticated install manifest seeds the isolated Home Screen app with a fragment token", () => {
  const token = "secret123";
  const req = {
    url: `/install?token=${token}&base=/proxy/45214`,
    headers: { host: "127.0.0.1:45214" },
  };
  const href = manifestHrefForRequest(req, token);
  const manifestUrl = new URL(href, "http://127.0.0.1:45214/install");
  assert.equal(manifestUrl.searchParams.get("install"), "1");
  assert.equal(manifestUrl.searchParams.get("token"), token);

  const manifest = manifestPayloadForRequest(manifestUrl, token);
  assert.match(manifest.id, /^\/proxy\/45214\/codex-remote-[a-z0-9-]+$/);
  assert.doesNotMatch(manifest.id, /secret123|[?&]token=/);
  assert.equal(manifest.start_url, `/proxy/45214/install#token=${token}`);
  assert.doesNotMatch(manifest.start_url, /[?&]token=/);
});

test("an invalid install manifest request cannot create a credential-bearing start_url", () => {
  const url = new URL("http://127.0.0.1:45214/site.webmanifest?install=1&token=wrong");
  const manifest = manifestPayloadForRequest(url, "secret123");
  assert.equal(manifest.start_url, "/");
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

const { serveIndex } = require("./start-phone");

function fakeResponse() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers || {};
  };
  res.end = (chunk) => {
    res.body += chunk || "";
  };
  return res;
}

test("an explicit provider on the install page makes an icon for that provider", () => {
  const token = "secret123";
  for (const provider of ["codex", "claude"]) {
    const req = { url: `/install?token=${token}&provider=${provider}`, headers: { host: "127.0.0.1:45214" } };
    const manifestUrl = new URL(manifestHrefForRequest(req, token), "http://127.0.0.1:45214/install");
    assert.equal(manifestUrl.searchParams.get("provider"), provider);

    const manifest = manifestPayloadForRequest(manifestUrl, token);
    assert.equal(manifest.start_url, `/install?provider=${provider}#token=${token}`);
    assert.doesNotMatch(manifest.start_url, /[?&]token=/);
    assert.match(manifest.name, provider === "codex" ? /^Codex Remote / : /^Claude Remote /);
    assert.match(manifest.short_name, provider === "codex" ? /^Codex / : /^Claude /);
    assert.match(manifest.id, new RegExp(`/codex-remote-${provider}-\\d+$`));
    assert.match(manifest.description, new RegExp(`\\(${provider}:`));
    assert.ok(manifest.icons.length >= 2);
    for (const icon of manifest.icons) assert.match(icon.src, new RegExp(provider));
  }
});

test("an unknown provider on the install page is ignored", () => {
  const token = "secret123";
  const req = { url: `/install?token=${token}&provider=gemini`, headers: { host: "127.0.0.1:45214" } };
  const href = manifestHrefForRequest(req, token);
  assert.doesNotMatch(href, /provider=/);
  const manifest = manifestPayloadForRequest(new URL(href, "http://127.0.0.1:45214/install"), token);
  assert.equal(manifest.start_url, `/install#token=${token}`);
});

test("the install page carries the requested provider's icon, name and manifest", () => {
  const token = "secret123";
  const res = fakeResponse();
  serveIndex(
    { url: `/install?token=${token}&provider=codex`, headers: { host: "127.0.0.1:45214" } },
    res,
    { includeManifest: true, standalone: true, phoneToken: token },
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>Codex Remote [^<]+<\/title>/);
  assert.match(res.body, /<meta name="apple-mobile-web-app-title" content="Codex [^"]+" \/>/);
  assert.match(res.body, /<link rel="apple-touch-icon" sizes="180x180" href="[^"]*codex[^"]*" \/>/);
  assert.match(res.body, /<link rel="manifest" href="site\.webmanifest\?[^"]*provider=codex[^"]*" \/>/);

  const plain = fakeResponse();
  serveIndex({ url: `/install?token=${token}`, headers: { host: "127.0.0.1:45214" } }, plain, {
    includeManifest: true,
    standalone: true,
    phoneToken: token,
  });
  assert.equal(plain.statusCode, 200);
  // The page markup names providers of its own (the list switch), so only the
  // manifest link and the icon are checked for the parameter.
  assert.doesNotMatch(plain.body, /site\.webmanifest\?[^"]*provider=/);
  assert.doesNotMatch(plain.body, /<title>Codex /);
});
