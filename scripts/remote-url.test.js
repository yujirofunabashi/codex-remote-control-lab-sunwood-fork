const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUrl, isMeshAddress, maskUrl } = require("./remote-url");

test("tailscale CGNAT addresses are recognised, ordinary 100.x ones are not", () => {
  assert.ok(isMeshAddress("100.64.0.1"));
  assert.ok(isMeshAddress("100.101.102.103"));
  assert.ok(isMeshAddress("100.127.255.254"));

  // 100.0.0.0/8 outside the CGNAT block is ordinary routable space.
  assert.ok(!isMeshAddress("100.63.255.255"));
  assert.ok(!isMeshAddress("100.128.0.1"));
  assert.ok(!isMeshAddress("192.168.11.8"));
});

test("the assembled URL matches what the bridge prints", () => {
  assert.equal(buildUrl("100.101.102.103", 45214, "abc123"), "http://100.101.102.103:45214/?token=abc123");
  assert.equal(buildUrl("mac.tailnet.ts.net", 45217, "abc123"), "http://mac.tailnet.ts.net:45217/?token=abc123");
});

test("a URL with no token is still well formed", () => {
  assert.equal(buildUrl("100.101.102.103", 45214, ""), "http://100.101.102.103:45214/");
});

test("masking keeps enough to recognise the token but not enough to use it", () => {
  const masked = maskUrl("http://100.64.0.1:45214/?token=SuperSecretTokenValue");

  assert.ok(!masked.includes("SuperSecretTokenValue"));
  assert.ok(masked.includes("Sup"));
  assert.ok(masked.includes("lue"));
  assert.ok(masked.includes("*"));
});

test("a short token is masked completely rather than mostly revealed", () => {
  const masked = maskUrl("http://100.64.0.1:45214/?token=abcd");

  assert.ok(!masked.includes("abcd"));
  assert.match(masked, /token=\*{4}$/);
});

test("masking leaves a tokenless URL alone", () => {
  const url = "http://100.64.0.1:45214/";
  assert.equal(maskUrl(url), url);
});
