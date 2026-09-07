const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const startPhone = path.join(root, "scripts", "start-phone.js");

// Restarting exits 42 and relies on a supervisor to bring the bridge back, so
// these run a real bridge rather than stubbing the endpoint: the thing under
// test is what happens to the process.
function startBridge({ port, token, supervised }) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-test-"));
  const child = spawn(process.execPath, [startPhone], {
    cwd: root,
    env: {
      ...process.env,
      PHONE_AGENT_PROVIDER_DEFAULT: "claude",
      PHONE_WORKDIR: workdir,
      PHONE_UI_PORT: String(port),
      PHONE_TOKEN: token,
      ...(supervised ? { PHONE_SUPERVISED: "1" } : { PHONE_SUPERVISED: "" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const timer = setInterval(() => {
      if (/Press Ctrl\+C to stop/.test(output)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`bridge did not start: ${output.slice(-500)}`));
      }
    }, 100);
  });

  return { child, ready, workdir };
}

async function postRestart(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api/restart?token=${token}`, { method: "POST" });
  return { status: response.status, body: await response.json() };
}

function exitCode(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code));
  });
}

test("an unsupervised bridge refuses to restart instead of dying", async () => {
  const port = 45981;
  const token = "restart-unsupervised";
  const { child, ready, workdir } = startBridge({ port, token, supervised: false });
  try {
    await ready;
    const infoResponse = await fetch(`http://127.0.0.1:${port}/api/bridge/info`, { headers: { "x-phone-token": token } });
    const info = await infoResponse.json();
    assert.equal(infoResponse.status, 200);
    assert.equal(info.workdir, workdir);
    assert.equal(info.build.root, root, "application identity must not follow the selected chat folder");
    assert.equal(info.build.available, true);
    assert.equal(info.build.restartRequired, false);
    assert.match(info.build.fingerprint, /^[a-f0-9]{64}$/);
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    for (const file of ["main.js", "phone-ui-utils.js", "style.css"]) {
      assert.ok(html.includes(`${file}?v=${info.build.clientFingerprint}`), `${file} must use the full browser content identity`);
    }
    const { status, body } = await postRestart(port, token);

    assert.equal(status, 409);
    assert.equal(body.code, "restart_unsupervised");
    assert.match(body.error, /phone:loop/);

    // The point of the refusal: the bridge is still serving.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(child.exitCode, null, "the bridge must stay up");
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    child.kill("SIGTERM");
    await exitCode(child);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("a supervised bridge restarts by exiting 42 for its supervisor", async () => {
  const port = 45982;
  const token = "restart-supervised";
  const { child, ready, workdir } = startBridge({ port, token, supervised: true });
  try {
    await ready;
    const { status, body } = await postRestart(port, token);

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // 42 is the code `phone:loop` watches for; any other code stops the loop.
    assert.equal(await exitCode(child), 42);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exitCode(child);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("the supervisor scripts mark their children and cover both providers", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;

  assert.match(scripts["phone:loop"], /PHONE_SUPERVISED=1/);
  assert.match(scripts["phone:loop"], /"\$code" = 42/);
  assert.ok(scripts["phone:loop:claude"], "Claude needs a supervised entry point of its own");
  assert.match(scripts["phone:loop:claude"], /PHONE_AGENT_PROVIDER_DEFAULT=claude/);
  assert.match(scripts["phone:loop:claude"], /phone:loop/);
});
