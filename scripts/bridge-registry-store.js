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
//
// Restoring is a merge, which is why deletions are recorded rather than
// implied: an absent bridge cannot be told apart from one the other side has
// not heard about yet, so a plain union quietly resurrects everything that was
// ever removed. Tokens carry their own timestamp for the same reason - the
// newest one wins instead of whichever device happened to sync last.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const fileVersion = 2;
const readableVersions = new Set([1, 2]);
const keyBytes = 32;
const ivBytes = 12;
const cipherAlg = "aes-256-gcm";
const maxBridges = 64;
const maxTombstones = 256;
const maxTextLength = 512;
// Long enough that a phone left in a drawer for a season still learns about a
// deletion, short enough that the list cannot grow without bound.
const tombstoneTtlMs = 90 * 24 * 60 * 60 * 1000;
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

// Rename is the only step that changes what a reader sees, so a crash or a full
// disk leaves the previous backup intact instead of a truncated one.
function writeAtomicPrivateFile(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.rmSync(tempPath, { force: true });
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function readKeyFile(keyPath) {
  if (!fs.existsSync(keyPath)) return null;
  const raw = fs.readFileSync(keyPath, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== keyBytes) throw new RegistryUnreadableError("registry key is malformed");
  return key;
}

// The key lives beside the registry rather than inside it, so a copy of the
// JSON alone - swept into a backup, pasted into a chat - carries no tokens.
// It is not protection against someone who already has the account.
//
// Every bridge process in one checkout shares this file, so creation is
// exclusive: two slots starting together must not each mint a key and leave
// the loser's backup undecryptable.
function loadRegistryKey(keyPath) {
  const existing = readKeyFile(keyPath);
  if (existing) return existing;
  const key = crypto.randomBytes(keyBytes);
  try {
    fs.writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = readKeyFile(keyPath);
    if (!raced) throw new RegistryUnreadableError("registry key is malformed");
    return raced;
  }
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

function decryptTokens(secrets, key, revision, version) {
  if (!secrets || typeof secrets !== "object") return {};
  if (secrets.alg !== cipherAlg) throw new RegistryUnreadableError("unsupported registry encryption");
  try {
    const decipher = crypto.createDecipheriv(cipherAlg, key, Buffer.from(String(secrets.iv || ""), "base64"));
    decipher.setAAD(Buffer.from(`${version}:${Number(revision) || 0}`, "utf8"));
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

function sanitizeTombstones(deleted, { now = 0, prune = false } = {}) {
  if (!Array.isArray(deleted)) return [];
  const byId = new Map();
  for (const record of deleted) {
    if (!record || typeof record !== "object") continue;
    const id = trimmedText(record.id, 128);
    if (!id) continue;
    const deletedAt = finiteNumber(record.deletedAt);
    if (deletedAt <= 0) continue;
    if (prune && now > 0 && now - deletedAt > tombstoneTtlMs) continue;
    const existing = byId.get(id);
    if (!existing || deletedAt > existing.deletedAt) byId.set(id, { id, deletedAt });
  }
  return Array.from(byId.values())
    .sort((left, right) => right.deletedAt - left.deletedAt)
    .slice(0, maxTombstones);
}

// A bridge cannot be both listed and deleted. Whichever record is newer decides,
// so a re-added bridge survives its own old tombstone and a deletion survives an
// older copy of the entry.
function reconcileTombstones(bridges, tombstones) {
  const deletedById = new Map(tombstones.map((record) => [record.id, record]));
  const keptBridges = [];
  const keptTombstones = [];
  for (const bridge of bridges) {
    const tombstone = deletedById.get(bridge.id);
    if (tombstone && tombstone.deletedAt >= bridge.updatedAt) continue;
    if (tombstone) deletedById.delete(bridge.id);
    keptBridges.push(bridge);
  }
  for (const record of tombstones) {
    if (deletedById.has(record.id)) keptTombstones.push(record);
  }
  return { bridges: keptBridges, deleted: keptTombstones };
}

function sanitizeTokenRecord(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const token = value.slice(0, maxTextLength);
    return token ? { token, updatedAt: 0 } : null;
  }
  if (typeof value !== "object") return null;
  const token = String(value.token === undefined || value.token === null ? "" : value.token).slice(0, maxTextLength);
  return token ? { token, updatedAt: finiteNumber(value.updatedAt) } : null;
}

function sanitizeTokens(tokens, bridges) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return {};
  const allowed = new Map(bridges.map((bridge) => [bridge.id, bridge]));
  const out = {};
  for (const [id, value] of Object.entries(tokens)) {
    const bridge = allowed.get(String(id));
    if (!bridge || bridge.rememberToken === false) continue;
    const record = sanitizeTokenRecord(value);
    if (record) out[bridge.id] = record;
  }
  return out;
}

function emptyRegistry() {
  return { version: fileVersion, revision: 0, updatedAt: 0, bridges: [], deleted: [], tokens: {} };
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
  const version = Number(parsed.version);
  if (!readableVersions.has(version)) {
    throw new RegistryUnreadableError(`unsupported registry version: ${parsed.version}`);
  }
  const revision = finiteNumber(parsed.revision);
  const reconciled = reconcileTombstones(sanitizeBridges(parsed.bridges), sanitizeTombstones(parsed.deleted));
  const key = loadRegistryKey(keyPath);
  const tokens = sanitizeTokens(decryptTokens(parsed.secrets, key, revision, version), reconciled.bridges);
  return {
    version: fileVersion,
    revision,
    updatedAt: finiteNumber(parsed.updatedAt),
    bridges: reconciled.bridges,
    deleted: reconciled.deleted,
    tokens,
  };
}

// Optimistic concurrency, because two phones syncing the same bridge is normal
// and a silent last-writer-wins would quietly delete the other one's machines.
function writeRegistry({ filePath, keyPath, bridges, tokens, deleted, expectedRevision, now = Date.now() }) {
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
  const reconciled = reconcileTombstones(
    sanitizeBridges(bridges),
    sanitizeTombstones(deleted, { now: finiteNumber(now), prune: true }),
  );
  const nextTokens = sanitizeTokens(tokens, reconciled.bridges);
  const revision = current.revision + 1;
  const key = loadRegistryKey(keyPath);
  const payload = {
    version: fileVersion,
    revision,
    updatedAt: finiteNumber(now),
    bridges: reconciled.bridges,
    deleted: reconciled.deleted,
    secrets: encryptTokens(nextTokens, key, revision),
  };
  writeAtomicPrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    version: fileVersion,
    revision,
    updatedAt: payload.updatedAt,
    bridges: reconciled.bridges,
    deleted: reconciled.deleted,
    tokens: nextTokens,
  };
}

module.exports = {
  RegistryConflictError,
  RegistryUnreadableError,
  emptyRegistry,
  fileVersion,
  readRegistry,
  reconcileTombstones,
  registryKeyPath,
  registryPathForPort,
  sanitizeBridges,
  sanitizeTokens,
  sanitizeTombstones,
  tombstoneTtlMs,
  writeRegistry,
};
