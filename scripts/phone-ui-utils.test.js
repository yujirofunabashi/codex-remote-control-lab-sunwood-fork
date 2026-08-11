const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capTerminalHistory,
  clickClosesBridgeFleet,
  completesSidebarEdgeSwipe,
  isPlaceholderBridgeLabel,
  startsSidebarEdgeSwipe,
  sidebarEdgeSwipeZone,
  machineLabelFromHost,
  machineLabelForBridge,
  machineScopeKey,
  machineScopeCount,
  machineAccentToken,
  threadProjectGroupKey,
  shortHostLabel,
  isMarkdownTableStart,
  parseMarkdownTable,
  splitMarkdownTableRow,
  bridgeIdFromBaseUrl,
  bridgeThreadKey,
  compactWorkspacePath,
  contrastColorFor,
  deriveThreadStatus,
  fallbackThreadColor,
  keyIntentText,
  limitThreadList,
  loadThreadsAfterProviderSync,
  maskToken,
  middleEllipsis,
  normalizeBridgeBaseUrl,
  normalizeBridgeEntry,
  normalizeTerminalEntry,
  parseBridgeUrl,
  prioritizeSelectedThread,
  pwaManifestTokenIssues,
  redactSensitiveText,
  removeBridgeFromRegistry,
  mergeBridgeRegistries,
  mergeBridgeTokens,
  resumeCommandForThread,
  safeJsonParse,
  sameWorkspaceThreadRecord,
  sanitizeHexColor,
  serviceWorkerRegistrationAllowed,
  shouldReloadInstallWithStoredToken,
  shouldConfirmDangerousKey,
  shouldShowQuickBar,
  sortThreadsForInbox,
  isStandaloneDisplayMode,
  threadDisplayTitle,
  threadTimestamp,
  terminalCompactState,
  timestampValueMs,
  effectiveAppViewportHeight,
  upsertBridgeRegistry,
  urlWithoutTokenParam,
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

