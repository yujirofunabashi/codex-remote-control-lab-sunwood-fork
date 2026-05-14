const test = require("node:test");
const assert = require("node:assert/strict");

const { manifestHrefForRequest, manifestPayloadForRequest, safeProxyBasePath } = require("./start-phone");

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
