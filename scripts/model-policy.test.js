const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../public/model-policy");

test("the floor admits every 5.6 role and newer generations without preferring Astra", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.0-nova", "gpt-7-preview"]) {
    assert.equal(policy.eligibleCodexModel(model), true, model);
  }
  for (const model of ["gpt-5.5", "gpt-5.4-mini", "gpt-5-codex", "gpt-4.1", "gpt-5.5-gpt-6", "astra", "o3", "", null, "gpt-6\nignore", "gpt-6/other"]) {
    assert.equal(policy.eligibleCodexModel(model), false, String(model));
  }
});

test("a generation rule does not prove availability or replace a missing model", () => {
  assert.equal(policy.selectionError("codex", "gpt-5.6-terra", ["gpt-5.6-terra"]), "");
  assert.match(policy.selectionError("codex", "gpt-6-astra", ["gpt-5.6-terra"]), /候補/);
  assert.match(policy.selectionError("codex", "gpt-5.6-luna", []), /候補/);
  assert.deepEqual(policy.choices("codex", ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"]), ["gpt-5.6-terra", "gpt-5.6-luna"]);
});

test("Claude and Gemini are not forced onto a GPT model or a flagship alias", () => {
  assert.deepEqual(policy.choices("claude", ["sonnet", "haiku", "opus", "fable"]), ["sonnet", "haiku", "opus", "fable"]);
  assert.equal(policy.selectionError("claude", "sonnet", ["fable"]), "");
  assert.equal(policy.selectionError("gemini", "gemini-3.8-flash-high"), "");
});