test("thread timestamp helpers parse ISO, seconds, and millisecond fields", () => {
  const iso = "2026-05-16T00:00:00.000Z";
  assert.equal(timestampValueMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(threadTimestamp({ updated_at_ms: 1234 }), 1234);
  assert.equal(threadTimestamp({ updated_at: iso }), Date.parse(iso));
  assert.deepEqual(
    sortThreadsForInbox([
      { id: "old", updated_at: "2026-05-15T00:00:00.000Z" },
      { id: "new", updated_at: iso },
    ]).map((thread) => thread.id),
    ["new", "old"],
  );
});

test("sortThreadsForInbox promotes recently viewed local threads without changing updatedAt", () => {
  assert.deepEqual(
    sortThreadsForInbox([
      { id: "stale-but-opened", updatedAt: 1000, lastViewedAt: 9000, runState: "done" },
      { id: "newer-remote", updatedAt: 8000 },
    ]).map((thread) => thread.id),
    ["stale-but-opened", "newer-remote"],
  );
});

test("threadDisplayTitle provides one title source for inbox and selected thread header", () => {
  const opaqueId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(threadDisplayTitle({ id: "t0", displayTitle: "Live ready title", name: "Stale list title" }), "Live ready title");
  assert.equal(threadDisplayTitle({ id: "t1", name: "Readable title", preview: "Prompt text" }), "Readable title");
  assert.equal(threadDisplayTitle({ id: "t2", preview: "First line\nsecond line" }), "First line");
  assert.equal(threadDisplayTitle({ id: opaqueId, name: opaqueId }), "名前未設定のチャット");
  assert.equal(threadDisplayTitle({ id: "t3", name: "" }), "名前未設定のチャット");
  assert.equal(threadDisplayTitle({ id: "t4", name: "abcdefghijklmnopqrstuvwxyz", preview: "ignored" }, { max: 14 }), "abcdefghijklmn...");
});

test("prioritizeSelectedThread keeps the active thread visible at the top of a limited list", () => {
  const threads = [{ id: "oldest" }, { id: "older" }, { id: "current" }, { id: "newer" }];
  assert.deepEqual(
    prioritizeSelectedThread(threads, "current", 3).map((thread) => thread.id),
    ["current", "oldest", "older"],
  );
  assert.deepEqual(
    prioritizeSelectedThread(threads, "missing", 3).map((thread) => thread.id),
    ["oldest", "older", "current"],
  );
});

test("limitThreadList keeps the drawer list stable across thread selection", () => {
  const threads = ["t1", "t2", "t3", "t4", "t5", "t6", "selected"].map((id) => ({ id }));
  assert.deepEqual(
    limitThreadList(threads, 6).map((thread) => thread.id),
    ["t1", "t2", "t3", "t4", "t5", "t6"],
  );
  assert.deepEqual(limitThreadList(threads, 0), []);
  assert.deepEqual(limitThreadList(null, 6), []);
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
  assert.equal(workspaceKeyForThreadRecord(null, "/Users/minijiro/work/app/"), "/Users/minijiro/work/app");
  assert.equal(sameWorkspaceThreadRecord({ cwd: "/Users/minijiro/work/app" }, base), true);
  assert.equal(sameWorkspaceThreadRecord({ cwd: "/Users/minijiro/work/other" }, base), false);
  assert.equal(sameWorkspaceThreadRecord({ id: "legacy-without-cwd" }, base), true);
});

test("terminal event normalization, filtering, search, and cap are stable", () => {
  const entries = [
    normalizeTerminalEntry({ ts: 1, kind: "command", message: "$ npm test", source: "manual" }),
    normalizeTerminalEntry({ ts: 2, kind: "file", message: "file changes: public/main.js" }),
    normalizeTerminalEntry({ ts: 3, kind: "approval", message: "approval requested" }),
    normalizeTerminalEntry({ ts: 4, kind: "error", message: "failed" }),
  ];
  assert.equal(entries[0].source, "manual");

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

// The approval banner's 承認一覧 button lives outside the connection sheet, so
// before it was marked as an opener the click that opened the sheet fell
// through to the click-outside rule and closed it again - the button read as
// dead on the phone.
test("the click-outside rule keeps the connection sheet open for the controls that open it", () => {
  const element = (attributes = [], parent = null) => {
    const node = { attributes, parent, children: [] };
    node.contains = (other) => {
      for (let current = other; current; current = current.parent) {
        if (current === node) return true;
      }
      return false;
    };
    node.closest = (selector) => {
      const wanted = selector.replace(/^\[|\]$/g, "");
      for (let current = node; current; current = current.parent) {
        if (current.attributes.includes(wanted)) return current;
      }
      return null;
    };
    if (parent) parent.children.push(node);
    return node;
  };

  const sheet = element();
  const insideSheet = element([], sheet);
  const banner = element();
  const bannerButton = element(["data-opens-bridge-fleet"], banner);
  const bannerButtonLabel = element([], bannerButton);
  const elsewhere = element();

  assert.equal(clickClosesBridgeFleet(bannerButton, sheet), false);
  // A tap lands on whatever the button is made of, so the marker has to hold
  // for the button's own children too.
  assert.equal(clickClosesBridgeFleet(bannerButtonLabel, sheet), false);
  assert.equal(clickClosesBridgeFleet(insideSheet, sheet), false);
  assert.equal(clickClosesBridgeFleet(elsewhere, sheet), true);
  assert.equal(clickClosesBridgeFleet(banner, sheet), true);
  assert.equal(clickClosesBridgeFleet(null, sheet), false);
  assert.equal(clickClosesBridgeFleet(elsewhere, null), false);
});

// The sidebar seeded the bridge serving the page with the phrase it shows above
// whatever is current. That phrase was written into the registry as the bridge's
// name, so the switcher listed it under the heading's own words, right below the
// card already showing it - one connection, on screen twice, identically named.
test("names the UI invented for a bridge never pass as names it was given", () => {
  assert.equal(isPlaceholderBridgeLabel(""), true);
  assert.equal(isPlaceholderBridgeLabel("   "), true);
  assert.equal(isPlaceholderBridgeLabel("Home bridge"), true);
  assert.equal(isPlaceholderBridgeLabel("Home"), true);
  // Already sitting in registries in the wild, so it has to keep being
  // recognised long enough for those to heal.
  assert.equal(isPlaceholderBridgeLabel("現在の接続先"), true);
  assert.equal(isPlaceholderBridgeLabel("接続先"), true);
  // Anything a bridge or a person actually chose is left alone.
  assert.equal(isPlaceholderBridgeLabel("codex-remote-control-lab"), false);
  assert.equal(isPlaceholderBridgeLabel("Air Claude"), false);
  assert.equal(isPlaceholderBridgeLabel("mini Claude"), false);
  assert.equal(isPlaceholderBridgeLabel("現在の接続先 mini"), false);
});

// The drawer swipe and the chat-switch swipe are both a rightward drag over the
// conversation. They are separated by where the finger starts, so the edge strip
// has to be the one thing that decides - otherwise one swipe opens the drawer
// and changes the chat sitting behind it.
test("the left edge strip claims the drawer swipe", () => {
  const phone = { width: 390, sidebarOpen: false };
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: 0 }), true);
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: sidebarEdgeSwipeZone }), true);
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: sidebarEdgeSwipeZone + 1 }), false);
  // Mid-screen drags stay with the chat switch.
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: 180 }), false);
  // Nothing left to open once the drawer is already out.
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: 4, sidebarOpen: true }), false);
  // On a desktop width the sidebar is always on screen, so there is nothing to
  // swipe open.
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: 4, width: 1280 }), false);
  assert.equal(startsSidebarEdgeSwipe({ ...phone, x: Number.NaN }), false);
  assert.equal(startsSidebarEdgeSwipe(), false);
});

