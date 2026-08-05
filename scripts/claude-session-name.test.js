const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { claudeAcceptsNameFlag, claudeSessionName, readClaudeSessionFile } = require("./start-phone");

test("a session name carries the prompt behind a marker for where it came from", () => {
  assert.equal(claudeSessionName("レートリミットの表示を直して", "📱"), "📱 レートリミットの表示を直して");
});

test("newlines are folded so the picker gets one line", () => {
  assert.equal(claudeSessionName("first line\n\nsecond line", "📱"), "📱 first line second line");
});

test("a long prompt is trimmed rather than filling the picker", () => {
  const name = claudeSessionName("x".repeat(500), "📱");
  assert.ok(name.length <= 80, `name was ${name.length} characters`);
  assert.ok(name.startsWith("📱 xxx"));
});

test("an empty prompt produces no name rather than a bare marker", () => {
  // A name of just the marker would label every session identically, which is
  // no better than the uuid it replaces. An attachment-only turn lands here.
  assert.equal(claudeSessionName("   ", "📱"), "");
  assert.equal(claudeSessionName("", ""), "");
});

test("the --name flag is used only when the installed CLI advertises it", () => {
  // An older CLI rejects an unknown option outright, which would fail the turn
  // instead of merely losing the label.
  assert.equal(claudeAcceptsNameFlag(() => "  -n, --name <name>   Set a display name for this session"), true);
  assert.equal(claudeAcceptsNameFlag(() => "  --model <model>   Model for the current session"), false);
});

test("a CLI that cannot be probed at all is treated as not supporting it", () => {
  assert.equal(
    claudeAcceptsNameFlag(() => {
      throw new Error("spawn claude ENOENT");
    }),
    false,
  );
});

test("--name is not confused with a longer flag that starts the same way", () => {
  assert.equal(claudeAcceptsNameFlag(() => "  --names-only   unrelated"), false);
});

test("a name set on the desktop outranks the title Claude generated", () => {
  // `claude --name` and a desktop rename both write custom-title. Reading only
  // ai-title left the phone showing a different label than the /resume picker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-title-"));
  const file = path.join(dir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  try {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "custom-title", customTitle: "📱 レートリミット" }),
        JSON.stringify({ type: "ai-title", aiTitle: "Rate limit investigation" }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      ].join("\n") + "\n",
    );

    assert.equal(readClaudeSessionFile(file).summary.name, "📱 レートリミット");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
