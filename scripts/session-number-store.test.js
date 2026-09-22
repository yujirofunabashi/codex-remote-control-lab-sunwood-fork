const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SessionNumberStore, sessionNumberDirectory } = require("./session-number-store");

const session = (threadId, provider = "codex") => ({ provider, threadId });
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phone-session-numbers-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("numbers survive new stores, reordered requests, missing siblings and new sessions", t => {
  const directory = temporary(t);
  const first = new SessionNumberStore(directory);
  assert.deepEqual(first.assign([session("one"), session("two")]).map(item => item.sessionNumber), [1, 2]);
  const other = new SessionNumberStore(directory);
  assert.deepEqual(other.assign([session("two"), session("three"), session("one")]).map(item => item.sessionNumber), [2, 3, 1]);
  assert.equal(first.assign([session("three")])[0].sessionNumber, 3, "a long-lived bridge reads another slot's assignment");
  assert.deepEqual(new SessionNumberStore(directory).assign([session("one"), session("four")]).map(item => item.sessionNumber), [1, 4]);
  assert.equal(fs.statSync(path.join(directory, "codex", "1.json")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(directory, "codex")).sort(), ["1.json", "2.json", "3.json", "4.json"]);
});

test("machines and providers keep separate numbering; paths do not depend on ports or worktrees", t => {
  const directory = temporary(t);
  const mini = new SessionNumberStore(path.join(directory, "mini"));
  const air = new SessionNumberStore(path.join(directory, "air"));
  assert.deepEqual(mini.assign([session("one"), session("two"), session("two", "claude"), session("two", "gemini")]).map(item => item.sessionNumber), [1, 2, 1, 1]);
  assert.equal(air.assign([session("two")])[0].sessionNumber, 1);
  assert.equal(sessionNumberDirectory({ PHONE_UI_PORT: "1" }, directory), sessionNumberDirectory({ PHONE_UI_PORT: "2" }, directory));
  assert.equal(sessionNumberDirectory({ PHONE_SESSION_NUMBERS_DIR: directory }, "/unused"), directory);
});

test("invalid requests and unreadable records never reset existing numbers", t => {
  const directory = temporary(t);
  const store = new SessionNumberStore(directory);
  for (const request of [null, [session("one"), session("../../escape", "../outside")], [session(12)], Array(65).fill(session("one"))]) {
    assert.throws(() => store.assign(request), TypeError);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
  store.assign([session("one")]);
  const file = path.join(directory, "codex", "1.json");
  fs.writeFileSync(file, "broken fixture");
  assert.throws(() => new SessionNumberStore(directory).assign([session("two")]));
  assert.equal(fs.readFileSync(file, "utf8"), "broken fixture");
  assert.equal(fs.existsSync(path.join(directory, "codex", "2.json")), false);
});

test("simultaneous bridge processes allocate one shared number without collisions", async t => {
  const directory = temporary(t);
  const worker = `
    const { SessionNumberStore } = require(process.argv[1]);
    const store = new SessionNumberStore(process.argv[2]);
    process.stdin.once('data', () => {
      const items = JSON.parse(process.argv[3]);
      process.stdout.write(JSON.stringify(store.assign(items)));
    });
    process.stdout.write('ready\\n');
  `;
  const children = Array.from({ length: 8 }, (_, index) => {
    const items = Array.from({ length: 20 }, (__, offset) => session(`thread-${(index + offset) % 20}`));
    const child = spawn(process.execPath, ["-e", worker, require.resolve("./session-number-store"), directory, JSON.stringify(items)], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const ready = new Promise(resolve => child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) resolve(); }));
    child.stderr.on("data", chunk => { errors += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(JSON.parse(output.slice(output.indexOf("\n") + 1))) : reject(new Error(errors || `worker ${code}`)));
    });
    return { child, ready, done };
  });
  t.after(() => children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map(item => item.ready));
  children.forEach(({ child }) => child.stdin.end("go"));
  const results = await Promise.all(children.map(item => item.done));
  const assigned = new Map();
  for (const item of results.flat()) {
    if (assigned.has(item.threadId)) assert.equal(assigned.get(item.threadId), item.sessionNumber);
    assigned.set(item.threadId, item.sessionNumber);
  }
  assert.equal(assigned.size, 20);
  assert.equal(new Set(assigned.values()).size, 20);
  assert.equal(fs.readdirSync(path.join(directory, "codex")).length, 20);
});
