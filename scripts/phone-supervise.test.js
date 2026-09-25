const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { supervise, restartCode } = require("./phone-supervise");

test("a restart request starts the bridge again, any other exit ends supervision", async () => {
  const exits = [restartCode, restartCode, 0];
  let starts = 0;
  const exited = await new Promise((resolve) => {
    supervise({
      delayMs: 0,
      exit: resolve,
      spawnBridge() {
        starts += 1;
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", exits.shift()));
        return child;
      },
    });
  });
  assert.equal(starts, 3);
  assert.equal(exited, 0);
});

test("a crash is reported to the scheduler instead of hidden", async () => {
  const exited = await new Promise((resolve) => {
    supervise({
      exit: resolve,
      spawnBridge() {
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", null));
        return child;
      },
    });
  });
  assert.equal(exited, 1);
});
