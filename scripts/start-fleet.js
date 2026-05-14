const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(root, ".phone-fleet.local.json");

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertSafeId(value, field) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must use only letters, numbers, dot, underscore, or dash`);
  return text;
}

function positivePort(value, field) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${field} must be a TCP port between 1024 and 65535`);
  return port;
}

function normalizeFleetConfig(raw = {}) {
  const bridges = Array.isArray(raw.bridges) ? raw.bridges : [];
  if (!bridges.length) throw new Error("bridges must contain at least one bridge");
  const seen = new Set();
  return {
    hubPort: raw.hubPort ? positivePort(raw.hubPort, "hubPort") : null,
    bridges: bridges.map((entry, index) => {
      const id = assertSafeId(entry.id || `bridge-${index + 1}`, `bridges[${index}].id`);
      const phonePort = positivePort(entry.phonePort || entry.uiPort || entry.port, `bridges[${index}].phonePort`);
      const appServerPort = positivePort(entry.appServerPort || phonePort - 1, `bridges[${index}].appServerPort`);
      if (seen.has(phonePort) || seen.has(appServerPort)) throw new Error(`duplicate port around bridge ${id}`);
      seen.add(phonePort);
      seen.add(appServerPort);
      const workdir = path.resolve(String(entry.workdir || root));
      return {
        id,
        label: String(entry.label || id).trim(),
        group: String(entry.group || "").trim(),
        workdir,
        phonePort,
        appServerPort,
        model: String(entry.model || "").trim(),
        color: String(entry.color || "").trim(),
      };
    }),
  };
}

function bridgeEnvForEntry(entry, baseEnv = process.env) {
  return {
    ...baseEnv,
    PHONE_UI_PORT: String(entry.phonePort),
    CODEX_APP_SERVER_PORT: String(entry.appServerPort),
    PHONE_BRIDGE_ID: entry.id,
    PHONE_BRIDGE_LABEL: entry.label,
    PHONE_BRIDGE_GROUP: entry.group,
    PHONE_BRIDGE_COLOR: entry.color,
    PHONE_WORKDIR: entry.workdir,
    CODEX_WORKDIR: entry.workdir,
    ...(entry.model ? { PHONE_MODEL: entry.model, CODEX_MODEL: entry.model } : {}),
  };
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function assertPortsAvailable(config) {
  for (const bridge of config.bridges) {
    for (const port of [bridge.phonePort, bridge.appServerPort]) {
      if (!(await canListen(port))) throw new Error(`port ${port} is already in use`);
    }
  }
}

async function main() {
  const configPath = path.resolve(process.argv[2] || defaultConfigPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Fleet config not found: ${configPath}`);
  }
  const config = normalizeFleetConfig(readJsonFile(configPath));
  await assertPortsAvailable(config);

  const children = [];
  const stop = () => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });

  console.log("Phone bridge fleet starting.");
  for (const bridge of config.bridges) {
    const child = spawn("npm", ["run", "phone"], {
      cwd: root,
      env: bridgeEnvForEntry(bridge),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const prefix = `[${bridge.id}:${bridge.phonePort}]`;
    child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
    child.on("exit", (code, signal) => {
      console.error(`${prefix} exited code=${code} signal=${signal || ""}`);
    });
  }

  const first = config.bridges[0];
  console.log(`Manager URL: open the first bridge at http://LAN-IP:${first.phonePort}/?token=<printed-by-child>`);
  console.log("Add the remaining printed tokenized URLs from Bridge Fleet in the UI.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { bridgeEnvForEntry, normalizeFleetConfig };
