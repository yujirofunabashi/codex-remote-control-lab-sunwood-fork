const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listAllSessions, listSessions, projectDirFor, summarize } = require("./claude-sessions");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-cwd-"));
const projectDir = projectDirFor(workdir);
fs.mkdirSync(projectDir, { recursive: true });

test.after(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

// Shaped after a transcript the bridge actually produced.
function writeSession(id, { title, prompts = [], at = Date.now() } = {}) {
  const stamp = new Date(at).toISOString();
  const lines = [];
  if (title) lines.push({ type: "ai-title", aiTitle: title, sessionId: id });
  for (const prompt of prompts) {
    lines.push({
      type: "user",
      cwd: workdir,
      sessionId: id,
      timestamp: stamp,
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    });
    lines.push({
      type: "assistant",
      cwd: workdir,
      sessionId: id,
      timestamp: stamp,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    });
  }
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  fs.utimesSync(file, at / 1000, at / 1000);
  return file;
}

test("the project directory matches how Claude Code slugs a workdir", () => {
  // Any character outside [A-Za-z0-9] becomes a dash; that mapping is what makes
  // a transcript findable from the directory it belongs to.
  assert.equal(projectDirFor("/Users/me/My Project"), path.join(os.homedir(), ".claude", "projects", "-Users-me-My-Project"));
});

test("a session reports its title, prompt, and message count", () => {
  const file = writeSession("11111111-1111-1111-1111-111111111111", {
    title: "Fix the bridge",
    prompts: ["make the tests pass"],
  });
  const session = summarize(file);

  assert.equal(session.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(session.title, "Fix the bridge");
  assert.equal(session.firstPrompt, "make the tests pass");
  assert.equal(session.messages, 2);
  assert.equal(session.cwd, workdir);
});

test("a transcript with no exchange is still listed", () => {
  // The phone shows these rows as 名前未設定のチャット. Dropping them here
  // produced exactly the mismatch being reported: a row visible on the phone
  // with nothing matching it on the desktop.
  const file = path.join(projectDir, "22222222-2222-2222-2222-222222222222.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ type: "queue-operation", sessionId: "22222222" })}\n`);

  const session = summarize(file);
  assert.equal(session.id, "22222222-2222-2222-2222-222222222222");
  assert.equal(session.messages, 0);
});

test("sessions are listed newest first", () => {
  const now = Date.now();
  writeSession("33333333-3333-3333-3333-333333333333", { prompts: ["older"], at: now - 3600000 });
  writeSession("44444444-4444-4444-4444-444444444444", { prompts: ["newer"], at: now });

  const ids = listSessions(workdir).sessions.map((session) => session.id);
  assert.ok(ids.indexOf("44444444-4444-4444-4444-444444444444") < ids.indexOf("33333333-3333-3333-3333-333333333333"));
});

test("listing is capped by the requested limit", () => {
  assert.equal(listSessions(workdir, 1).sessions.length, 1);
});

test("a workdir with no transcripts lists nothing rather than failing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-empty-"));
  try {
    const result = listSessions(empty);
    assert.deepEqual(result.sessions, []);
    assert.equal(result.dir, projectDirFor(empty));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a malformed line does not discard the rest of the transcript", () => {
  const id = "55555555-5555-5555-5555-555555555555";
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      "{ not json",
      JSON.stringify({ type: "user", cwd: workdir, message: { role: "user", content: [{ type: "text", text: "still here" }] } }),
    ].join("\n") + "\n",
  );

  const session = summarize(file);
  assert.equal(session.firstPrompt, "still here");
});

test("listing every workdir finds sessions the active one would hide", () => {
  // The reported symptom: change the bridge's workdir and earlier sessions
  // vanish from anything scoped to a single folder. They were never lost.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-other-"));
  const otherDir = projectDirFor(other);
  fs.mkdirSync(otherDir, { recursive: true });
  const id = "66666666-6666-6666-6666-666666666666";
  fs.writeFileSync(
    path.join(otherDir, `${id}.jsonl`),
    JSON.stringify({
      type: "user",
      cwd: other,
      sessionId: id,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "work from another folder" }] },
    }) + "\n",
  );

  try {
    // Scoped to the original workdir, the other folder's session is invisible.
    assert.ok(!listSessions(workdir).sessions.some((session) => session.id === id));

    const groups = listAllSessions().groups;
    const group = groups.find((item) => item.cwd === other);
    assert.ok(group, "every workdir with sessions must appear");
    assert.ok(group.sessions.some((session) => session.id === id));
  } finally {
    fs.rmSync(otherDir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a group reports the real cwd from the transcript, not the slug", () => {
  // The slug is lossy, so it cannot be turned back into a path to cd into.
  const group = listAllSessions().groups.find((item) => item.cwd === workdir);
  assert.ok(group);
  assert.equal(group.cwd, workdir);
  assert.notEqual(group.cwd, group.dir);
});

test("groups are ordered by most recent activity", () => {
  const groups = listAllSessions().groups;
  for (let i = 1; i < groups.length; i += 1) {
    assert.ok(groups[i - 1].updatedAt >= groups[i].updatedAt);
  }
});

test("a name set with --name or renamed on the desktop is carried", () => {
  // This is the label the /resume picker shows, so matching it here is what
  // lets a row be recognised from either side.
  const id = "88888888-8888-8888-8888-888888888888";
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "custom-title", customTitle: "📱 レートリミット", sessionId: id }),
      JSON.stringify({ type: "ai-title", aiTitle: "Rate limit investigation", sessionId: id }),
      JSON.stringify({ type: "user", cwd: workdir, message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n") + "\n",
  );

  const session = summarize(file);
  assert.equal(session.customTitle, "📱 レートリミット");
  assert.equal(session.title, "Rate limit investigation");
});

test("both the first and the latest prompt are carried", () => {
  // The phone labels a row by its latest message; this labelled it by its
  // first, so one session looked like two different ones.
  const id = "77777777-7777-7777-7777-777777777777";
  const file = writeSession(id, { prompts: ["first thing", "second thing", "latest thing"] });
  const session = summarize(file);

  assert.equal(session.firstPrompt, "first thing");
  assert.equal(session.lastPrompt, "latest thing");
});
