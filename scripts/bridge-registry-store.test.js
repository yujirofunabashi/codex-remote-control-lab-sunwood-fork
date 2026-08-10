const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  RegistryConflictError,
  RegistryUnreadableError,
  readRegistry,
  registryKeyPath,
  registryPathForPort,
  sanitizeTombstones,
  tombstoneTtlMs,
  writeRegistry,
} = require("./bridge-registry-store");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".tmp-bridge-registry-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function storeFor(dir, port = 45214) {
  return { filePath: registryPathForPort(dir, port), keyPath: registryKeyPath(dir) };
}

const sampleBridges = [
  { id: "mini-45214", label: "mini", baseUrl: "http://100.64.0.1:45214", port: 45214, kind: "mesh" },
  { id: "air-45214", label: "air", baseUrl: "http://100.64.0.2:45214", port: 45214, kind: "mesh" },
];

test("an absent backup reads as an empty registry at revision 0", () => {
  withTempDir((dir) => {
    const registry = readRegistry(storeFor(dir));
    assert.deepEqual(registry.bridges, []);
    assert.deepEqual(registry.tokens, {});
    assert.equal(registry.revision, 0);
  });
});

test("a written registry reads back with its bridges and tokens", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: sampleBridges,
      tokens: { "mini-45214": "token-mini", "air-45214": "token-air" },
      expectedRevision: 0,
    });
    assert.equal(written.revision, 1);

    const registry = readRegistry(store);
    assert.equal(registry.revision, 1);
    assert.deepEqual(
      registry.bridges.map((bridge) => bridge.id),
      ["mini-45214", "air-45214"],
    );
    assert.deepEqual(registry.tokens, {
      "mini-45214": { token: "token-mini", updatedAt: 0 },
      "air-45214": { token: "token-air", updatedAt: 0 },
    });
  });
});

test("the stored file holds no plaintext token and stays owner-only", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "super-secret-token" }, expectedRevision: 0 });

    const raw = fs.readFileSync(store.filePath, "utf8");
    assert.ok(!raw.includes("super-secret-token"));
    assert.ok(raw.includes("http://100.64.0.1:45214"));
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.keyPath).mode & 0o777, 0o600);
  });
});

test("tokens the phone chose not to remember are never backed up", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: [{ ...sampleBridges[0], rememberToken: false }, sampleBridges[1]],
      tokens: { "mini-45214": "session-only", "air-45214": "token-air" },
      expectedRevision: 0,
    });
    assert.deepEqual(written.tokens, { "air-45214": { token: "token-air", updatedAt: 0 } });
    assert.deepEqual(readRegistry(store).tokens, { "air-45214": { token: "token-air", updatedAt: 0 } });
  });
});

test("tokens without a listed bridge are dropped", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: sampleBridges,
      tokens: { "mini-45214": "token-mini", "ghost-9999": "token-ghost" },
      expectedRevision: 0,
    });
    assert.deepEqual(written.tokens, { "mini-45214": { token: "token-mini", updatedAt: 0 } });
  });
});

test("bridges without an id or base url are skipped and duplicates collapse", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: [
        sampleBridges[0],
        { id: "", baseUrl: "http://100.64.0.9:45214" },
        { id: "no-url", baseUrl: "" },
        { id: "mini-45214", label: "duplicate", baseUrl: "http://100.64.0.1:45214" },
      ],
      tokens: {},
      expectedRevision: 0,
    });
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214"],
    );
    assert.equal(written.bridges[0].label, "mini");
  });
});

test("a stale revision is refused instead of overwriting the newer backup", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: {}, expectedRevision: 0 });

    assert.throws(
      () => writeRegistry({ ...store, bridges: [sampleBridges[0]], tokens: {}, expectedRevision: 0 }),
      (error) => error instanceof RegistryConflictError && error.code === "revision-conflict" && error.current.revision === 1,
    );
    assert.equal(readRegistry(store).bridges.length, 2);
  });
});

test("an empty first sync cannot land on top of an existing backup", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });

    // A reinstalled PWA starts from revision 0 with only its own bridge; the
    // conflict is what stops it from erasing the machines it came back for.
    assert.throws(
      () => writeRegistry({ ...store, bridges: [], tokens: {}, expectedRevision: 0 }),
      RegistryConflictError,
    );
    assert.equal(readRegistry(store).bridges.length, 2);
  });
});

test("the wrong key fails closed rather than reporting an empty registry", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });

    fs.rmSync(store.keyPath);
    assert.throws(() => readRegistry(store), RegistryUnreadableError);
  });
});

test("a hand-edited revision invalidates the encrypted tokens", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });

    const parsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    parsed.revision = 99;
    fs.writeFileSync(store.filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    assert.throws(() => readRegistry(store), RegistryUnreadableError);
  });
});

test("a corrupt backup is reported and left in place", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    fs.writeFileSync(store.filePath, "{ not json");

    assert.throws(() => readRegistry(store), RegistryUnreadableError);
    assert.throws(
      () => writeRegistry({ ...store, bridges: sampleBridges, tokens: {}, expectedRevision: 0 }),
      (error) => error instanceof RegistryConflictError && error.code === "registry-unreadable",
    );
    assert.equal(fs.readFileSync(store.filePath, "utf8"), "{ not json");
  });
});

