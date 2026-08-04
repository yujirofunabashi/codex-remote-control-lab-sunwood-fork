const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PHONE_AGENT_PROVIDER = "claude";

const { summarizeClaudeToolResult, summarizeClaudeToolUse } = require("./start-phone");

test("bash tool use reads like the Codex status log", () => {
  const text = summarizeClaudeToolUse({
    type: "tool_use",
    name: "Bash",
    input: { command: "npm test", description: "run the suite" },
  });

  assert.equal(text, "$ npm test");
});

test("file-writing tools report as file changes", () => {
  for (const name of ["Edit", "Write", "NotebookEdit"]) {
    const text = summarizeClaudeToolUse({ type: "tool_use", name, input: { file_path: "scripts/start-phone.js" } });
    assert.equal(text, "file changes: scripts/start-phone.js");
  }
});

test("search and read tools get their own prefixes", () => {
  assert.equal(summarizeClaudeToolUse({ type: "tool_use", name: "Read", input: { file_path: "README.md" } }), "read: README.md");
  assert.equal(summarizeClaudeToolUse({ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }), "grep: TODO");
  assert.equal(summarizeClaudeToolUse({ type: "tool_use", name: "Glob", input: { pattern: "**/*.js" } }), "glob: **/*.js");
});

test("mcp tool names are flattened for display", () => {
  const text = summarizeClaudeToolUse({ type: "tool_use", name: "mcp__github__create_pull_request", input: {} });
  assert.equal(text, "mcp: github / create_pull_request");
});

test("long commands are truncated so one tool call cannot flood the log", () => {
  const text = summarizeClaudeToolUse({ type: "tool_use", name: "Bash", input: { command: "x".repeat(900) } });

  assert.ok(text.length <= 301, `expected truncation, got ${text.length} chars`);
  assert.ok(text.endsWith("…"));
});

test("multi-line commands collapse to a single status line", () => {
  const text = summarizeClaudeToolUse({
    type: "tool_use",
    name: "Bash",
    input: { command: "set -e\nnpm ci\nnpm test" },
  });

  assert.equal(text, "$ set -e npm ci npm test");
  assert.ok(!text.includes("\n"));
});

test("non tool_use blocks produce nothing", () => {
  assert.equal(summarizeClaudeToolUse({ type: "text", text: "hello" }), null);
  assert.equal(summarizeClaudeToolUse(null), null);
});

test("successful tool results stay quiet", () => {
  assert.equal(summarizeClaudeToolResult({ type: "tool_result", content: "ok", is_error: false }), null);
});

test("failed tool results surface the error", () => {
  const text = summarizeClaudeToolResult({ type: "tool_result", content: "command not found: fooo", is_error: true });
  assert.equal(text, "failed: command not found: fooo");
});

test("failed tool results with structured content are flattened", () => {
  const text = summarizeClaudeToolResult({
    type: "tool_result",
    content: [{ type: "text", text: "permission denied" }],
    is_error: true,
  });

  assert.equal(text, "failed: permission denied");
});
