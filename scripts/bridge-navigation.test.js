const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");
const air = { id: "air", baseUrl: "https://air.example:8443/proxy/45214", token: "air-key+/=\\n" };

function harness() {
  const context = vm.createContext({
    URL, URLSearchParams,
    location: new URL("https://mini.example:8444/"),
    activeBridge: () => air,
    effectiveBridgeToken: entry => entry.token || "",
    currentThreadProvider: () => "codex",
    getBridgeState: () => ({ threadProvider: "codex", activeProvider: "claude" }),
    normalizeProviderName: value => ["codex", "claude", "gemini"].includes(value) ? value : "",
    appPath: value => value,
    homeBridgeBaseUrl: () => "https://mini.example:8444",
    token: "mini-key",
    preserveEntryUrl: false,
  });
  // Exercise the navigation implementation without loading a real account.
  vm.runInContext(source.slice(source.indexOf("function bridgeAbsoluteUrl("), source.indexOf("function base64UrlEncode(")), context);
  vm.runInContext(source.slice(source.indexOf("function installEntryUrl("), source.indexOf("function rememberTokenForCurrentOrigin(")), context);
  vm.runInContext(source.slice(source.indexOf("function tokenMissingMessage("), source.indexOf("function renderTokenRecoveryForm(")), context);
  return context;
}

test("a separate tab receives only the destination key, in a removable fragment", () => {
  const context = harness();
  assert.equal(typeof context.bridgeNavigationUrl, "function");
  const url = new URL(context.bridgeNavigationUrl(air));
  assert.equal(url.origin, "https://air.example:8443");
  assert.equal(url.pathname, "/proxy/45214/");
  assert.equal(url.searchParams.get("provider"), "codex");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), air.token);
  assert.equal(url.href.includes("mini-key"), false);
  assert.match(source, /window\.open\(bridgeNavigationUrl\(entry\), "_blank", "noopener"\)/);
  assert.equal(new URL(context.urlWithBridgeToken("/api/session", air)).hash, "", "API URLs stay credential-free");
});

test("the install link belongs to the active machine and selected provider", () => {
  const url = new URL(harness().installEntryUrl());
  assert.equal(url.origin, "https://air.example:8443");
  assert.equal(url.pathname, "/proxy/45214/install");
  assert.equal(url.searchParams.get("provider"), "codex");
  assert.equal(url.searchParams.get("token"), air.token, "the existing protected install manifest needs the destination key");
});

test("a missing destination key never borrows the source machine key", () => {
  const context = harness();
  assert.equal(typeof context.bridgeNavigationUrl, "function");
  const destination = { ...air, token: "" };
  const url = new URL(context.bridgeNavigationUrl(destination));
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.has("token"), false);
  context.activeBridge = () => destination;
  assert.equal(new URL(context.installEntryUrl()).searchParams.has("token"), false);
});

test("missing authentication never tells the owner to restart a healthy server", () => {
  const context = harness();
  for (const install of [false, true]) {
    context.preserveEntryUrl = install;
    assert.doesNotMatch(context.tokenMissingMessage(), /npm run|PC 側|再実行|再起動/);
    assert.match(context.tokenMissingMessage(), /接続キー/);
  }
});
