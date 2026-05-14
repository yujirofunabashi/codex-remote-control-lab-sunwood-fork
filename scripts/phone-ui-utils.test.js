const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capTerminalHistory,
  compactWorkspacePath,
  contrastColorFor,
  fallbackThreadColor,
  keyIntentText,
  normalizeTerminalEntry,
  redactSensitiveText,
  safeJsonParse,
  sameWorkspaceThreadRecord,
  sanitizeHexColor,
  shouldConfirmDangerousKey,
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

test("redactSensitiveText masks bridge tokens and auth-like secrets", () => {
  const redacted = redactSensitiveText("http://x/?token=secret123456 PHONE_TOKEN=abcdef123456 token: abcdef1234567890 authorization: Bearer abcdef1234567890");
  assert.doesNotMatch(redacted, /secret123456|abcdef1234567890/);
  assert.match(redacted, /\[redacted\]/);
});
