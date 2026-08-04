const { spawnSync } = require("child_process");
const fs = require("fs");

const STORAGE_CAPACITY_GATE_PATH = "/Users/minijiro/agent-hub/machines/mini/automation/storage_capacity_gate.sh";
const STORAGE_CAPACITY_GATE_HOME = "/Users/minijiro";
const STORAGE_CAPACITY_GATE_TIMEOUT_MS = 2500;
const STORAGE_CAPACITY_GATE_PATH_ENV = "/usr/bin:/bin:/usr/sbin:/sbin";

const INGRESS_WRITERS_BY_PORT = Object.freeze({
  45214: Object.freeze({
    parentWriterId: "mini.phone_bridge_45214",
    writers: Object.freeze({
      prompt: "mini.phone_bridge_45214_prompt",
      upload: "mini.phone_bridge_45214_upload",
      terminal: "mini.phone_bridge_45214_terminal",
    }),
  }),
  45244: Object.freeze({
    parentWriterId: "mini.phone_bridge_45244",
    writers: Object.freeze({
      prompt: "mini.phone_bridge_45244_prompt",
      upload: "mini.phone_bridge_45244_upload",
      terminal: "mini.phone_bridge_45244_terminal",
    }),
  }),
});

const CAPACITY_PROTECTION_MESSAGE =
  "Mac miniのストレージ容量保護により、この操作は現在開始できません。空き容量の回復後に再試行してください。";

class StorageCapacityProtectionError extends Error {
  constructor() {
    super(CAPACITY_PROTECTION_MESSAGE);
    this.name = "StorageCapacityProtectionError";
    this.code = "storage_capacity_protected";
    this.statusCode = 503;
    this.retryable = true;
  }
}

function ingressWriterForPort(port, ingress) {
  const numericPort = Number(port);
  const config = Number.isInteger(numericPort) ? INGRESS_WRITERS_BY_PORT[numericPort] : null;
  const writerId = config?.writers?.[String(ingress || "")];
  if (!config || !writerId) throw new StorageCapacityProtectionError();
  return { port: numericPort, parentWriterId: config.parentWriterId, writerId };
}

// The gate script is provisioned on one specific machine. On a host that does
// not have it, the policy simply does not apply — and failing closed there
// blocks every bridge connection, upload, and terminal run without protecting
// anything, because there is no gate to consult.
function isStorageCapacityGateInstalled(gatePath = STORAGE_CAPACITY_GATE_PATH) {
  try {
    return fs.existsSync(gatePath);
  } catch {
    return false;
  }
}

function assertStorageCapacityIngress(port, ingress, dependencies = {}) {
  const gatePath = dependencies.gatePath || STORAGE_CAPACITY_GATE_PATH;
  const installed =
    dependencies.gateInstalled === undefined ? isStorageCapacityGateInstalled(gatePath) : Boolean(dependencies.gateInstalled);
  if (!installed) return null;
  const writer = ingressWriterForPort(port, ingress);
  const run = dependencies.spawnSync || spawnSync;
  let result;

  try {
    result = run(gatePath, ["--writer-id", writer.writerId], {
      env: {
        HOME: STORAGE_CAPACITY_GATE_HOME,
        PATH: STORAGE_CAPACITY_GATE_PATH_ENV,
      },
      stdio: ["ignore", "ignore", "ignore"],
      timeout: STORAGE_CAPACITY_GATE_TIMEOUT_MS,
    });
  } catch {
    throw new StorageCapacityProtectionError();
  }

  // Gate stdout/stderr may contain local policy state, so both are sent to the
  // null device and the bridge observes exit metadata only. The explicit env
  // also prevents bridge tokens and other secrets from reaching the gate.
  if (!result || result.error || result.signal || result.status !== 0) {
    throw new StorageCapacityProtectionError();
  }
  return writer;
}

function isStorageCapacityProtectionError(error) {
  return error?.code === "storage_capacity_protected";
}

function storageCapacityErrorPayload(error) {
  if (!isStorageCapacityProtectionError(error)) return null;
  return {
    error: CAPACITY_PROTECTION_MESSAGE,
    code: "storage_capacity_protected",
    retryable: true,
  };
}

module.exports = {
  CAPACITY_PROTECTION_MESSAGE,
  INGRESS_WRITERS_BY_PORT,
  STORAGE_CAPACITY_GATE_HOME,
  STORAGE_CAPACITY_GATE_PATH,
  STORAGE_CAPACITY_GATE_PATH_ENV,
  STORAGE_CAPACITY_GATE_TIMEOUT_MS,
  StorageCapacityProtectionError,
  assertStorageCapacityIngress,
  ingressWriterForPort,
  isStorageCapacityGateInstalled,
  isStorageCapacityProtectionError,
  storageCapacityErrorPayload,
};
