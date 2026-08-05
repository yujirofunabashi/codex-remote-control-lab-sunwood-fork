// A session is one file, and the desktop app, the terminal CLI and this bridge
// all append to the same one. Without following it, the phone shows the snapshot
// it read when the thread was opened and never learns the work carried on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = os.homedir();
const workdir = fs.mkdtempSync(path.join(home, "live-session-"));

process.env.PHONE_AGENT_PROVIDER_DEFAULT = "claude";
process.env.PHONE_WORKDIR = workdir;
process.env.PHONE_CLAUDE_WATCH_INTERVAL_MS = "250";

const { ClaudeBridge } = require("./start-phone");

const projectDir = path.join(home, ".claude", "projects", path.resolve(workdir).replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(projectDir, { recursive: true });

test.after(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

function record(role, text, id) {
  return `${JSON.stringify({
    type: role,
    cwd: workdir,
    sessionId: id,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
  })}\n`;
}

function fakeClient(seen) {
  return {
    readyState: 1,
    send(body) {
      seen.push(JSON.parse(body));
    },
    on() {},
  };
}

// Resolves once the bridge reports the session grew, rather than sleeping for a
// fixed time and hoping the poll landed inside it.
function historyChanged(seen, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const message = seen.find((entry) => entry.type === "historyChanged");
      if (message) {
        clearInterval(timer);
        resolve(message);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("the session change never reached the phone"));
      }
    }, 40);
  });
}

function openSession(id, lines) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines);
  const bridge = new ClaudeBridge(id, `${id}::live`);
  const seen = [];
  bridge.addClient(fakeClient(seen));
  return { bridge, seen, file: path.join(projectDir, `${id}.jsonl`) };
}

test("work continued in the desktop app reaches a phone already looking at it", async () => {
  const id = "11111111-1111-1111-1111-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "デスクトップで始めた作業", id) + record("assistant", "了解しました", id));
  try {
    assert.equal(bridge.history.length, 2, "the snapshot read when the thread was opened");

    fs.appendFileSync(file, record("user", "デスクトップ側で続きを入力", id) + record("assistant", "続きを実行しました", id));
    const message = await historyChanged(seen);

    assert.equal(message.messages, 4);
    assert.equal(bridge.history.length, 4);
    assert.equal(bridge.history[bridge.history.length - 1].text, "続きを実行しました");
  } finally {
    bridge.unwatchSession();
  }
});

test("catching up does not throw away the tool activity log", async () => {
  // A transcript carries no status or error records, so rebuilding the terminal
  // view from one yields nothing — and would erase what this bridge watched go
  // by while it was the one running turns.
  const id = "22222222-2222-2222-2222-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "最初", id));
  try {
    bridge.appendTerminal({ kind: "command", message: "$ npm test" });
    const before = bridge.terminalHistory.length;

    fs.appendFileSync(file, record("assistant", "外側から追記", id));
    await historyChanged(seen);

    assert.ok(bridge.terminalHistory.length >= before);
    assert.ok(bridge.terminalHistory.some((entry) => entry.message.includes("npm test")));
  } finally {
    bridge.unwatchSession();
  }
});

test("a file that only changed timestamp does not redraw the conversation", async () => {
  const id = "33333333-3333-3333-3333-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "変化なし", id));
  try {
    const at = Date.now() + 5000;
    fs.utimesSync(file, at / 1000, at / 1000);
    await assert.rejects(historyChanged(seen, 700), /never reached the phone/);
    assert.equal(bridge.history.length, 1);
  } finally {
    bridge.unwatchSession();
  }
});

test("a turn of our own is left to its own stream", async () => {
  // The deltas already on screen are the live view; swapping history underneath
  // them would fight what the user is watching arrive.
  const id = "44444444-4444-4444-4444-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "送信中", id));
  try {
    bridge.activeTurnId = "claude-turn:pretend";
    fs.appendFileSync(file, record("assistant", "こちらのターンの出力", id));
    await assert.rejects(historyChanged(seen, 700), /never reached the phone/);
    assert.equal(bridge.history.length, 1);

    bridge.activeTurnId = null;
    fs.appendFileSync(file, record("user", "ターンが終わったあと", id));
    await historyChanged(seen);
    assert.equal(bridge.history.length, 3, "everything written meanwhile arrives once the turn is done");
  } finally {
    bridge.unwatchSession();
  }
});

test("the last phone to close stops the watch", () => {
  const id = "55555555-5555-5555-5555-aaaaaaaaaaaa";
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), record("user", "見ている人はいない", id));
  const bridge = new ClaudeBridge(id, `${id}::live`);
  const closers = [];
  bridge.addClient({ readyState: 1, send() {}, on: (event, handler) => event === "close" && closers.push(handler) });
  assert.ok(bridge.sessionWatchPath, "watching while someone is looking");

  bridge.clients.clear();
  for (const close of closers) close();
  assert.equal(bridge.sessionWatchPath, "", "a stat per second for a session nobody has open is waste");
});
