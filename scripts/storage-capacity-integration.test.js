const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "start-phone.js"), "utf8");

function section(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(text, first, second) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing marker: ${first}`);
  assert.notEqual(secondIndex, -1, `missing marker: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`);
}

test("data URL attachments gate before base64 decode and local file creation", () => {
  const text = section("function saveDataUrlAttachment", "function sandboxPolicyForMode");
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "upload")', "Buffer.from(match[2], \"base64\")");
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "upload")', "const record = createUploadRecord(");
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "upload")', "fs.writeFileSync(");
});

test("prompt ingress and queued dispatch both gate before dispatch or queue shift", () => {
  const prompt = section("  prompt(text, attachments", "  startNextQueuedTurn()");
  assertBefore(prompt, 'assertStorageCapacityIngress(uiPort, "prompt")', "this.turnQueue.push(");
  assertBefore(prompt, 'assertStorageCapacityIngress(uiPort, "prompt")', "this.startPrompt(");

  const queued = section("  startNextQueuedTurn()", "  syncHistory(reason)");
  assertBefore(queued, 'assertStorageCapacityIngress(uiPort, "prompt")', "this.turnQueue.shift()");
  assertBefore(queued, 'assertStorageCapacityIngress(uiPort, "prompt")', "this.startPrompt(");
});

test("HTTP upload gates before upload record creation and stream write", () => {
  const text = section('    if (url.pathname === "/api/upload")', '    if (url.pathname === "/api/restart")');
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "upload")', "const record = createUploadRecord(");
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "upload")', "writeUploadStream(");
});

test("terminal endpoint gates after read-only parsing and before command dispatch", () => {
  const text = section('    if (url.pathname === "/api/terminal/run")', '    if (url.pathname === "/api/status")');
  assertBefore(text, "await readJsonBody(req)", 'assertStorageCapacityIngress(uiPort, "terminal")');
  assertBefore(text, 'assertStorageCapacityIngress(uiPort, "terminal")', "executeTerminalCommand(");
});

test("read-only status route does not invoke the capacity writer gate", () => {
  const text = section('    if (url.pathname === "/api/status")', '    if (url.pathname === "/api/review/diff")');
  assert.doesNotMatch(text, /assertStorageCapacityIngress/);
});
