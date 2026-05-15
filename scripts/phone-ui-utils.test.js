const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capTerminalHistory,
  bridgeIdFromBaseUrl,
  bridgeThreadKey,
  compactWorkspacePath,
  contrastColorFor,
  fallbackThreadColor,
  keyIntentText,
  maskToken,
  middleEllipsis,
  normalizeBridgeBaseUrl,
  normalizeBridgeEntry,
  normalizeTerminalEntry,
  parseBridgeUrl,
  pwaManifestTokenIssues,
  redactSensitiveText,
  removeBridgeFromRegistry,
  safeJsonParse,
  sameWorkspaceThreadRecord,
  sanitizeHexColor,
  serviceWorkerRegistrationAllowed,
  shouldConfirmDangerousKey,
  shouldShowQuickBar,
  isStandaloneDisplayMode,
  terminalCompactState,
  effectiveAppViewportHeight,
  upsertBridgeRegistry,
  visualViewportVars,
  visibleTerminalEntries,
  workspaceKeyForThreadRecord,
} = require("../public/phone-ui-utils");

test("thread colors sanitize, fall back, and choose readable contrast", () => {
  assert.equal(sanitizeHexColor("#abc"), "#aabbcc");
  assert.equal(sanitizeHexColor("bad"), "");
  assert.equal(fallbackThreadColor("codex:thread:123"), fallbackThreadColor("codex:thread:123"));
  assert.equal(contrastColorFor("#ffffff"), "#141414");
  assert.equal(contrastColorFor("#0b1115"), "#ffffff");
});

test("safeJsonParse returns fallback for broken storage values", () => {
  assert.deepEqual(safeJsonParse("{broken", { ok: false }, { objectOnly: true }), { ok: false });
  assert.deepEqual(safeJsonParse("[1,2]", { ok: false }, { objectOnly: true }), { ok: false });
  assert.deepEqual(safeJsonParse('{"ok":true}', { ok: false }, { objectOnly: true }), { ok: true });
});

test("compactWorkspacePath middle-truncates long mobile paths", () => {
  assert.equal(
    compactWorkspacePath("/Users/minijiro/Developer/ZG_PROJECT/codex-remote-control-lab", { keepStart: 1, keepEnd: 1 }),
    "~/Developer/.../codex-remote-control-lab",
  );
  assert.equal(middleEllipsis("codex-remote-control-lab-sunwood-fork", { max: 18 }), "codex-rem...d-fork");
});

test("workspace helpers keep thread switching scoped to one worktree", () => {
  const base = workspaceKeyForThreadRecord({ cwd: "/Users/minijiro/work/app/" });
  assert.equal(base, "/Users/minijiro/work/app");
  assert.equal(sameWorkspaceThreadRecord({ cwd: "/Users/minijiro/work/app" }, base), true);
  assert.equal(sameWorkspaceThreadRecord({ cwd: "/Users/minijiro/work/other" }, base), false);
  assert.equal(sameWorkspaceThreadRecord({ id: "legacy-without-cwd" }, base), true);
});

test("terminal event normalization, filtering, search, and cap are stable", () => {
  const entries = [
    normalizeTerminalEntry({ ts: 1, kind: "command", message: "$ npm test" }),
    normalizeTerminalEntry({ ts: 2, kind: "file", message: "file changes: public/main.js" }),
    normalizeTerminalEntry({ ts: 3, kind: "approval", message: "approval requested" }),
    normalizeTerminalEntry({ ts: 4, kind: "error", message: "failed" }),
  ];

  assert.deepEqual(
    visibleTerminalEntries(entries, { filter: "file" }).map((entry) => entry.kind),
    ["file"],
  );
  assert.deepEqual(
    visibleTerminalEntries(entries, { filter: "approval" }).map((entry) => entry.kind),
    ["approval"],
  );
  assert.equal(visibleTerminalEntries(entries, { filter: "all", query: "npm" }).length, 1);
  assert.equal(capTerminalHistory(Array.from({ length: 320 }, (_, index) => ({ index }))).length, 300);
});

