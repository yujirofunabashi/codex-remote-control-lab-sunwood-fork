const test = require("node:test");
const assert = require("node:assert/strict");

const { classifySlashCommand, normalizeCommandName, shortDescription, slashCommandCatalog } = require("./slash-commands");

test("a command is named the same with or without its leading slash", () => {
  assert.equal(normalizeCommandName("/clear"), "clear");
  assert.equal(normalizeCommandName("clear"), "clear");
  assert.equal(normalizeCommandName("  /compact  "), "compact");
  assert.equal(normalizeCommandName(""), "");
});

test("a command says which of the three kinds it is", () => {
  const skills = ["document-maintainer", "verify"];
  assert.equal(classifySlashCommand("clear", skills), "builtin");
  assert.equal(classifySlashCommand("verify", skills), "skill");
  assert.equal(classifySlashCommand("claude-mem:do", skills), "plugin");
  // The leading slash must not change the answer.
  assert.equal(classifySlashCommand("/document-maintainer", skills), "skill");
});

test("a skill's trigger-matching blurb is cut back to its first sentence", () => {
  assert.equal(
    shortDescription("Create, update, or review canonical docs. Trigger on 「ドキュメント」「更新」."),
    "Create, update, or review canonical docs",
  );
  assert.equal(shortDescription("日本語の説明です。トリガー: 「整理」"), "日本語の説明です");
  assert.equal(shortDescription("   "), "");
  assert.equal(shortDescription(null), "");
});

test("a description too long for a phone row is cut with a marker", () => {
  const long = `${"あ".repeat(120)}。`;
  const short = shortDescription(long);
  assert.equal(short.length, 75);
  assert.ok(short.endsWith("…"));
});

test("the catalog carries every command, described where a description exists", () => {
  const catalog = slashCommandCatalog({
    commands: ["clear", "verify", "claude-mem:do"],
    skills: ["verify"],
    descriptions: { verify: "作業結果が通るか確かめます。トリガー: 「検証」" },
  });
  assert.deepEqual(
    catalog.map((item) => [item.name, item.kind]),
    [
      ["clear", "builtin"],
      ["verify", "skill"],
      ["claude-mem:do", "plugin"],
    ],
  );
  assert.equal(catalog[0].description, "会話をリセットして最初から");
  assert.equal(catalog[1].description, "作業結果が通るか確かめます");
  // No invented sentence for a plugin command that supplied none.
  assert.equal(catalog[2].description, "");
});

test("built-ins come first, then skills, then plugins, alphabetical within each", () => {
  const catalog = slashCommandCatalog({
    commands: ["claude-mem:do", "verify", "model", "agents", "batch"],
    skills: ["verify", "batch"],
  });
  assert.deepEqual(catalog.map((item) => item.name), ["agents", "model", "batch", "verify", "claude-mem:do"]);
});

test("commands that only answer that they are unavailable are left out", () => {
  const catalog = slashCommandCatalog({ commands: ["help", "clear", "heapdump"], skills: [] });
  assert.deepEqual(catalog.map((item) => item.name), ["clear"]);
});

test("a repeated command is listed once", () => {
  const catalog = slashCommandCatalog({ commands: ["clear", "/clear", "clear"], skills: [] });
  assert.equal(catalog.length, 1);
});

test("no session data yields an empty catalog rather than a throw", () => {
  assert.deepEqual(slashCommandCatalog(), []);
  assert.deepEqual(slashCommandCatalog({ commands: null, skills: null }), []);
});
