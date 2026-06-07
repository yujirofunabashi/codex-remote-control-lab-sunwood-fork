const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { defaultCodexAppServerPort } = require("./phone-slot-settings");

const root = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(root, ".phone-fleet.local.json");
const bridgeRestartExitCode = 42;

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

function normalizeAppServerUrl(value, field = "appServerUrl") {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid WebSocket URL`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`${field} must use ws:// or wss://`);
  return url.toString();
}

function normalizeAppServerCwd(value, field = "appServerCwd") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[\r\n]/.test(text)) throw new Error(`${field} must be a single-line path`);
  return text;
}

function normalizeProvider(value, field = "provider") {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) return "";
  if (provider === "codex") return provider;
  throw new Error(`${field} must be codex`);
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
      const appServerUrl = normalizeAppServerUrl(entry.appServerUrl || entry.codexAppServerUrl, `bridges[${index}].appServerUrl`);
      const appServerCwd = normalizeAppServerCwd(entry.appServerCwd || entry.codexCwd, `bridges[${index}].appServerCwd`);
      const appServerPort = appServerUrl
        ? null
        : positivePort(entry.appServerPort || defaultCodexAppServerPort(phonePort), `bridges[${index}].appServerPort`);
      if (seen.has(phonePort) || (appServerPort && seen.has(appServerPort))) throw new Error(`duplicate port around bridge ${id}`);
      seen.add(phonePort);
      if (appServerPort) seen.add(appServerPort);
      const workdir = path.resolve(String(entry.workdir || root));
      const provider = normalizeProvider(entry.provider, `bridges[${index}].provider`);
      return {
        id,
        label: String(entry.label || id).trim(),
        group: String(entry.group || "").trim(),
        provider,
        workdir,
        phonePort,
        appServerPort,
        appServerUrl,
        appServerCwd,
        model: String(entry.model || "").trim(),
        color: String(entry.color || "").trim(),
      };
    }),
  };
}

function matchingBridgeEntry(config, previousBridge = {}) {
  const previousId = String(previousBridge.id || "").trim();
  const previousPort = Number(previousBridge.phonePort);
  return (
    config.bridges.find((entry) => previousId && entry.id === previousId) ||
    config.bridges.find((entry) => Number.isInteger(previousPort) && entry.phonePort === previousPort) ||
    null
  );
}

function latestBridgeConfig(configPath, previousBridge = {}) {
  const config = normalizeFleetConfig(readJsonFile(configPath));
  return matchingBridgeEntry(config, previousBridge);
}

function bridgeEnvForEntry(entry, baseEnv = process.env, options = {}) {
  const portSuffix = `_${entry.phonePort}`;
  const fleetEnv = options.configPath
    ? {
        PHONE_FLEET_CONFIG_PATH: path.resolve(options.configPath),
        PHONE_FLEET_BRIDGE_ID: entry.id,
      }
    : {};
  const scopedProvider = entry.provider
    ? {
        PHONE_AGENT_PROVIDER: entry.provider,
        [`PHONE_AGENT_PROVIDER${portSuffix}`]: entry.provider,
      }
    : {};
  const scopedModel = entry.model
    ? {
        [`PHONE_MODEL${portSuffix}`]: entry.model,
        [`CODEX_MODEL${portSuffix}`]: entry.model,
      }
    : {};
  const appServerEnv = entry.appServerUrl
    ? {
        CODEX_APP_SERVER_URL: entry.appServerUrl,
        CODEX_APP_SERVER_SOCK: "",
      }
    : {
        CODEX_APP_SERVER_PORT: String(entry.appServerPort),
      };
  if (entry.appServerCwd) appServerEnv.CODEX_APP_SERVER_CWD = entry.appServerCwd;
  return {
    ...baseEnv,
    PHONE_UI_PORT: String(entry.phonePort),
    PHONE_BRIDGE_ID: entry.id,
    PHONE_BRIDGE_LABEL: entry.label,
    PHONE_BRIDGE_GROUP: entry.group,
    PHONE_BRIDGE_COLOR: entry.color,
    ...appServerEnv,
    ...fleetEnv,
    PHONE_WORKDIR: entry.workdir,
    CODEX_WORKDIR: entry.workdir,
    ...scopedProvider,
    [`PHONE_WORKDIR${portSuffix}`]: entry.workdir,
    [`CODEX_WORKDIR${portSuffix}`]: entry.workdir,
    ...(entry.model ? { PHONE_MODEL: entry.model, CODEX_MODEL: entry.model } : {}),
    ...scopedModel,
  };
}

function shouldRespawnBridgeExit(code, signal, stopping = false) {
  return !stopping && !signal && code === bridgeRestartExitCode;
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
    for (const port of [bridge.phonePort, bridge.appServerPort].filter(Boolean)) {
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

  const children = new Map();
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const child of children.values()) {
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
  const startBridge = (bridge) => {
    const child = spawn("npm", ["run", "phone"], {
      cwd: root,
      env: bridgeEnvForEntry(bridge, process.env, { configPath }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(bridge.id, child);
    const prefix = `[${bridge.id}:${bridge.phonePort}]`;
    child.stdout.on("data", (chunk) => process.stdout.write(`${prefix} ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`${prefix} ${chunk}`));
    child.on("exit", (code, signal) => {
      if (children.get(bridge.id) === child) children.delete(bridge.id);
      console.error(`${prefix} exited code=${code} signal=${signal || ""}`);
      if (shouldRespawnBridgeExit(code, signal, stopping)) {
        let nextBridge;
        try {
          nextBridge = latestBridgeConfig(configPath, bridge);
        } catch (error) {
          console.error(`${prefix} restart requested, but fleet config reload failed: ${error.message}`);
          return;
        }
        if (!nextBridge) {
          console.error(`${prefix} restart requested, but this bridge is no longer present in the fleet config.`);
          return;
        }
        const changed = nextBridge.workdir !== bridge.workdir || nextBridge.model !== bridge.model || nextBridge.phonePort !== bridge.phonePort;
        console.error(`${prefix} restart requested; respawning${changed ? " with updated fleet config" : ""}.`);
        setTimeout(() => startBridge(nextBridge), 500);
      }
    });
  };
  for (const bridge of config.bridges) {
    startBridge(bridge);
  }

  const first = config.bridges[0];
  console.log(`Manager URL: open the first bridge at http://LAN-IP:${first.phonePort}/ and enter that bridge token if prompted.`);
  console.log("Add the remaining protected startup URLs or base URLs plus tokens from Bridge Fleet in the UI.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { bridgeEnvForEntry, latestBridgeConfig, matchingBridgeEntry, normalizeFleetConfig, shouldRespawnBridgeExit };