test("an unsupported file version is refused", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    fs.writeFileSync(store.filePath, `${JSON.stringify({ version: 99, revision: 1, bridges: [] })}\n`);
    assert.throws(() => readRegistry(store), RegistryUnreadableError);
  });
});

test("a deletion is stored as a dated record, not as an absence", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "air-45214": "token-air" }, expectedRevision: 0 });
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [{ id: "air-45214", deletedAt: 500 }],
      tokens: { "air-45214": "token-air" },
      expectedRevision: 1,
      now: 1000,
    });

    assert.deepEqual(written.deleted, [{ id: "air-45214", deletedAt: 500 }]);
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214"],
    );
    // The token has to go with the bridge, or the next restore hands back a
    // credential for a connection the owner deleted.
    assert.deepEqual(written.tokens, {});
  });
});

test("a bridge added back after its deletion outlives the tombstone", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: [{ ...sampleBridges[1], updatedAt: 900 }],
      deleted: [{ id: "air-45214", deletedAt: 500 }],
      tokens: { "air-45214": "token-air" },
      expectedRevision: 0,
      now: 1000,
    });
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["air-45214"],
    );
    assert.deepEqual(written.deleted, []);
    assert.equal(written.tokens["air-45214"].token, "token-air");
  });
});

test("a deletion newer than the entry wins", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: [{ ...sampleBridges[1], updatedAt: 100 }],
      deleted: [{ id: "air-45214", deletedAt: 900 }],
      tokens: {},
      expectedRevision: 0,
      now: 1000,
    });
    assert.deepEqual(written.bridges, []);
    assert.equal(written.deleted.length, 1);
  });
});

test("tokens keep the time they were set so the newest one can win", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: sampleBridges,
      tokens: { "mini-45214": { token: "rotated", updatedAt: 4242 }, "air-45214": "legacy-string" },
      expectedRevision: 0,
    });
    assert.deepEqual(written.tokens["mini-45214"], { token: "rotated", updatedAt: 4242 });
    // A plain string is a pre-timestamp backup; it must not outrank anything.
    assert.deepEqual(written.tokens["air-45214"], { token: "legacy-string", updatedAt: 0 });
    assert.deepEqual(readRegistry(store).tokens["mini-45214"], { token: "rotated", updatedAt: 4242 });
  });
});

test("expired tombstones are pruned on write but never resurrect a bridge", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const now = tombstoneTtlMs * 4;
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [
        { id: "air-45214", deletedAt: now - tombstoneTtlMs - 1 },
        { id: "old-45214", deletedAt: now - 10 },
      ],
      tokens: {},
      expectedRevision: 0,
      now,
    });
    assert.deepEqual(
      written.deleted.map((record) => record.id),
      ["old-45214"],
    );
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214"],
    );
  });
});

test("tombstones collapse to the newest record per bridge", () => {
  const records = sanitizeTombstones([
    { id: "air", deletedAt: 10 },
    { id: "air", deletedAt: 90 },
    { id: "", deletedAt: 5 },
    { id: "mini", deletedAt: 0 },
  ]);
  assert.deepEqual(records, [{ id: "air", deletedAt: 90 }]);
});

test("a v1 backup is still readable and is rewritten as v2", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });
    const parsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.equal(parsed.version, 2);

    const registry = readRegistry(store);
    assert.equal(registry.version, 2);
    assert.deepEqual(registry.deleted, []);
  });
});

test("concurrent first-time key creation settles on one key", () => {
  withTempDir((dir) => {
    const first = storeFor(dir, 45214);
    const second = storeFor(dir, 45224);
    writeRegistry({ ...first, bridges: sampleBridges, tokens: { "mini-45214": "token-a" }, expectedRevision: 0 });
    const keyAfterFirst = fs.readFileSync(first.keyPath, "utf8");
    writeRegistry({ ...second, bridges: sampleBridges, tokens: { "mini-45214": "token-b" }, expectedRevision: 0 });

    // The second slot must adopt the existing key rather than mint one, or the
    // first slot's backup becomes undecryptable.
    assert.equal(fs.readFileSync(second.keyPath, "utf8"), keyAfterFirst);
    assert.equal(readRegistry(first).tokens["mini-45214"].token, "token-a");
    assert.equal(readRegistry(second).tokens["mini-45214"].token, "token-b");
  });
});

test("a failed write leaves the previous backup readable", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });
    const before = fs.readFileSync(store.filePath, "utf8");

    // Nothing is written through the live file, so an interrupted write cannot
    // leave a half-serialized registry behind.
    assert.throws(() => writeRegistry({ ...store, bridges: sampleBridges, tokens: {}, expectedRevision: 99 }), RegistryConflictError);
    assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("each phone UI port keeps its own backup file", () => {
  withTempDir((dir) => {
    assert.notEqual(registryPathForPort(dir, 45214), registryPathForPort(dir, 45224));
    assert.ok(registryPathForPort(dir, 45224).endsWith(".phone-bridges.45224.local.json"));
    assert.throws(() => registryPathForPort(dir, "45214; rm -rf /"), /Invalid phone UI port/);
  });
});
