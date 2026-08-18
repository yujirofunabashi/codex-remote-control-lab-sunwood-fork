// Sessions are filed per working directory. The sidebar used to read only the
// active one, so changing the bridge's workdir made every earlier session
// disappear from the phone even though nothing had been deleted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = os.homedir();
const activeWorkdir = fs.mkdtempSync(path.join(home, "scope-active-"));
const otherWorkdir = fs.mkdtempSync(path.join(home, "scope-other-"));

// Settings are read per bridge slot, and a slot's own key outranks the plain one
// whatever it came from. Both the repository's .env and the environment a
// running bridge hands down to everything it spawns carry the keys for the slots
// this machine really runs, so naming only PHONE_WORKDIR left the tests reading
// the developer's own folder. Claim a slot nobody serves and set the folder
// under that slot's key, so what is under test is decided here and not outside.
const slot = "45246";
process.env.PHONE_UI_PORT = slot;
process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.PHONE_WORKDIR = activeWorkdir;
process.env[`PHONE_WORKDIR_${slot}`] = activeWorkdir;

const {
  ClaudeBridge,
  claudeSessionFilePath,
  claudeSessionWorkdir,
  claudeThreadListPayload,
  getBridge,
  hiddenWorkspaces,
  setWorkspaceHidden,
} = require("./start-phone");

const projectsRoot = path.join(home, ".claude", "projects");

function projectDirFor(cwd) {
  return path.join(projectsRoot, path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

function writeSession(cwd, id, prompt, at = Date.now()) {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "user",
      cwd,
      sessionId: id,
      timestamp: new Date(at).toISOString(),
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    })}\n`,
  );
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}

// A long session does not stay in one directory: every turn records the folder
// it ran in, and a turn that worked in a subfolder records that. The transcript
// still lives under the folder `claude` was started in, so the two disagree.
function writeMovedSession(startCwd, laterCwd, id, at = Date.now()) {
  const file = writeSession(startCwd, id, "started at the top of the repo", at);
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      type: "user",
      cwd: laterCwd,
      sessionId: id,
      timestamp: new Date(at + 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "then went into a subfolder" }] },
    })}\n`,
  );
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}

const activeId = "aaaaaaaa-0000-0000-0000-000000000001";
const otherId = "bbbbbbbb-0000-0000-0000-000000000002";
const movedId = "dddddddd-0000-0000-0000-000000000004";
const movedSubdir = path.join(otherWorkdir, "subproject");

writeSession(activeWorkdir, activeId, "work in the active folder");
writeSession(otherWorkdir, otherId, "work from before the workdir changed");
fs.mkdirSync(movedSubdir, { recursive: true });
writeMovedSession(otherWorkdir, movedSubdir, movedId);

