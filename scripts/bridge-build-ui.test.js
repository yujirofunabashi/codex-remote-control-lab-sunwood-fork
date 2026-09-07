const test = require("node:test");
const assert = require("node:assert/strict");
const { bridgeBuildLabel, bridgeBuildNotice } = require("../public/phone-ui-utils");

const clean = { schema: 1, available: true, head: "a".repeat(40), fingerprint: "b".repeat(64),
  dirty: false, restartRequired: false, upstream: { name: "origin/develop", ahead: 0, behind: 0 } };
const peer = (label, build = clean, connected = true) => ({ label, build, connected });

test("matching shared app versions are quiet even if selected workspaces differ", () => {
  assert.equal(bridgeBuildNotice([peer("Air"), peer("mini")]), "");
  assert.match(bridgeBuildLabel(clean), /アプリ aaaaaaa/);
});

test("same commit with different actual files is visibly different", () => {
  const notice = bridgeBuildNotice([peer("Air"), peer("mini", { ...clean, fingerprint: "c".repeat(64) })]);
  assert.match(notice, /版が異なります/);
  assert.match(notice, /Air/);
  assert.match(notice, /mini/);
});

test("unshared edits, unpublished commits and server restart wait are distinct", () => {
  assert.match(bridgeBuildLabel({ ...clean, dirty: true }), /未共有の編集/);
  assert.match(bridgeBuildLabel({ ...clean, upstream: { ...clean.upstream, ahead: 1 } }), /未送信/);
  assert.match(bridgeBuildLabel({ ...clean, upstream: { ...clean.upstream, behind: 1 } }), /取り込み待ち/);
  assert.match(bridgeBuildNotice([peer("mini", { ...clean, restartRequired: true })]), /再起動待ち/);
});

test("old helpers, unknown sharing state and disconnected cached versions never imply parity", () => {
  assert.match(bridgeBuildNotice([peer("Air", null)]), /確認できません/);
  assert.match(bridgeBuildNotice([peer("Air", clean, false), peer("mini")]), /確認できません/);
  assert.match(bridgeBuildLabel({ ...clean, upstream: null }), /共有先を確認できません/);
  assert.match(bridgeBuildNotice([peer("Air", { ...clean, schema: 99 })]), /確認できません/);
});
