const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { debugLog, debugTimer, isDebugEnabled, redactSensitiveText, resetDebugLogState } = require("./debug-log");

function withDebugLog(run, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-debug-test-"));
  const logPath = path.join(dir, "debug.log");
  const previous = { ...process.env };
  process.env.PHONE_DEBUG = "1";
  process.env.PHONE_DEBUG_FILE = logPath;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  resetDebugLogState();
  try {
    return run(logPath);
  } finally {
    for (const key of ["PHONE_DEBUG", "PHONE_DEBUG_FILE", "PHONE_DEBUG_MAX_BYTES"]) delete process.env[key];
    Object.assign(process.env, previous);
    resetDebugLogState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readEntries(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("debug logging stays off until PHONE_DEBUG is set", () => {
  const previous = process.env.PHONE_DEBUG;
  delete process.env.PHONE_DEBUG;
  try {
    assert.equal(isDebugEnabled(), false);
    assert.equal(debugLog("stream.line", { type: "assistant" }), false);
  } finally {
    if (previous === undefined) delete process.env.PHONE_DEBUG;
    else process.env.PHONE_DEBUG = previous;
  }
});

test("falsy PHONE_DEBUG values leave logging off", () => {
  const previous = process.env.PHONE_DEBUG;
  try {
    for (const value of ["0", "false", "off", "no", ""]) {
      process.env.PHONE_DEBUG = value;
      assert.equal(isDebugEnabled(), false, `expected ${JSON.stringify(value)} to stay off`);
    }
  } finally {
    if (previous === undefined) delete process.env.PHONE_DEBUG;
    else process.env.PHONE_DEBUG = previous;
  }
});

test("each entry is one JSON line carrying event, sequence and fields", () => {
  withDebugLog((logPath) => {
    debugLog("stream.line", { type: "assistant", handled: "assistant" });
    debugLog("stream.line", { type: "result", handled: "result" });
    const entries = readEntries(logPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, "stream.line");
    assert.equal(entries[0].type, "assistant");
    assert.equal(entries[0].seq, 1);
    assert.equal(entries[1].seq, 2);
    assert.equal(entries[1].handled, "result");
    assert.equal(typeof entries[0].ts, "string");
    assert.equal(entries[0].pid, process.pid);
  });
});

test("tokens and bearer headers are redacted before they reach the file", () => {
  withDebugLog((logPath) => {
    debugLog("bridge.url", {
      url: "http://192.168.1.10:8080/?token=super-secret-value&x=1",
      header: "authorization: bearer abcdefghijklmnopqrst",
      nested: { env: "PHONE_TOKEN=another-secret-value" },
    });
    const raw = fs.readFileSync(logPath, "utf8");
    assert.ok(!raw.includes("super-secret-value"));
    assert.ok(!raw.includes("abcdefghijklmnopqrst"));
    assert.ok(!raw.includes("another-secret-value"));
    assert.ok(raw.includes("[redacted]"));
    const entry = readEntries(logPath)[0];
    assert.equal(entry.url, "http://192.168.1.10:8080/?token=[redacted]&x=1");
  });
});

test("long strings are capped and report what was dropped", () => {
  withDebugLog((logPath) => {
    debugLog("stream.line", { text: "x".repeat(2000) });
    const entry = readEntries(logPath)[0];
    assert.ok(entry.text.length < 900);
    assert.ok(entry.text.endsWith("[+1200 chars]"));
  });
});

test("deep structures are bounded instead of serialized whole", () => {
  withDebugLog((logPath) => {
    debugLog("tool.input", {
      items: Array.from({ length: 50 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: "too far" } } } } },
    });
    const entry = readEntries(logPath)[0];
    assert.equal(entry.items.length, 21);
    assert.equal(entry.items[20], "[+30 more]");
    assert.equal(entry.deep.a.b.c, "[depth limit]");
  });
});

test("errors keep their message instead of serializing to an empty object", () => {
  withDebugLog((logPath) => {
    debugLog("turn.failed", { error: new Error("claude spawn failed") });
    const entry = readEntries(logPath)[0];
    assert.equal(entry.error.name, "Error");
    assert.equal(entry.error.message, "claude spawn failed");
  });
});

test("the log rolls one generation once it passes the size cap", () => {
  withDebugLog(
    (logPath) => {
      for (let index = 0; index < 12; index += 1) debugLog("stream.line", { index, text: "y".repeat(200) });
      assert.ok(fs.existsSync(`${logPath}.1`));
      const current = readEntries(logPath);
      assert.ok(current.length < 12);
      assert.ok(fs.statSync(logPath).size <= 1024);
    },
    { PHONE_DEBUG_MAX_BYTES: "1024" },
  );
});

test("a timer records elapsed time only when the step ends", () => {
  withDebugLog((logPath) => {
    const done = debugTimer("turn", { turnId: "turn-1" });
    assert.equal(fs.existsSync(logPath), false);
    done({ status: "completed" });
    const entry = readEntries(logPath)[0];
    assert.equal(entry.event, "turn");
    assert.equal(entry.turnId, "turn-1");
    assert.equal(entry.status, "completed");
    assert.equal(typeof entry.durationMs, "number");
  });
});

test("a timer taken while debugging is off stays inert", () => {
  const previous = process.env.PHONE_DEBUG;
  delete process.env.PHONE_DEBUG;
  try {
    assert.equal(debugTimer("turn")(), false);
  } finally {
    if (previous === undefined) delete process.env.PHONE_DEBUG;
    else process.env.PHONE_DEBUG = previous;
  }
});

test("redaction matches the terminal history rules", () => {
  assert.equal(redactSensitiveText("open ?token=abc123def456"), "open ?token=[redacted]");
  assert.equal(redactSensitiveText(""), "");
  assert.equal(redactSensitiveText(null), "");
});
