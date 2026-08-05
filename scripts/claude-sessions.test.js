const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { listSessions, projectDirFor, summarize } = require("./claude-sessions");

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

test("a transcript with no exchange is not offered as a session", () => {
  const file = path.join(projectDir, "22222222-2222-2222-2222-222222222222.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ type: "queue-operation", sessionId: "22222222" })}\n`);

  assert.equal(summarize(file), null);
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
