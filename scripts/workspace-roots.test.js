const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = os.homedir();
// A folder outside the home folder standing in for an external disk's project
// area, and a sibling of it that nobody allowed.
const disk = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-roots-"));
const allowed = path.join(disk, "workspaces");
const project = path.join(allowed, "project-a");
const notAllowed = path.join(disk, "backups");
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
fs.mkdirSync(notAllowed, { recursive: true });

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.PHONE_WORKDIR = home;
process.env.PHONE_WORKSPACE_ROOTS = "";

const {
  browseWorkspaceDirectories,
  extraWorkspaceRoots,
  setWorkspaceBookmark,
  validateWorkdir,
  workspaceOptions,
} = require("./start-phone");

function withRoots(value, run) {
  const previous = process.env.PHONE_WORKSPACE_ROOTS;
  process.env.PHONE_WORKSPACE_ROOTS = value;
  try {
    return run();
  } finally {
    process.env.PHONE_WORKSPACE_ROOTS = previous;
  }
}

test.after(() => {
  fs.rmSync(disk, { recursive: true, force: true });
});

test("nothing outside the home folder is open unless the owner lists it", () => {
  assert.deepEqual(extraWorkspaceRoots(""), []);
  assert.throws(() => validateWorkdir(project), /home folder/);
  assert.throws(() => browseWorkspaceDirectories(allowed), /ホームフォルダ配下/);
});

test("an allowed root and the folders below it become workdirs", () => {
  withRoots(allowed, () => {
    assert.equal(validateWorkdir(allowed), allowed);
    assert.equal(validateWorkdir(project), project);
    const listing = browseWorkspaceDirectories(allowed);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["project-a"]);
    assert.equal(listing.entries[0].isRepo, true);
  });
});

test("the rest of the same disk stays closed", () => {
  withRoots(allowed, () => {
    assert.throws(() => validateWorkdir(notAllowed), /PHONE_WORKSPACE_ROOTS/);
    assert.throws(() => validateWorkdir(disk), /PHONE_WORKSPACE_ROOTS/);
    assert.throws(() => browseWorkspaceDirectories(path.join(allowed, "..", "backups")), /許可したフォルダ/);
  });
});

test("going up from an allowed root returns to the home folder, not the disk", () => {
  withRoots(allowed, () => {
    assert.equal(browseWorkspaceDirectories(allowed).parent, path.resolve(home));
    assert.equal(browseWorkspaceDirectories(project).parent, allowed);
  });
});

test("the home listing offers the allowed roots first, and only mounted ones", () => {
  withRoots(`${allowed}:${path.join(disk, "unplugged")}`, () => {
    const entries = browseWorkspaceDirectories("").entries;
    assert.equal(entries[0].path, allowed);
    assert.match(entries[0].name, /^外付け: /);
    assert.ok(!entries.some((entry) => entry.path === path.join(disk, "unplugged")));
  });
});

test("an unplugged root fails instead of standing in for another folder", () => {
  const unplugged = path.join(disk, "unplugged");
  withRoots(unplugged, () => {
    assert.throws(() => validateWorkdir(unplugged), /does not exist/);
  });
});

test("a symlink inside an allowed root cannot lead back out of it", () => {
  withRoots(allowed, () => {
    const link = path.join(allowed, "escape");
    fs.symlinkSync(notAllowed, link, "dir");
    try {
      const names = browseWorkspaceDirectories(allowed).entries.map((entry) => entry.name);
      assert.ok(!names.includes("escape"));
    } finally {
      fs.unlinkSync(link);
    }
  });
});

test("roots that would open the whole machine are ignored", () => {
  assert.deepEqual(extraWorkspaceRoots("/"), []);
  assert.deepEqual(extraWorkspaceRoots("/Volumes"), []);
  assert.deepEqual(extraWorkspaceRoots("/Users"), []);
  assert.deepEqual(extraWorkspaceRoots(path.dirname(home)), []);
  assert.deepEqual(extraWorkspaceRoots(path.join(home, "inside")), []);
  assert.deepEqual(extraWorkspaceRoots("relative/path"), []);
});

test("paths with spaces are kept whole, and duplicates collapse", () => {
  assert.deepEqual(extraWorkspaceRoots("/Volumes/JIRO SSD 1TB/20_mini: /Volumes/JIRO SSD 1TB/20_mini/"), [
    "/Volumes/JIRO SSD 1TB/20_mini",
  ]);
});

test("allowed roots can be bookmarked and appear among the folder choices", () => {
  withRoots(allowed, () => {
    // Bookmarks live in the checkout's own prefs file; put it back as it was.
    const prefsPath = path.join(__dirname, "..", ".phone-workspaces.json");
    const before = fs.existsSync(prefsPath) ? fs.readFileSync(prefsPath) : null;
    const result = setWorkspaceBookmark(project, true);
    try {
      assert.equal(result.pinned, true);
      const choices = workspaceOptions();
      assert.ok(choices.some((option) => option.path === project && option.group === "ブックマーク"));
      assert.ok(choices.some((option) => option.path === allowed && option.group === "外付け"));
    } finally {
      if (before) fs.writeFileSync(prefsPath, before, { mode: 0o600 });
      else fs.rmSync(prefsPath, { force: true });
    }
  });
});