test.after(() => {
  for (const dir of [projectDirFor(activeWorkdir), projectDirFor(otherWorkdir), activeWorkdir, otherWorkdir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the list carries sessions from workdirs other than the active one", async () => {
  const ids = (await claudeThreadListPayload()).data.map((thread) => thread.id);
  assert.ok(ids.includes(activeId), "the active workdir's session must still be listed");
  assert.ok(ids.includes(otherId), "a session from another workdir must not vanish from the list");
});

test("each session reports the directory it belongs to, so it can be grouped", async () => {
  // The sidebar groups by cwd; without it every session collapses into one
  // heading and the grouping the user is asking for cannot exist.
  const threads = (await claudeThreadListPayload()).data;
  assert.equal(threads.find((thread) => thread.id === otherId).cwd, otherWorkdir);
  assert.equal(threads.find((thread) => thread.id === activeId).cwd, activeWorkdir);
});

test("a session that worked in a subfolder still belongs to the folder it was started in", async () => {
  // Reading the newest cwd instead filed it under the subfolder, where no
  // transcript by that id exists. The row was drawn under the wrong heading and
  // opening it ran `claude --resume` somewhere the CLI could not find it, so
  // the chat came back as an error rather than its own history.
  const threads = (await claudeThreadListPayload()).data;
  assert.equal(threads.find((thread) => thread.id === movedId).cwd, otherWorkdir);
  assert.equal(new ClaudeBridge(movedId, `${movedId}::k`).workdir, otherWorkdir);
  assert.equal(claudeSessionFilePath(movedId), path.join(projectDirFor(otherWorkdir), `${movedId}.jsonl`));
});

test("a session outside the active workdir can still be located by id", async () => {
  assert.equal(claudeSessionFilePath(otherId), path.join(projectDirFor(otherWorkdir), `${otherId}.jsonl`));
});

test("an id with nothing on disk resolves under the active workdir", () => {
  // A brand new session has no transcript yet, and it belongs where the bridge
  // is working rather than in whichever folder was scanned last.
  const unknown = "cccccccc-0000-0000-0000-000000000003";
  assert.equal(claudeSessionFilePath(unknown), path.join(projectDirFor(activeWorkdir), `${unknown}.jsonl`));
});

test("a traversing id is refused rather than escaping the projects folder", () => {
  assert.equal(claudeSessionFilePath("../../etc/passwd"), null);
  assert.equal(claudeSessionFilePath(""), null);
});

test("resuming follows the session to the directory it was started in", () => {
  // Continuing it from wherever the bridge is pointing would file the rest of
  // the conversation under a different project.
  assert.equal(claudeSessionWorkdir({ summary: { cwd: otherWorkdir } }), otherWorkdir);
});

test("a session whose folder is gone falls back instead of failing to open", () => {
  const missing = path.join(home, "scope-deleted-", "nope");
  assert.equal(claudeSessionWorkdir({ summary: { cwd: missing } }, activeWorkdir), activeWorkdir);
  assert.equal(claudeSessionWorkdir(null, activeWorkdir), activeWorkdir);
});

test("a session kept outside the home folder still opens where it lives", () => {
  // An external volume is an ordinary place to keep a repo. Falling back to the
  // configured workdir made the answer describe a different folder than the row
  // the session was opened from — `git remote -v` reporting the wrong repo.
  const volume = fs.mkdtempSync("/tmp/scope-volume-");
  try {
    assert.equal(claudeSessionWorkdir({ summary: { cwd: volume } }, activeWorkdir), volume);
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test("a folder that is not a folder any more falls back", () => {
  const file = path.join(activeWorkdir, "not-a-directory");
  fs.writeFileSync(file, "");
  try {
    assert.equal(claudeSessionWorkdir({ summary: { cwd: file } }, activeWorkdir), activeWorkdir);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a project can be kept out of the list, and put back", async () => {
  // Which folders hold tooling rather than work differs per machine — the home
  // folder is real work for some people and only memory hooks for others — so
  // this is a choice rather than a rule the bridge can infer.
  try {
    setWorkspaceHidden(otherWorkdir, true);
    const hiddenList = await claudeThreadListPayload();
    assert.ok(!hiddenList.data.some((thread) => thread.id === otherId), "a hidden project's sessions are not listed");
    assert.ok(hiddenList.data.some((thread) => thread.id === activeId), "everything else stays");
    assert.ok(hiddenList.hiddenProjects.includes(otherWorkdir), "the list is reported so there is a way back");

    setWorkspaceHidden(otherWorkdir, false);
    const shownList = await claudeThreadListPayload();
    assert.ok(shownList.data.some((thread) => thread.id === otherId));
    assert.deepEqual(shownList.hiddenProjects, []);
  } finally {
    setWorkspaceHidden(otherWorkdir, false);
  }
});

test("the workdir the bridge is running in cannot be hidden away", async () => {
  // There would be no way back to it from a sidebar that no longer lists it.
  try {
    setWorkspaceHidden(activeWorkdir, true);
    const payload = await claudeThreadListPayload();
    assert.ok(payload.data.some((thread) => thread.id === activeId));
    assert.ok(!payload.hiddenProjects.includes(activeWorkdir));
  } finally {
    setWorkspaceHidden(activeWorkdir, false);
  }
});

test("hiding accepts folders validateWorkdir would refuse", () => {
  // A folder worth keeping out of the list can sit on an external volume, or be
  // gone entirely. This is about the sidebar, not about where work may run.
  const volume = "/Volumes/SSD/archive";
  try {
    assert.equal(setWorkspaceHidden(`${volume}/`, true).path, volume);
    assert.ok(hiddenWorkspaces().includes(volume));
    assert.throws(() => setWorkspaceHidden("", true), /required/);
  } finally {
    setWorkspaceHidden(volume, false);
  }
});

test("each session's bridge holds its own directory, so opening one leaves the others alone", () => {
  // Nothing is moved and nothing accumulates: bridges are keyed per session, and
  // a bridge takes its directory once, at construction.
  const openA = () => new ClaudeBridge(activeId, `${activeId}::k`);
  const openB = () => new ClaudeBridge(otherId, `${otherId}::k`);

  for (let round = 0; round < 3; round += 1) {
    assert.equal(openA().workdir, activeWorkdir);
    assert.equal(openB().workdir, otherWorkdir);
    assert.equal(new ClaudeBridge(null, `new:${round}`).workdir, activeWorkdir, "a new chat still starts where the bridge is configured");
  }
});

test("coming back to a session reconnects to the bridge that is running it", () => {
  // The phone sends whichever directory it happens to know when it dials, and
  // that used to be part of the bridge key. Returning to a backgrounded tab
  // could land on a second bridge for the same session, built fresh from the
  // transcript: it reported the session idle while the turn it should have been
  // watching went on streaming into the first one.
  const running = getBridge(activeId, "claude", "conn-1", { workdir: activeWorkdir });
  try {
    running.activeTurnId = "claude-turn:in-flight";

    assert.equal(getBridge(activeId, "claude", "conn-2", {}), running, "a reconnect that names no folder");
    assert.equal(getBridge(activeId, "claude", "conn-3", { workdir: otherWorkdir }), running, "or names the wrong one");
    assert.equal(running.runPayload().state, "running", "the turn is still reported as running");
  } finally {
    running.activeTurnId = null;
    running.unwatchSession();
    running.closeApprovalServer();
  }
});

test("a new chat started from another project's heading opens in that project", () => {
  // While the sidebar showed one workdir this button could only mean the folder
  // the bridge was already in, so the request was dropped. Listing every project
  // turned it into a real one.
  assert.equal(new ClaudeBridge(null, "new:cross", { fresh: true, workdir: otherWorkdir }).workdir, otherWorkdir);
});

test("an unusable requested folder falls back rather than failing to open a chat", () => {
  assert.equal(new ClaudeBridge(null, "new:gone", { workdir: path.join(home, "no-such-folder-here") }).workdir, activeWorkdir);
  assert.equal(new ClaudeBridge(null, "new:outside", { workdir: "/etc" }).workdir, activeWorkdir);
});

test("an existing session ignores a requested folder and stays home", () => {
  // The session's own cwd is the one that keeps its transcript in one file.
  assert.equal(new ClaudeBridge(otherId, `${otherId}::k`, { workdir: activeWorkdir }).workdir, otherWorkdir);
});

test("the header is told the folder the turn will actually run in", () => {
  // It reported the configured workdir regardless, so opening a session from
  // another project left the header naming one folder while the turn ran in
  // another — and the answer described a repo the header did not name.
  const ready = new ClaudeBridge(otherId, `${otherId}::k`).readyPayload();
  assert.equal(ready.workdir, otherWorkdir);
  assert.notEqual(ready.workdir, activeWorkdir);
});
