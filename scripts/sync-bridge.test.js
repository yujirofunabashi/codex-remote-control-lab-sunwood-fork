const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { syncBridge } = require("./sync-bridge");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(root, file, content) {
  fs.writeFileSync(path.join(root, file), content);
  git(root, "add", "--", file);
  git(root, "commit", "-m", file);
  return git(root, "rev-parse", "HEAD");
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "shared.git"), air = path.join(dir, "air"), mini = path.join(dir, "mini");
  fs.mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "develop");
  for (const root of [air, mini]) {
    fs.mkdirSync(root);
    git(root, "clone", remote, ".");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
  }
  commit(air, "screen.js", "initial\n");
  git(air, "push", "-u", "origin", "develop");
  git(mini, "pull", "--ff-only", "origin", "develop");
  git(mini, "branch", "--set-upstream-to=origin/develop", "develop");
  return { dir, remote, air, mini };
}

test("both directions share committed changes through the same remote", t => {
  const { air, mini } = fixture(t);
  assert.equal(syncBridge(mini).status, "current");
  commit(air, "from-air.js", "Air change\n");
  git(air, "push", "origin", "develop");
  const before = git(mini, "rev-parse", "HEAD");
  assert.equal(syncBridge(mini).status, "behind");
  assert.equal(git(mini, "rev-parse", "HEAD"), before, "check does not update the checkout");
  assert.equal(syncBridge(mini, { apply: true }).status, "updated");
  commit(mini, "from-mini.js", "mini change\n");
  git(mini, "push", "origin", "develop");
  assert.equal(syncBridge(air, { apply: true }).status, "updated");
  assert.equal(fs.readFileSync(path.join(air, "from-mini.js"), "utf8"), "mini change\n");
  assert.equal(fs.readFileSync(path.join(mini, "from-air.js"), "utf8"), "Air change\n");
});

test("uncommitted edits and untracked files are preserved and prevent updating", t => {
  const { air, mini } = fixture(t);
  commit(air, "screen.js", "shared update\n");
  git(air, "push", "origin", "develop");
  const before = git(mini, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(mini, "screen.js"), "local unfinished work\n");
  assert.equal(syncBridge(mini, { apply: true }).status, "dirty");
  assert.equal(git(mini, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(mini, "screen.js"), "utf8"), "local unfinished work\n");
  fs.writeFileSync(path.join(mini, "screen.js"), "initial\n");
  fs.writeFileSync(path.join(mini, "not-shared.js"), "local new file\n");
  assert.equal(syncBridge(mini, { apply: true }).status, "dirty");
  assert.equal(fs.readFileSync(path.join(mini, "not-shared.js"), "utf8"), "local new file\n");
});

test("unpublished and diverging commits are never reset or overwritten", t => {
  const { air, mini } = fixture(t);
  const local = commit(mini, "from-mini.js", "mini unfinished integration\n");
  assert.equal(syncBridge(mini, { apply: true }).status, "ahead");
  commit(air, "from-air.js", "Air integrated\n");
  git(air, "push", "origin", "develop");
  assert.equal(syncBridge(mini, { apply: true }).status, "diverged");
  assert.equal(git(mini, "rev-parse", "HEAD"), local);
  assert.equal(fs.readFileSync(path.join(mini, "from-mini.js"), "utf8"), "mini unfinished integration\n");
  // Explicitly reconcile compatible changes, then the normal guarded pull works.
  git(mini, "merge", "--no-edit", "origin/develop");
  git(mini, "push", "origin", "develop");
  assert.equal(syncBridge(air, { apply: true }).status, "updated");
  assert.equal(fs.readFileSync(path.join(air, "from-mini.js"), "utf8"), "mini unfinished integration\n");
});

test("a feature branch is not silently moved to the integration branch", t => {
  const { mini } = fixture(t);
  git(mini, "checkout", "-b", "feature/active-work");
  assert.equal(syncBridge(mini, { apply: true }).status, "wrong-branch");
  assert.equal(git(mini, "branch", "--show-current"), "feature/active-work");
});

test("unknown upstream and interrupted Git operations fail closed", t => {
  const { mini } = fixture(t);
  git(mini, "branch", "--unset-upstream");
  assert.equal(syncBridge(mini, { apply: true }).status, "no-upstream");
  git(mini, "branch", "--set-upstream-to=origin/develop", "develop");
  const head = git(mini, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(mini, ".git", "CHERRY_PICK_HEAD"), head + "\n");
  assert.equal(syncBridge(mini, { apply: true }).status, "git-operation");
  assert.equal(git(mini, "rev-parse", "HEAD"), head);
});

test("an unreachable shared repository does not move the local checkout", t => {
  const { mini, dir } = fixture(t);
  const before = git(mini, "rev-parse", "HEAD");
  git(mini, "remote", "set-url", "origin", path.join(dir, "missing.git"));
  assert.equal(syncBridge(mini, { apply: true }).status, "error");
  assert.equal(git(mini, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(mini, "screen.js"), "utf8"), "initial\n");
});
