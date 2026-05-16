const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { executeTerminalCommand } = require("./start-phone");

test("terminal command executes inside the requested workdir", async () => {
  const root = path.resolve(__dirname, "..");
  const result = await executeTerminalCommand("pwd", { cwd: root, timeoutMs: 2000, maxBytes: 4000 });
  assert.equal(result.code, 0);
  assert.equal(result.cwd, root);
  assert.equal(result.stdout, root);
  assert.equal(result.stderr, "");
});
