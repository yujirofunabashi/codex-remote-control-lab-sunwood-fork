// Backup store for the browser bridge registry.
//
// A PWA keeps its list of reachable bridges in localStorage, which iOS discards
// with the app when the icon is deleted. That turns a reinstall into "which
// machines did I have again?", and the tokens needed to answer it are only on
// the phone. So each bridge keeps a copy of the registry that was last synced
// to it, and a freshly installed PWA restores from the bridge it was installed
// from.
//
// The file is keyed by the bridge's UI port rather than by any client-side id:
// a reinstalled PWA has no surviving id to look itself up with, and the port is
// what still identifies the slot after the phone forgot everything.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const fileVersion = 1;
const keyBytes = 32;
const ivBytes = 12;
const cipherAlg = "aes-256-gcm";
const maxBridges = 64;
const maxTextLength = 512;
const bridgeKinds = new Set(["lan", "ssh-forward", "vpn", "mesh", "local"]);

class RegistryConflictError extends Error {
  constructor(message, { code = "revision-conflict", current = null } = {}) {
    super(message);
    this.name = "RegistryConflictError";
    this.code = code;
    this.current = current;
  }
}

class RegistryUnreadableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryUnreadableError";
    this.code = "registry-unreadable";
  }
}

function registryPathForPort(root, port) {
  const value = String(port || "").trim();
  if (!/^\d+$/.test(value)) throw new Error(`Invalid phone UI port: ${port}`);
  return path.join(root, `.phone-bridges.${value}.local.json`);
}

function registryKeyPath(root) {
  return path.join(root, ".phone-registry-key");
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems reject chmod; the mode on create is the important one.
  }
}

// The key lives beside the registry rather than inside it, so a copy of the
// JSON alone - swept into a backup, pasted into a chat - carries no tokens.
// It is not protection against someone who already has the account.
function loadRegistryKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== keyBytes) throw new RegistryUnreadableError("registry key is malformed");
    return key;
  }
  const key = crypto.randomBytes(keyBytes);
  writePrivateFile(keyPath, `${key.toString("base64")}\n`);
  return key;
}

function secretsAad(revision) {
  return Buffer.from(`${fileVersion}:${Number(revision) || 0}`, "utf8");
}