test("the drawer opens on a rightward edge drag, not on a tap or a scroll", () => {
  assert.equal(completesSidebarEdgeSwipe({ dx: 120, dy: 10, elapsed: 220 }), true);
  // A drag that drifts downward still counts: it already proved its intent by
  // starting on the edge.
  assert.equal(completesSidebarEdgeSwipe({ dx: 120, dy: 80, elapsed: 220 }), true);
  assert.equal(completesSidebarEdgeSwipe({ dx: 90, dy: 90, elapsed: 220 }), false);
  // A tap at the edge, a short nudge, and a leftward drag all leave it closed.
  assert.equal(completesSidebarEdgeSwipe({ dx: 0, dy: 0, elapsed: 90 }), false);
  assert.equal(completesSidebarEdgeSwipe({ dx: 40, dy: 4, elapsed: 220 }), false);
  assert.equal(completesSidebarEdgeSwipe({ dx: -120, dy: 4, elapsed: 220 }), false);
  // A finger resting on the edge before it moves is not a swipe.
  assert.equal(completesSidebarEdgeSwipe({ dx: 120, dy: 10, elapsed: 1400 }), false);
  assert.equal(completesSidebarEdgeSwipe(), false);
});

test("PWA helpers keep manifest and service worker opt-in safe", () => {
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: false, secureContext: true }), false);
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: true, secureContext: false }), false);
  assert.equal(serviceWorkerRegistrationAllowed({ enableSw: true, secureContext: true }), true);
  assert.deepEqual(pwaManifestTokenIssues({ start_url: "/?token=secret", name: "Codex" }).hasTokenParam, true);
  assert.deepEqual(pwaManifestTokenIssues({ start_url: "/", description: "token-protected bridge" }).hasTokenParam, false);
  assert.equal(
    shouldReloadInstallWithStoredToken({ pathname: "/install", search: "", storedToken: "secret", standalone: false }),
    true,
  );
  assert.equal(
    shouldReloadInstallWithStoredToken({ pathname: "/install", search: "?token=fresh", storedToken: "secret", standalone: false }),
    false,
  );
  assert.equal(
    shouldReloadInstallWithStoredToken({ pathname: "/install", search: "", storedToken: "secret", standalone: true }),
    false,
  );
  assert.equal(
    shouldReloadInstallWithStoredToken({ pathname: "/", search: "", storedToken: "secret", standalone: false }),
    false,
  );
});

test("resume thread refresh waits for provider sync and still falls back after a lookup failure", async () => {
  const events = [];
  const result = await loadThreadsAfterProviderSync(
    async () => {
      events.push("sync:start");
      await Promise.resolve();
      events.push("sync:end");
    },
    async (options) => {
      events.push(`load:${options.background}`);
      return "loaded";
    },
    { background: true },
  );
  assert.equal(result, "loaded");
  assert.deepEqual(events, ["sync:start", "sync:end", "load:true"]);

  const fallbackEvents = [];
  await loadThreadsAfterProviderSync(
    async () => {
      fallbackEvents.push("sync");
      throw new Error("bridge waking");
    },
    async () => fallbackEvents.push("load"),
  );
  assert.deepEqual(fallbackEvents, ["sync", "load"]);
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
  assert.equal(maskToken("secret123456"), "secr…3456");
  assert.equal(maskToken("http://x/?token=secret123456"), "http://x/?token=secr…3456");
  assert.doesNotMatch(maskToken("secret123456"), /secret123456/);
});

