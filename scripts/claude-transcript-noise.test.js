// A transcript is not a chat log. Alongside the conversation it carries system
// reminders, hook and observer prompts, subagent sidechains, the compact
// summary, and the synthetic pair Claude Code writes when a second process
// resumes a session that is still being worked on. The phone shows the
// conversation, so everything else has to be left where it lies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { historyKeepsLatestAnswer, readClaudeSessionFile } = require("./start-phone");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-noise-"));
const cwd = process.cwd();

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name, records) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function turn(role, text, extra = {}) {
  return {
    type: role,
    cwd,
    timestamp: new Date("2026-08-05T11:00:00Z").toISOString(),
    message: { role, content: [{ type: "text", text }] },
    ...extra,
  };
}

test("the synthetic resume pair never becomes the last thing the phone shows", () => {
  // Recorded from a session the phone owned while something else opened it: an
  // isMeta user turn nobody typed, answered by a <synthetic> assistant record,
  // both appended after the real answer. Read as chat, the answer the user was
  // waiting for stopped being the final one.
  const file = writeTranscript("synthetic-pair", [
    turn("user", "最新の回答が表示されない"),
    turn("assistant", "調べます。原因はこうです。"),
    turn("user", "Continue from where you left off.", { isMeta: true }),
    {
      type: "assistant",
      cwd,
      timestamp: new Date("2026-08-05T11:00:01Z").toISOString(),
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    },
  ]);

  const history = readClaudeSessionFile(file).history;
  assert.deepEqual(
    history.map((entry) => entry.type),
    ["user", "assistant"],
  );
  assert.equal(history.at(-1).text, "調べます。原因はこうです。");
});

test("reminders, sidechains, compact summaries and API errors stay out of the chat", () => {
  const file = writeTranscript("mixed-noise", [
    turn("user", "<system-reminder>plugin context</system-reminder>", { isMeta: true }),
    turn("user", "本題の質問"),
    turn("assistant", "本題の答え", { isSidechain: false }),
    turn("assistant", "サブエージェントの独り言", { isSidechain: true }),
    turn("user", "This session is being continued from a previous conversation", { isCompactSummary: true }),
    {
      type: "assistant",
      cwd,
      timestamp: new Date("2026-08-05T11:00:02Z").toISOString(),
      isApiErrorMessage: true,
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Prompt is too long" }] },
    },
  ]);

  const history = readClaudeSessionFile(file).history;
  assert.deepEqual(
    history.map((entry) => entry.text),
    ["本題の質問", "本題の答え"],
  );
});

test("a real turn typed somewhere else is still followed", () => {
  // The point of reading the file at all: work that carried on in the desktop
  // app or a terminal has to reach the phone.
  const file = writeTranscript("elsewhere", [turn("user", "端末で聞いた質問"), turn("assistant", "端末で返ってきた答え")]);
  const history = readClaudeSessionFile(file).history;
  assert.deepEqual(
    history.map((entry) => entry.text),
    ["端末で聞いた質問", "端末で返ってきた答え"],
  );
});

test("a transcript that has not caught up cannot redraw the newest answer away", () => {
  const streamed = [
    { type: "user", text: "質問" },
    { type: "assistant", text: "前置きです。そして本題の最終回答。" },
  ];
  // Longer, but the answer we just streamed is not in it yet.
  const behind = [
    { type: "user", text: "質問" },
    { type: "assistant", text: "前置きです。" },
    { type: "user", text: "別のところで足された発言" },
  ];
  assert.equal(historyKeepsLatestAnswer(behind, streamed), false);

  // The same answer, split the way the transcript records it. That is the view
  // worth adopting, so it must not be mistaken for one that is behind.
  const caughtUp = [
    { type: "user", text: "質問" },
    { type: "assistant", text: "前置きです。" },
    { type: "assistant", text: "そして本題の最終回答。" },
  ];
  assert.equal(historyKeepsLatestAnswer(caughtUp, streamed), true);
});

test("a first turn with nothing streamed yet adopts the file as it stands", () => {
  assert.equal(historyKeepsLatestAnswer([{ type: "user", text: "質問" }], [{ type: "user", text: "質問" }]), true);
});
