const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CAPACITY_PROTECTION_MESSAGE,
  INGRESS_WRITERS_BY_PORT,
  STORAGE_CAPACITY_GATE_HOME,
  STORAGE_CAPACITY_GATE_PATH,
  STORAGE_CAPACITY_GATE_PATH_ENV,
  STORAGE_CAPACITY_GATE_TIMEOUT_MS,
  assertStorageCapacityIngress,
  ingressWriterForPort,
  storageCapacityErrorPayload,
} = require("./storage-capacity-gate");

test("maps both resident ports to their exact parent and ingress writer IDs", () => {
  assert.deepEqual(INGRESS_WRITERS_BY_PORT, {
    45214: {
      parentWriterId: "mini.phone_bridge_45214",
      writers: {
        prompt: "mini.phone_bridge_45214_prompt",
        upload: "mini.phone_bridge_45214_upload",
        terminal: "mini.phone_bridge_45214_terminal",
      },
    },
    45244: {
      parentWriterId: "mini.phone_bridge_45244",
      writers: {
        prompt: "mini.phone_bridge_45244_prompt",
        upload: "mini.phone_bridge_45244_upload",
        terminal: "mini.phone_bridge_45244_terminal",
      },
    },
  });
  assert.equal(ingressWriterForPort(45214, "prompt").writerId, "mini.phone_bridge_45214_prompt");
  assert.equal(ingressWriterForPort("45244", "terminal").parentWriterId, "mini.phone_bridge_45244");
});

test("rejects an unregistered port or ingress without running a command", () => {
  let calls = 0;
  const spawnSync = () => {
    calls += 1;
    return { status: 0 };
  };
  assert.throws(() => assertStorageCapacityIngress(45224, "prompt", { spawnSync }), { code: "storage_capacity_protected" });
  assert.throws(() => assertStorageCapacityIngress(45214, "unknown", { spawnSync }), { code: "storage_capacity_protected" });
  assert.equal(calls, 0);
});

test("runs the fixed mini gate with a bounded timeout, null output, and minimal environment", () => {
  let call;
  const spawnSync = (command, args, options) => {
    call = { command, args, options };
    return { status: 0, signal: null, stdout: "STATUS: ALLOWED", stderr: "" };
  };
  const result = assertStorageCapacityIngress(45214, "upload", { spawnSync });
  assert.deepEqual(result, {
    port: 45214,
    parentWriterId: "mini.phone_bridge_45214",
    writerId: "mini.phone_bridge_45214_upload",
  });
  assert.equal(call.command, STORAGE_CAPACITY_GATE_PATH);
  assert.deepEqual(call.args, ["--writer-id", "mini.phone_bridge_45214_upload"]);
  assert.equal(call.options.timeout, STORAGE_CAPACITY_GATE_TIMEOUT_MS);
  assert.deepEqual(call.options.stdio, ["ignore", "ignore", "ignore"]);
  assert.deepEqual(call.options.env, {
    HOME: STORAGE_CAPACITY_GATE_HOME,
    PATH: STORAGE_CAPACITY_GATE_PATH_ENV,
  });
  assert.equal(call.options.env.PHONE_TOKEN, undefined);
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  assert.equal(call.options.env.GH_TOKEN, undefined);
  assert.equal(call.options.shell, undefined);
});

for (const [name, result] of [
  ["exit 75", { status: 75, signal: null, stdout: "private gate reason", stderr: "private status" }],
  ["missing gate", { status: null, signal: null, error: Object.assign(new Error("ENOENT private path"), { code: "ENOENT" }) }],
  ["timeout", { status: null, signal: "SIGTERM", error: Object.assign(new Error("ETIMEDOUT private path"), { code: "ETIMEDOUT" }) }],
]) {
  test(`fails closed on ${name} without exposing gate output`, () => {
    let error;
    try {
      assertStorageCapacityIngress(45244, "prompt", { spawnSync: () => result });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, "storage_capacity_protected");
    assert.equal(error?.statusCode, 503);
    assert.equal(error?.message, CAPACITY_PROTECTION_MESSAGE);
    assert.doesNotMatch(error?.message || "", /private|ENOENT|ETIMEDOUT|ENOBUFS|STATUS/i);
    assert.deepEqual(storageCapacityErrorPayload(error), {
      error: CAPACITY_PROTECTION_MESSAGE,
      code: "storage_capacity_protected",
      retryable: true,
    });
  });
}