test("token query removal preserves non-token query params", () => {
  assert.equal(urlWithoutTokenParam("http://x.test/?token=secret&thread=abc&provider=codex"), "http://x.test/?thread=abc&provider=codex");
  assert.equal(urlWithoutTokenParam("http://x.test/?thread=abc&token=secret"), "http://x.test/?thread=abc");
  assert.equal(urlWithoutTokenParam("http://x.test/?thread=abc"), "http://x.test/?thread=abc");
});

test("bridge registry helpers dedupe by base URL and keep thread keys bridge scoped", () => {
  const first = normalizeBridgeEntry({ baseUrl: "http://127.0.0.1:45214/?token=a", label: "A", token: "a" }, { now: 1 });
  const second = normalizeBridgeEntry({ baseUrl: "http://127.0.0.1:45214", label: "A2", token: "b" }, { now: 2 });
  assert.equal(first.id, bridgeIdFromBaseUrl("http://127.0.0.1:45214"));
  assert.equal(first.baseUrl, "http://127.0.0.1:45214");
  let registry = upsertBridgeRegistry({ version: 1, bridges: [] }, first);
  registry = upsertBridgeRegistry(registry, second);
  assert.equal(registry.bridges.length, 1);
  assert.equal(registry.bridges[0].label, "A2");
  assert.equal(registry.bridges[0].baseUrl, "http://127.0.0.1:45214");
  assert.equal(registry.bridges[0].token, "");
  assert.doesNotMatch(JSON.stringify(registry), /[?&]token=|\"token\":\"b\"/);
  assert.equal(bridgeThreadKey(first.id, "thread-123"), `${first.id}::thread-123`);
  assert.equal(removeBridgeFromRegistry(registry, first.id).bridges.length, 0);
});

test("restoring a backup unions both lists instead of replacing either", () => {
  const local = { version: 1, bridges: [{ id: "home", baseUrl: "http://127.0.0.1:45214", label: "home", updatedAt: 20, createdAt: 20 }] };
  const remote = {
    version: 1,
    bridges: [
      { id: "home", baseUrl: "http://127.0.0.1:45214", label: "stale home", updatedAt: 5, createdAt: 5, lastUsedAt: 50 },
      { id: "air", baseUrl: "http://100.64.0.2:45214", label: "air", updatedAt: 9, createdAt: 9 },
    ],
  };
  const merged = mergeBridgeRegistries(local, remote);
  assert.deepEqual(
    merged.bridges.map((bridge) => bridge.id),
    ["home", "air"],
  );
  // The device's own edit is newer, so it wins the label while the backup
  // still contributes the older createdAt and the newer lastUsedAt.
  assert.equal(merged.bridges[0].label, "home");
  assert.equal(merged.bridges[0].createdAt, 5);
  assert.equal(merged.bridges[0].lastUsedAt, 50);
  assert.equal(merged.bridges[1].label, "air");
});

test("a newer backup entry wins over an older local copy", () => {
  const local = { version: 1, bridges: [{ id: "mini", baseUrl: "http://127.0.0.1:45214", label: "old", updatedAt: 1 }] };
  const remote = { version: 1, bridges: [{ id: "mini", baseUrl: "http://127.0.0.1:45214", label: "new", updatedAt: 99 }] };
  assert.equal(mergeBridgeRegistries(local, remote).bridges[0].label, "new");
});

test("merging an empty backup keeps every bridge the device already had", () => {
  const local = { version: 1, bridges: [{ id: "home", baseUrl: "http://127.0.0.1:45214" }] };
  assert.equal(mergeBridgeRegistries(local, { version: 1, bridges: [] }).bridges.length, 1);
  assert.equal(mergeBridgeRegistries(local, {}).bridges.length, 1);
});

test("merged registries never carry a token in the bridge list", () => {
  const merged = mergeBridgeRegistries(
    { version: 1, bridges: [{ id: "home", baseUrl: "http://127.0.0.1:45214", token: "local-secret" }] },
    { version: 1, bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214", token: "remote-secret" }] },
  );
  assert.doesNotMatch(JSON.stringify(merged), /secret/);
});

const remembered = [
  { id: "home", rememberToken: true },
  { id: "air", rememberToken: true },
];

test("the newest token wins a sync, not the nearest one", () => {
  // The stale device has been closed since before the rotation; pushing its
  // own copy back would undo a key change made somewhere else.
  const merged = mergeBridgeTokens({ home: { token: "stale", updatedAt: 10 } }, { home: { token: "rotated", updatedAt: 99 } }, remembered);
  assert.deepEqual(merged, { home: { token: "rotated", updatedAt: 99 } });
});

test("a token this device just set outranks an older backed-up one", () => {
  const merged = mergeBridgeTokens(
    { home: { token: "fresh", updatedAt: 99 } },
    { home: { token: "stale", updatedAt: 10 }, air: { token: "air-token", updatedAt: 5 } },
    remembered,
  );
  assert.deepEqual(merged, { home: { token: "fresh", updatedAt: 99 }, air: { token: "air-token", updatedAt: 5 } });
});

test("tokens are dropped for bridges that are gone or not remembered", () => {
  const tokens = { home: { token: "keep", updatedAt: 1 }, air: { token: "drop", updatedAt: 1 }, ghost: { token: "drop", updatedAt: 1 } };
  const merged = mergeBridgeTokens({}, tokens, [
    { id: "home", rememberToken: true },
    { id: "air", rememberToken: false },
  ]);
  assert.deepEqual(merged, { home: { token: "keep", updatedAt: 1 } });
});

test("token maps from before timestamps are accepted without outranking anything", () => {
  const merged = mergeBridgeTokens({ home: "legacy" }, { home: { token: "timestamped", updatedAt: 1 } }, remembered);
  assert.deepEqual(merged, { home: { token: "timestamped", updatedAt: 1 } });
  assert.deepEqual(mergeBridgeTokens({}, {}, remembered), {});
});

test("a bridge deleted on one device does not grow back from the backup", () => {
  const local = { version: 1, bridges: [{ id: "home", baseUrl: "http://127.0.0.1:45214" }], deleted: [{ id: "air", deletedAt: 100 }] };
  const remote = {
    version: 1,
    bridges: [
      { id: "home", baseUrl: "http://127.0.0.1:45214" },
      { id: "air", baseUrl: "http://100.64.0.2:45214", updatedAt: 50 },
    ],
  };
  const merged = mergeBridgeRegistries(local, remote);
  assert.deepEqual(
    merged.bridges.map((bridge) => bridge.id),
    ["home"],
  );
  // The record travels on, so the device that still lists it also drops it.
  assert.deepEqual(merged.deleted, [{ id: "air", deletedAt: 100 }]);
});

test("a stale device learns of a deletion it never made", () => {
  const stale = {
    version: 1,
    bridges: [
      { id: "home", baseUrl: "http://127.0.0.1:45214" },
      { id: "air", baseUrl: "http://100.64.0.2:45214", updatedAt: 50 },
    ],
  };
  const backup = { version: 1, bridges: [{ id: "home", baseUrl: "http://127.0.0.1:45214" }], deleted: [{ id: "air", deletedAt: 100 }] };
  assert.deepEqual(
    mergeBridgeRegistries(stale, backup).bridges.map((bridge) => bridge.id),
    ["home"],
  );
});

test("registering a bridge again after deleting it makes it stay", () => {
  const local = {
    version: 1,
    bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214", createdAt: 200 }],
    deleted: [{ id: "air", deletedAt: 100 }],
  };
  const merged = mergeBridgeRegistries(local, { version: 1, bridges: [], deleted: [{ id: "air", deletedAt: 100 }] });
  assert.deepEqual(
    merged.bridges.map((bridge) => bridge.id),
    ["air"],
  );
  assert.deepEqual(merged.deleted, []);
});

test("an app left open does not undo another device's deletion", () => {
  // refreshBridgeState re-reads every bridge every few seconds. If that counted
  // as registering the bridge again, simply leaving the app on screen would
  // bring back what another phone deleted - and take the removal record with
  // it, so no device would remember the deletion at all.
  const polling = {
    version: 1,
    bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214", createdAt: 10, updatedAt: 999_999 }],
  };
  const backup = { version: 1, bridges: [], deleted: [{ id: "air", deletedAt: 100 }] };
  const merged = mergeBridgeRegistries(polling, backup);
  assert.deepEqual(merged.bridges, []);
  assert.deepEqual(merged.deleted, [{ id: "air", deletedAt: 100 }]);
});

test("this device's choice not to remember a token is not overridden", () => {
  const local = { version: 1, bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214", rememberToken: false, updatedAt: 10 }] };
  const remote = { version: 1, bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214", rememberToken: true, updatedAt: 999 }] };
  const merged = mergeBridgeRegistries(local, remote);
  assert.equal(merged.bridges[0].rememberToken, false);
  // And so the backed-up token is not adopted into this device's storage.
  assert.deepEqual(mergeBridgeTokens({}, { air: { token: "air-token", updatedAt: 999 } }, merged.bridges), {});
});

test("removing a bridge records when it happened", () => {
  const registry = { version: 1, bridges: [{ id: "air", baseUrl: "http://100.64.0.2:45214" }] };
  const removed = removeBridgeFromRegistry(registry, "air", { now: 777 });
  assert.deepEqual(removed.bridges, []);
  assert.deepEqual(removed.deleted, [{ id: "air", deletedAt: 777 }]);
});

test("thread inbox status derivation prioritizes actionable work", () => {
  const approval = { id: "a", updatedAt: 1 };
  const running = { id: "b", updatedAt: 10 };
  const done = { id: "c", updatedAt: 20 };
  const runtime = {
    selectedThread: "a",
    currentRunState: "approval",
    pendingApproval: { id: 1 },
    bridgeRuns: [{ threadId: "b", run: { state: "running" } }],
  };

  assert.equal(deriveThreadStatus(approval, runtime).key, "approval_required");
  assert.equal(deriveThreadStatus(approval, runtime).label, "許可待ち");
  assert.equal(deriveThreadStatus(running, runtime).key, "running");
  assert.equal(deriveThreadStatus(running, runtime).label, "処理中");
  const testFailed = deriveThreadStatus(
    { id: "d", preview: "user asked about the テスト失敗 badge" },
    { bridgeRuns: [{ threadId: "d", terminalTail: [{ message: "$ npm test\nℹ fail 1" }] }] },
  );
  assert.equal(testFailed.key, "test_failed");
  assert.equal(testFailed.label, "確認必要");
  assert.equal(deriveThreadStatus({ id: "d", preview: "npm test failed" }, {}).key, "recent");
  assert.equal(
    deriveThreadStatus(
      { id: "d", preview: "npm test failed" },
      {
        selectedThread: "d",
        currentRunState: "done",
        terminalEntries: [{ kind: "command", message: "$ npm test\n1 failed" }],
      },
    ).key,
    "test_failed",
  );
  assert.equal(
    deriveThreadStatus(
      { id: "e", preview: "実装方針を確認したいです" },
      { selectedThread: "e", currentRunState: "question" },
    ).key,
    "question_required",
  );
  assert.equal(
    deriveThreadStatus(
      { id: "e", preview: "実装方針を確認したいです" },
      { selectedThread: "e", currentRunState: "question" },
    ).label,
    "返信待ち",
  );
  assert.equal(
    deriveThreadStatus(
      { id: "f", preview: "$ npm test\nℹ tests 64\nℹ pass 64\nℹ fail 0" },
      { selectedThread: "f", currentRunState: "done" },
    ).key,
    "done",
  );
  assert.equal(
    deriveThreadStatus(
      { id: "f", preview: "$ npm test\nℹ tests 64\nℹ pass 64\nℹ fail 0" },
      { selectedThread: "f", currentRunState: "done" },
    ).label,
    "",
  );
  assert.equal(
    deriveThreadStatus(
      { id: "g", preview: "送信に失敗しました。" },
      { selectedThread: "g", currentRunState: "done" },
    ).key,
    "done",
  );
  assert.equal(
    deriveThreadStatus({ id: "h" }, { bridgeRuns: [{ threadId: "h", terminalTail: [{ message: "$ npm test\nℹ fail 1" }] }] }).key,
    "test_failed",
  );
  assert.equal(
    deriveThreadStatus({ id: "i" }, { bridgeRuns: [{ threadId: "i", terminalTail: [{ message: "$ npm run check\nexited with 2" }] }] }).key,
    "test_failed",
  );
  assert.deepEqual(
    sortThreadsForInbox([done, running, approval], runtime).map((thread) => thread.id),
    ["a", "b", "c"],
  );
});

test("the copy button hands over a command that works as pasted", () => {
  // `claude --resume` without an id only offers sessions belonging to the
  // directory it is started from, so the cd is part of the command.
  assert.equal(
    resumeCommandForThread({ id: "2bec35bc-1324-4b49-8a83-d550e9a9ba07", cwd: "/Users/you/Prj/example", provider: "claude" }),
    "cd /Users/you/Prj/example && claude --resume 2bec35bc-1324-4b49-8a83-d550e9a9ba07",
  );
});

test("a folder with no recorded path still yields a usable resume", () => {
  assert.equal(resumeCommandForThread({ id: "abc", provider: "claude" }), "claude --resume abc");
  assert.equal(resumeCommandForThread({ id: "abc", cwd: "/Users/you/Prj/example/" }), "cd /Users/you/Prj/example && claude --resume abc");
});

test("a path that would break the command line is quoted", () => {
  assert.equal(
    resumeCommandForThread({ id: "abc", cwd: "/Users/you/My Project" }),
    "cd '/Users/you/My Project' && claude --resume abc",
  );
  assert.equal(
    resumeCommandForThread({ id: "abc", cwd: "/Users/you/it's mine" }),
    `cd '/Users/you/it'\\''s mine' && claude --resume abc`,
  );
});

test("no command is offered where none would work", () => {
  // A thread with no answer yet carries a placeholder id, and Codex threads are
  // not resumed with this command at all.
  assert.equal(resumeCommandForThread({ id: "claude:6f9e", cwd: "/Users/you/Prj/example" }), "");
  assert.equal(resumeCommandForThread({ id: "thread-1", provider: "codex", cwd: "/Users/you/Prj/example" }), "");
  assert.equal(resumeCommandForThread({}), "");
});

test("a pipe table is recognized only once its divider row confirms it", () => {
  assert.equal(isMarkdownTableStart(["| a | b |", "| --- | --- |"], 0), true);
  assert.equal(isMarkdownTableStart(["| a | b |", "| :-- | --: |"], 0), true);
  // Prose that merely contains a pipe is not a table.
  assert.equal(isMarkdownTableStart(["run a | b", "then something"], 0), false);
  // A divider whose column count disagrees with the header is not a table.
  assert.equal(isMarkdownTableStart(["| a | b |", "| --- |"], 0), false);
  assert.equal(isMarkdownTableStart(["| a | b |"], 0), false);
});

test("a table parses into header, alignment and padded rows", () => {
  const table = parseMarkdownTable(["| ファイル | 内容 |", "| --- | ---: |", "| a.js | ロガー |", "| b.js |", "", "next"], 0);
  assert.deepEqual(table.header, ["ファイル", "内容"]);
  assert.deepEqual(table.align, ["", "right"]);
  assert.deepEqual(table.rows, [
    ["a.js", "ロガー"],
    ["b.js", ""],
  ]);
  // Stops at the blank line so the paragraph after it is not swallowed.
  assert.equal(table.endIndex, 4);
});

test("tables written without outer pipes still parse", () => {
  const table = parseMarkdownTable(["a | b", "--- | ---", "1 | 2"], 0);
  assert.deepEqual(table.header, ["a", "b"]);
  assert.deepEqual(table.rows, [["1", "2"]]);
});

test("an escaped pipe stays inside its cell", () => {
  assert.deepEqual(splitMarkdownTableRow("| a \\| b | c |"), ["a | b", "c"]);
});

test("a row with more cells than the header is trimmed to the header", () => {
  const table = parseMarkdownTable(["| a | b |", "| --- | --- |", "| 1 | 2 | 3 |"], 0);
  assert.deepEqual(table.rows, [["1", "2"]]);
});

test("text that is not a table returns nothing to render", () => {
  assert.equal(parseMarkdownTable(["just prose", "more prose"], 0), null);
});

test("a host label keeps the end of the name, where the machine is identified", () => {
  assert.equal(shortHostLabel("Yujiro-no-MacBook-Air.local"), "MacBook-Air");
  assert.equal(shortHostLabel("minijiro-Mac-mini.local"), "Mac-mini");
  assert.equal(shortHostLabel("Mac-mini"), "Mac-mini");
  assert.equal(shortHostLabel("air"), "air");
});

test("host labels drop only local-network suffixes", () => {
  assert.equal(shortHostLabel("mini-codex.lan"), "mini-codex");
  assert.equal(shortHostLabel("build-box.internal."), "build-box");
  // A name that is not a local suffix stays part of the label.
  assert.equal(shortHostLabel("desk-mac.example.com"), "desk-mac.example.com");
});

test("a missing host name produces no label rather than a stray separator", () => {
  assert.equal(shortHostLabel(""), "");
  assert.equal(shortHostLabel(null), "");
  assert.equal(shortHostLabel(undefined), "");
});

test("a Mac is labelled by its model, which is what it gets called", () => {
  assert.equal(machineLabelFromHost("Yujiro-no-MacBook-Air.local"), "Air");
  assert.equal(machineLabelFromHost("minijiro-Mac-mini.local"), "mini");
  assert.equal(machineLabelFromHost("Macmini.local"), "mini");
  assert.equal(machineLabelFromHost("MacBookAir.local"), "Air");
});

test("a MacBook Pro is not read as a Mac Pro", () => {
  assert.equal(machineLabelFromHost("work-MacBook-Pro.local"), "Pro");
  assert.equal(machineLabelFromHost("studio-Mac-Pro.local"), "Mac Pro");
  assert.equal(machineLabelFromHost("desk-Mac-Studio.local"), "Studio");
  assert.equal(machineLabelFromHost("family-iMac.local"), "iMac");
});

test("a hostname naming no model keeps its distinguishing tail", () => {
  assert.equal(machineLabelFromHost("build-box-01.local"), "box-01");
  assert.equal(machineLabelFromHost("air"), "air");
  assert.equal(machineLabelFromHost(""), "");
});

test("a bridge is named by the label its owner set, and by its host otherwise", () => {
  assert.equal(machineLabelForBridge({ machineLabel: "母艦", hostName: "minijironoMac-mini.local" }), "母艦");
  assert.equal(machineLabelForBridge({ machineLabel: "", hostName: "minijironoMac-mini.local" }), "mini");
  assert.equal(machineLabelForBridge({ hostName: "Yujiro-no-MacBook-Air.local" }), "Air");
  assert.equal(machineLabelForBridge({}), "");
});

test("two Macs running the same project name get one heading each", () => {
  const air = threadProjectGroupKey("00_受け渡し", "Air");
  const mini = threadProjectGroupKey("00_受け渡し", "mini");
  assert.notEqual(air, mini);
  assert.equal(air, "air/00_受け渡し");
  // Without a machine the key stays what it was before machines were named.
  assert.equal(threadProjectGroupKey("00_受け渡し", ""), "00_受け渡し");
  assert.equal(threadProjectGroupKey("", "Air"), "air/No project");
});

test("the machine key ignores case and spacing so one Mac is not counted twice", () => {
  assert.equal(machineScopeKey("Mac mini"), "mac-mini");
  assert.equal(machineScopeKey("  Air  "), "air");
  // An unnamed bridge still counts as its own machine.
  assert.equal(machineScopeKey("", "claude-45214"), "claude-45214");
  assert.equal(machineScopeKey("", ""), "");
});

test("the mini and the Air are labelled in the colours of their own app icons", () => {
  assert.equal(machineAccentToken("mini"), "mini");
  assert.equal(machineAccentToken("Mac mini"), "mini");
  assert.equal(machineAccentToken("Air"), "air");
  assert.equal(machineAccentToken("MacBook-Air"), "air");
});

test("a machine that is neither takes no named colour, including near-misses", () => {
  // `repair` and `administrator` contain the letters but name no Air.
  assert.equal(machineAccentToken("repair-box"), "");
  assert.equal(machineAccentToken("administrator"), "");
  assert.equal(machineAccentToken("minimal"), "");
  assert.equal(machineAccentToken("build-box-01"), "");
  assert.equal(machineAccentToken(""), "");
});

test("a list spanning one Mac is not worth labelling per row", () => {
  const mini = [{ machineLabel: "mini", bridgeId: "a" }, { machineLabel: "mini", bridgeId: "b" }];
  assert.equal(machineScopeCount(mini), 1);
  assert.equal(machineScopeCount([...mini, { machineLabel: "Air", bridgeId: "c" }]), 2);
  assert.equal(machineScopeCount([]), 0);
});
