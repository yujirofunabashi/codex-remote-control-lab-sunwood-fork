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

// Resuming a session whose last turn never finished - the bridge was restarted,
// or the Mac went down mid-answer - makes Claude Code write a synthetic pair to
// bridge the gap. It is written to the same transcript the phone follows, and
// with entrypoint "phone_bridge": the bridge's own next turn triggers it.
function syntheticResumePair(id) {
  const stamp = new Date().toISOString();
  return (
    `${JSON.stringify({
      type: "user",
      cwd: workdir,
      sessionId: id,
      timestamp: stamp,
      isMeta: true,
      message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
    })}\n` +
    `${JSON.stringify({
      type: "assistant",
      cwd: workdir,
      sessionId: id,
      timestamp: stamp,
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    })}\n`
  );
}

test("the pair written to resume a session is not mistaken for the newest answer", async () => {
  const id = "66666666-6666-6666-6666-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "質問", id) + record("assistant", "本当の回答", id));
  try {
    fs.appendFileSync(file, syntheticResumePair(id));
    await assert.rejects(historyChanged(seen, 900), /never reached the phone/);
    assert.equal(bridge.history.length, 2);
    assert.equal(bridge.history.at(-1).text, "本当の回答", "the answer the user is reading stays the last thing they see");
  } finally {
    bridge.unwatchSession();
  }
});

test("a transcript that has not caught up cannot redraw the newest answer away", async () => {
  const id = "77777777-7777-7777-7777-aaaaaaaaaaaa";
  const { bridge, seen, file } = openSession(id, record("user", "質問", id));
  try {
    // What a finished turn of our own leaves behind: streamed, appended here,
    // not yet in the file.
    bridge.appendHistory({ type: "assistant", text: "いま流し終えた回答", outputGroup: "claude-turn:local" });

    // The file grows, but with somebody else's turn rather than ours.
    fs.appendFileSync(file, record("user", "別のところで足された発言", id) + record("assistant", "別のところの答え", id));
    await assert.rejects(historyChanged(seen, 900), /never reached the phone/);
    assert.equal(bridge.history.at(-1).text, "いま流し終えた回答");

    // Once the file carries our answer too, following it is safe again.
    fs.appendFileSync(file, record("assistant", "いま流し終えた回答", id));
    await historyChanged(seen);
    assert.ok(bridge.history.some((entry) => entry.text === "いま流し終えた回答"));
  } finally {
    bridge.unwatchSession();
  }
});

test("a chat longer than the history cap still reports what was added to it", async () => {
  // Both views of a session are capped at the same number of entries, so past
  // that cap the transcript grows without ever getting longer. Comparing
  // lengths made every later write invisible - and the chats that reach the cap
  // are the long-running ones the phone is there to follow.
  const id = "88888888-8888-8888-8888-aaaaaaaaaaaa";
  let opening = "";
  for (let turn = 0; turn < 50; turn += 1) {
    opening += record("user", `古い質問 ${turn}`, id) + record("assistant", `古い答え ${turn}`, id);
  }
  const { bridge, seen, file } = openSession(id, opening);
  try {
    const capped = bridge.history.length;
    assert.ok(capped < 100, "the opening snapshot is already at the cap");

    fs.appendFileSync(file, record("user", "ターミナルで続きを入力", id) + record("assistant", "ターミナル側の最新の答え", id));
    await historyChanged(seen);

    assert.equal(bridge.history.length, capped, "the cap still holds");
    assert.equal(bridge.history.at(-1).text, "ターミナル側の最新の答え");
  } finally {
    bridge.unwatchSession();
  }
});

test("a phone that reconnects is told what happened while it was away", () => {
  // The watch is torn down with the last client and only reports what happens
  // next, so a screen lock or a walk out of range used to bring the phone back
  // to the snapshot it left.
  const id = "99999999-9999-9999-9999-aaaaaaaaaaaa";
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, record("user", "見ている間の発言", id) + record("assistant", "見ている間の答え", id));
  const bridge = new ClaudeBridge(id, `${id}::live`);
  const closers = [];
  bridge.addClient({ readyState: 1, send() {}, on: (event, handler) => event === "close" && closers.push(handler) });
  bridge.clients.clear();
  for (const close of closers) close();

  fs.appendFileSync(file, record("user", "離れている間の発言", id) + record("assistant", "離れている間の答え", id));

  const seen = [];
  bridge.addClient(fakeClient(seen));
  try {
    const ready = seen.find((message) => message.type === "ready");
    assert.ok(ready, "the arriving phone is sent a thread to draw");
    assert.equal(ready.history.at(-1).text, "離れている間の答え");
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