function encryptTokens(tokens, key, revision) {
  const iv = crypto.randomBytes(ivBytes);
  const cipher = crypto.createCipheriv(cipherAlg, key, iv);
  cipher.setAAD(secretsAad(revision));
  const json = JSON.stringify(tokens || {});
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return {
    alg: cipherAlg,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptTokens(secrets, key, revision) {
  if (!secrets || typeof secrets !== "object") return {};
  if (secrets.alg !== cipherAlg) throw new RegistryUnreadableError("unsupported registry encryption");
  try {
    const decipher = crypto.createDecipheriv(cipherAlg, key, Buffer.from(String(secrets.iv || ""), "base64"));
    decipher.setAAD(secretsAad(revision));
    decipher.setAuthTag(Buffer.from(String(secrets.tag || ""), "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(String(secrets.data || ""), "base64")), decipher.final()]);
    const parsed = JSON.parse(out.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    if (error instanceof RegistryUnreadableError) throw error;
    // A wrong key, a truncated file, and a hand-edited revision all land here.
    // None of them may be treated as "no backup yet".
    throw new RegistryUnreadableError("registry secrets could not be decrypted");
  }
}

function trimmedText(value, limit = maxTextLength) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .slice(0, limit);
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sanitizeBridge(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = trimmedText(entry.id, 128);
  const baseUrl = trimmedText(entry.baseUrl, maxTextLength);
  if (!id || !baseUrl) return null;
  const port = Number(entry.port);
  const kind = trimmedText(entry.kind, 32);
  return {
    id,
    name: trimmedText(entry.name, 128),
    label: trimmedText(entry.label, 128),
    group: trimmedText(entry.group, 128),
    baseUrl,
    kind: bridgeKinds.has(kind) ? kind : "lan",
    note: trimmedText(entry.note, maxTextLength),
    color: /^#[0-9a-f]{6}$/i.test(trimmedText(entry.color, 16)) ? trimmedText(entry.color, 16).toLowerCase() : "",
    workdir: trimmedText(entry.workdir, maxTextLength),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    rememberToken: entry.rememberToken !== false,
    createdAt: finiteNumber(entry.createdAt),
    lastUsedAt: finiteNumber(entry.lastUsedAt),
    updatedAt: finiteNumber(entry.updatedAt),
  };
}

// Tokens never travel in the bridge list. Keeping them in one map, and dropping
// any that no longer belong to a listed bridge, is what makes "the plaintext
// half of the file has no secrets in it" a property of the format rather than
// of every call site remembering to strip them.
function sanitizeBridges(bridges) {
  if (!Array.isArray(bridges)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of bridges) {
    const bridge = sanitizeBridge(entry);
    if (!bridge || seen.has(bridge.id)) continue;
    seen.add(bridge.id);
    out.push(bridge);
    if (out.length >= maxBridges) break;
  }
  return out;
}

function sanitizeTokens(tokens, bridges) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return {};
  const allowed = new Map(bridges.map((bridge) => [bridge.id, bridge]));
  const out = {};
  for (const [id, value] of Object.entries(tokens)) {
    const bridge = allowed.get(String(id));
    if (!bridge || bridge.rememberToken === false) continue;
    const token = String(value === undefined || value === null ? "" : value).slice(0, maxTextLength);
    if (token) out[bridge.id] = token;
  }
  return out;
}

function emptyRegistry() {
  return { version: fileVersion, revision: 0, updatedAt: 0, bridges: [], tokens: {} };
}

function readRegistry({ filePath, keyPath }) {
  if (!fs.existsSync(filePath)) return emptyRegistry();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new RegistryUnreadableError("registry file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RegistryUnreadableError("registry file is not an object");
  }
  if (Number(parsed.version) !== fileVersion) {
    throw new RegistryUnreadableError(`unsupported registry version: ${parsed.version}`);
  }
  const revision = finiteNumber(parsed.revision);
  const bridges = sanitizeBridges(parsed.bridges);
  const key = loadRegistryKey(keyPath);
  const tokens = sanitizeTokens(decryptTokens(parsed.secrets, key, revision), bridges);
  return { version: fileVersion, revision, updatedAt: finiteNumber(parsed.updatedAt), bridges, tokens };
}

// Optimistic concurrency, because two phones syncing the same bridge is normal
// and a silent last-writer-wins would quietly delete the other one's machines.
function writeRegistry({ filePath, keyPath, bridges, tokens, expectedRevision, now = Date.now() }) {
  let current;
  try {
    current = readRegistry({ filePath, keyPath });
  } catch (error) {
    if (error instanceof RegistryUnreadableError) {
      throw new RegistryConflictError(
        "the existing registry backup could not be read, so it was left untouched",
        { code: error.code },
      );
    }
    throw error;
  }
  const expected = finiteNumber(expectedRevision);
  if (expected !== current.revision) {
    throw new RegistryConflictError("registry revision conflict", { current });
  }
  const nextBridges = sanitizeBridges(bridges);
  const nextTokens = sanitizeTokens(tokens, nextBridges);
  const revision = current.revision + 1;
  const key = loadRegistryKey(keyPath);
  const payload = {
    version: fileVersion,
    revision,
    updatedAt: finiteNumber(now),
    bridges: nextBridges,
    secrets: encryptTokens(nextTokens, key, revision),
  };
  writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return { version: fileVersion, revision, updatedAt: payload.updatedAt, bridges: nextBridges, tokens: nextTokens };
}

module.exports = {
  RegistryConflictError,
  RegistryUnreadableError,
  emptyRegistry,
  fileVersion,
  readRegistry,
  registryKeyPath,
  registryPathForPort,
  sanitizeBridges,
  sanitizeTokens,
  writeRegistry,
};
