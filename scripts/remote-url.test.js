const test = require("node:test");
const assert = require("node:assert/strict");

const { buildUrl, isMeshAddress, maskUrl, servedHttpsEndpoint } = require("./remote-url");

// What `tailscale serve status --json` reports for a machine serving something
// else on 443 and this bridge on 8443.
const serveStatus = {
  TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
  Web: {
    "mac.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
    "mac.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:45214" } } },
  },
};

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

test("an HTTPS URL keeps the token and drops the port only when it is the default", () => {
  assert.equal(buildUrl("mac.tailnet.ts.net", 8443, "abc123", "https"), "https://mac.tailnet.ts.net:8443/?token=abc123");
  assert.equal(buildUrl("mac.tailnet.ts.net", 443, "abc123", "https"), "https://mac.tailnet.ts.net/?token=abc123");
});

test("the published address is the one whose root proxies to this bridge", () => {
  // The site on 443 leads somewhere else on the same machine. Handing it over
  // would send the phone to another app under this bridge's token.
  assert.deepEqual(servedHttpsEndpoint(serveStatus, 45214), { host: "mac.tailnet.ts.net", port: 8443 });
});

test("a bridge nobody publishes has no address to hand over", () => {
  assert.equal(servedHttpsEndpoint(serveStatus, 46214), null);
  assert.equal(servedHttpsEndpoint({}, 45214), null);
  assert.equal(servedHttpsEndpoint(null, 45214), null);
});

test("a site served without TLS is not offered as an HTTPS address", () => {
  // Plain HTTP over the tailnet is what reaching the bridge by address already
  // gives, and calling it https would just fail to connect.
  const plain = {
    TCP: { 8080: { HTTPS: false } },
    Web: { "mac.tailnet.ts.net:8080": { Handlers: { "/": { Proxy: "http://127.0.0.1:45214" } } } },
  };
  assert.equal(servedHttpsEndpoint(plain, 45214), null);
});

test("a bridge published under a path is not mistaken for one at the root", () => {
  // The bridge serves from the root; mounted under a path its own links would
  // miss, so this is not an address it can be reached at.
  const nested = {
    TCP: { 443: { HTTPS: true } },
    Web: { "mac.tailnet.ts.net:443": { Handlers: { "/phone": { Proxy: "http://127.0.0.1:45214" } } } },
  };
  assert.equal(servedHttpsEndpoint(nested, 45214), null);
});

test("with more than one published address the shortest is handed over", () => {
  const both = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      "mac.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:45214" } } },
      "mac.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:45214" } } },
    },
  };
  assert.equal(servedHttpsEndpoint(both, 45214).port, 443);
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
