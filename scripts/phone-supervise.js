// Keeps the bridge running where `npm run phone:loop` cannot: that loop is a
// POSIX shell one-liner, and Windows has no sh. Same contract as the loop:
// exit 42 is the bridge asking to be started again (POST /api/restart), any
// other exit ends supervision with that code so the scheduler sees it.
const { spawn } = require("node:child_process");
const path = require("node:path");

const restartCode = 42;

function supervise({ spawnBridge = defaultSpawn, delayMs = 1000, exit = process.exit } = {}) {
  const child = spawnBridge();
  child.on("exit", (code) => {
    if (code === restartCode) {
      setTimeout(() => supervise({ spawnBridge, delayMs, exit }), delayMs);
      return;
    }
    exit(code ?? 1);
  });
  return child;
}

function defaultSpawn() {
  return spawn(process.execPath, [path.join(__dirname, "start-phone.js")], {
    stdio: "inherit",
    env: { ...process.env, PHONE_SUPERVISED: "1" },
  });
}

if (require.main === module) supervise();

module.exports = { supervise, restartCode };
