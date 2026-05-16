const test = require("node:test");
const assert = require("node:assert/strict");

const { manifestHrefForRequest, manifestPayloadForRequest, maskTokenValue, requestTokenFromHeaders, safeProxyBasePath, tokenMetadata } = require("./start-phone");
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