test("dangerous key confirm and command-template key stay safe", () => {
  assert.equal(shouldConfirmDangerousKey("Ctrl+C"), true);
  assert.equal(shouldConfirmDangerousKey("Tab"), false);
  assert.match(keyIntentText("$"), /安全に実行/);
});

test("viewport, standalone, compact mode, and quickbar helpers are stable", () => {
  assert.equal(isStandaloneDisplayMode({ matchMedia: () => ({ matches: true }), navigator: {} }), true);
  assert.deepEqual(visualViewportVars({ innerHeight: 800, visualViewport: { height: 620, offsetTop: 0 } }), {
    visualViewportHeight: 620,
    visualViewportOffsetTop: 0,
    keyboardInset: 180,
  });
  assert.equal(
    effectiveAppViewportHeight(
      { innerHeight: 800, visualViewport: { height: 620, offsetTop: 0 } },
      { standalone: false },
    ),
    800,
  );
  assert.equal(
    effectiveAppViewportHeight(
      { innerHeight: 800, visualViewport: { height: 620, offsetTop: 0 } },
      { standalone: true },
    ),
    620,
  );
  assert.deepEqual(terminalCompactState({ mainViewMode: "terminal", width: 390, maxMode: true }).max, true);
  assert.equal(shouldShowQuickBar({ mainViewMode: "terminal", inputFocused: false, inputMode: "keys" }), true);
  assert.equal(shouldShowQuickBar({ mainViewMode: "chat", inputFocused: true, inputMode: "keys" }), false);
});

test("PWA helpers keep manifest and service worker opt-in safe", () => {
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: false, secureContext: true }), false);
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: true, secureContext: false }), false);
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: true, secureContext: true }), true);
  assert.deepEqual(pwaManifestTokenIssues({ start_url: "/?token=secret", name: "Codex" }).hasTokenParam, true);
  assert.deepEqual(pwaManifestTokenIssues({ start_url: "/", description: "token-protected bridge" }).hasTokenParam, false);
});

test("redactSensitiveText masks bridge tokens and auth-like secrets", () => {
  const redacted = redactSensitiveText("http://x/?token=secret123456 PHONE_TOKEN=abcdef123456 token: abcdef1234567890 authorization: Bearer abcdef1234567890");
  assert.doesNotMatch(redacted, /secret123456|abcdef1234567890/);
  assert.match(redacted, /\[redacted\]/);
});

test("bridge URL helpers parse tokenized URLs and host port token lines", () => {
  assert.equal(normalizeBridgeBaseUrl("http://192.168.1.20:45224/?token=secret"), "http://192.168.1.20:45224");
  assert.deepEqual(parseBridgeUrl("http://192.168.1.20:45224/?token=secret").token, "secret");
  assert.deepEqual(parseBridgeUrl("http://192.168.1.20:45224/?key=secret").token, "secret");
  assert.deepEqual(parseBridgeUrl("192.168.1.20 45234 tok123").baseUrl, "http://192.168.1.20:45234");
  assert.equal(maskToken("secret123456"), "sec...456");
  assert.equal(maskToken("http://x/?token=secret123456"), "http://x/?token=sec...456");
});

test("bridge registry helpers dedupe by base URL and keep thread keys bridge scoped", () => {
  const first = normalizeBridgeEntry({ baseUrl: "http://127.0.0.1:45214/?token=a", label: "A", token: "a" }, { now: 1 });
  const second = normalizeBridgeEntry({ baseUrl: "http://127.0.0.1:45214", label: "A2", token: "b" }, { now: 2 });
  assert.equal(first.id, bridgeIdFromBaseUrl("http://127.0.0.1:45214"));
  let registry = upsertBridgeRegistry({ version: 1, bridges: [] }, first);
  registry = upsertBridgeRegistry(registry, second);
  assert.equal(registry.bridges.length, 1);
  assert.equal(registry.bridges[0].label, "A2");
  assert.equal(registry.bridges[0].token, "b");
  assert.equal(bridgeThreadKey(first.id, "thread-123"), `${first.id}::thread-123`);
  assert.equal(removeBridgeFromRegistry(registry, first.id).bridges.length, 0);
});
