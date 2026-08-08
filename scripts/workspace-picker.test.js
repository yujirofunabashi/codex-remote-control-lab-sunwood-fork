const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = os.homedir();
const sandbox = fs.mkdtempSync(path.join(home, "workspace-picker-"));
const prefsPath = path.join(sandbox, "prefs.json");

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.PHONE_WORKDIR = sandbox;

const { browseWorkspaceDirectories, setWorkspaceBookmark, workspaceBookmarks } = require("./start-phone");

const projects = path.join(sandbox, "projects");
const repo = path.join(projects, "a-repo");
const plain = path.join(projects, "b-plain");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(path.join(projects, ".hidden"), { recursive: true });
fs.writeFileSync(path.join(projects, "notes.md"), "# notes\n");

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("browsing lists only directories, and marks repositories", () => {
  const result = browseWorkspaceDirectories(projects);
  const names = result.entries.map((entry) => entry.name);

  assert.deepEqual(names, ["a-repo", "b-plain"]);
  assert.equal(result.entries.find((entry) => entry.name === "a-repo").isRepo, true);
  assert.equal(result.entries.find((entry) => entry.name === "b-plain").isRepo, false);
  // A file is not somewhere you can set as a workdir.
  assert.ok(!names.includes("notes.md"));
});

test("dotted entries stay out of the listing", () => {
  const names = browseWorkspaceDirectories(projects).entries.map((entry) => entry.name);
  assert.ok(!names.includes(".hidden"));
});

test("browsing exposes the parent so you can walk back up", () => {
  const result = browseWorkspaceDirectories(projects);
  assert.equal(result.parent, sandbox);
  assert.equal(result.path, projects);
});

test("the home folder reports no parent, so browsing cannot climb out", () => {
  const result = browseWorkspaceDirectories(home);
  assert.equal(result.parent, null);
});

test("a path outside the home folder is refused", () => {
  assert.throws(() => browseWorkspaceDirectories("/etc"), /ホームフォルダ配下/);
  assert.throws(() => browseWorkspaceDirectories("/"), /ホームフォルダ配下/);
});

test("traversal back out of home is refused after resolution", () => {
  assert.throws(() => browseWorkspaceDirectories(path.join(home, "..", "..", "etc")), /ホームフォルダ配下/);
});

test("a symlink pointing outside home is not offered", () => {
  const linkRoot = fs.mkdtempSync(path.join(home, "link-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    fs.symlinkSync(outside, path.join(linkRoot, "escape"), "dir");
    const names = browseWorkspaceDirectories(linkRoot).entries.map((entry) => entry.name);
    assert.ok(!names.includes("escape"), "a link out of home must not become a browsable entry");
  } finally {
    fs.rmSync(linkRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing folder reports not found rather than an empty listing", () => {
  const error = (() => {
    try {
      browseWorkspaceDirectories(path.join(sandbox, "nope"));
      return null;
    } catch (thrown) {
      return thrown;
    }
  })();

  assert.ok(error);
  assert.equal(error.statusCode, 404);
});

test("browsing with no path starts at the home folder", () => {
  assert.equal(browseWorkspaceDirectories("").path, path.resolve(home));
});

test("a listing names the machine whose folders it is showing", () => {
  // `~/WORK_LOCAL/00_MINI_WORKSPACE` exists on both Macs under different homes,
  // so the machine has to come back with the listing rather than be assumed.
  const result = browseWorkspaceDirectories(projects);
  assert.equal(result.home, path.resolve(home));
  assert.equal(result.hostName, os.hostname());
  assert.ok(Object.prototype.hasOwnProperty.call(result, "machineLabel"));
});

test("a bookmark survives where recent would age out", () => {
  const before = workspaceBookmarks().length;
  const result = setWorkspaceBookmark(repo, true);

  assert.equal(result.pinned, true);
  assert.equal(result.path, repo);
  assert.ok(workspaceBookmarks().includes(repo));
  assert.equal(workspaceBookmarks().length, before + 1);
});

test("bookmarking twice does not duplicate the entry", () => {
  setWorkspaceBookmark(repo, true);
  setWorkspaceBookmark(repo, true);

  assert.equal(workspaceBookmarks().filter((item) => item === repo).length, 1);
});

test("a bookmark can be removed", () => {
  setWorkspaceBookmark(repo, true);
  const result = setWorkspaceBookmark(repo, false);

  assert.equal(result.pinned, false);
  assert.ok(!workspaceBookmarks().includes(repo));
});

test("browsing reports which entries are bookmarked", () => {
  setWorkspaceBookmark(repo, true);
  try {
    const entries = browseWorkspaceDirectories(projects).entries;
    assert.equal(entries.find((entry) => entry.name === "a-repo").pinned, true);
    assert.equal(entries.find((entry) => entry.name === "b-plain").pinned, false);
  } finally {
    setWorkspaceBookmark(repo, false);
  }
});

test("a folder outside home cannot be bookmarked", () => {
  assert.throws(() => setWorkspaceBookmark("/etc", true), /home folder/);
});

test("multi-button settings groups are not wrapped in a label", () => {
  // A <label> forwards clicks anywhere inside it to its first labelable
  // control. Wrapping the folder browser in one made every folder row also
  // press "↑ 上の階層", so picking a folder immediately jumped to its parent.
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "main.js"), "utf8");

  // The heading now names the machine being browsed, so what is pinned here is
  // the wrapper each control goes through, not the words in front of it.
  assert.match(ui, /settingGroup\(.*, browser\)/);
  assert.match(ui, /settingGroup\(.*, manualRow\)/);
  assert.ok(!/settingField\(.*, browser\)/.test(ui));
  assert.ok(!/settingField\(.*, manualRow\)/.test(ui));

  // settingGroup must stay a div; the whole point is that it is not a label.
  const group = ui.match(/function settingGroup\(labelText, control\) \{[\s\S]*?\n\}/)[0];
  assert.match(group, /createElement\("div"\)/);
  assert.ok(!/createElement\("label"\)/.test(group));
});
