const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sourceSnapshot, createBuildTracker } = require("./bridge-build");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "public"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.phone-token\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(root, "public", "main.js"), "// screen one\n");
  fs.writeFileSync(path.join(root, "scripts", "start-phone.js"), "// server one\n");
  git(root, "init", "-b", "develop");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  return root;
}

test("app identity belongs to its own repository, independent of a selected workdir", t => {
  const root = fixture(t);
  const build = sourceSnapshot(root);
  assert.equal(build.available, true);
  assert.equal(build.head, git(root, "rev-parse", "HEAD"));
  assert.equal(build.branch, "develop");
  assert.equal(build.dirty, false);
  assert.match(build.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(build.upstream, null, "unknown sharing state is not up-to-date");
});

test("same commit with a local UI edit is different, even with identical file timestamps", t => {
  const root = fixture(t);
  const tracker = createBuildTracker(root, { cacheMs: 0 });
  const before = tracker.status();
  const file = path.join(root, "public", "main.js");
  const stat = fs.statSync(file);
  fs.writeFileSync(file, "// screen two\n");
  fs.utimesSync(file, stat.atime, stat.mtime);
  const after = tracker.status();
  assert.equal(after.head, before.head);
  assert.equal(after.dirty, true);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.restartRequired, false, "a static-only update does not restart conversations");
});

test("server edits require a restart until a fresh process captures the new source", t => {
  const root = fixture(t);
  const tracker = createBuildTracker(root, { cacheMs: 0 });
  fs.writeFileSync(path.join(root, "scripts", "start-phone.js"), "// server two\n");
  const stale = tracker.status();
  assert.equal(stale.restartRequired, true);
  assert.notEqual(stale.serverFingerprint, stale.runningServerFingerprint);
  assert.equal(createBuildTracker(root).status().restartRequired, false);
});

test("CSS and helper-only edits change the whole browser build without touching main.js", t => {
  const root = fixture(t);
  const before = sourceSnapshot(root);
  const main = fs.statSync(path.join(root, "public", "main.js")).mtimeMs;
  fs.writeFileSync(path.join(root, "public", "style.css"), "body { color: black; }\n");
  const css = sourceSnapshot(root);
  assert.notEqual(css.clientFingerprint, before.clientFingerprint);
  fs.writeFileSync(path.join(root, "public", "phone-ui-utils.js"), "// helper\n");
  const helper = sourceSnapshot(root);
  assert.notEqual(helper.clientFingerprint, css.clientFingerprint);
  assert.equal(helper.serverFingerprint, before.serverFingerprint);
  assert.equal(fs.statSync(path.join(root, "public", "main.js")).mtimeMs, main);
});

test("fingerprints ignore machine paths, timestamps and local credentials", t => {
  const root = fixture(t);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-build-clone-"));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  git(clone, "clone", root, ".");
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE_FIXTURE=first-machine\n");
  fs.writeFileSync(path.join(clone, ".env"), "PRIVATE_FIXTURE=second-machine\n");
  fs.writeFileSync(path.join(clone, ".phone-token"), "not-a-real-key");
  assert.equal(sourceSnapshot(root).fingerprint, sourceSnapshot(clone).fingerprint);
  assert.equal(sourceSnapshot(clone).dirty, false);
  assert.doesNotMatch(JSON.stringify(sourceSnapshot(clone)), /second-machine|not-a-real-key/);
});

test("new source files count before they are committed, but docs do not imply a server restart", t => {
  const root = fixture(t);
  const tracker = createBuildTracker(root, { cacheMs: 0 });
  const before = tracker.status();
  fs.writeFileSync(path.join(root, "public", "extra.js"), "// not shared\n");
  assert.notEqual(tracker.status().fingerprint, before.fingerprint);
  assert.equal(tracker.status().dirty, true);
  fs.writeFileSync(path.join(root, "README.md"), "Documentation edit\n");
  assert.equal(tracker.status().restartRequired, false);
});

test("missing repository or an external source symlink stays unknown, not falsely current", t => {
  const root = fixture(t);
  fs.symlinkSync(os.tmpdir(), path.join(root, "public", "external"));
  assert.equal(sourceSnapshot(root).available, false);
  assert.equal(sourceSnapshot(path.join(root, "public")).available, false);
});
