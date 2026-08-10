const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

    // Dated by this bridge, not by the phone that asked.
    assert.deepEqual(written.deleted, [{ id: "air-45214", deletedAt: 1000 }]);
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214"],
    );
    // The token has to go with the bridge, or the next restore hands back a
    // credential for a connection the owner deleted.
    assert.deepEqual(written.tokens, {});
  });
});

test("a removal keeps the date it was first recorded with", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: [sampleBridges[0]], deleted: [{ id: "air-45214", deletedAt: 7 }], tokens: {}, expectedRevision: 0, now: 1000 });
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [{ id: "air-45214", deletedAt: 7 }],
      tokens: {},
      expectedRevision: 1,
      now: 9000,
    });
    assert.deepEqual(written.deleted, [{ id: "air-45214", deletedAt: 1000 }]);
  });
});

test("a bridge registered again after its deletion outlives the tombstone", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: [sampleBridges[0]], deleted: [{ id: "air-45214", deletedAt: 1 }], tokens: {}, expectedRevision: 0, now: 1000 });
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0], { ...sampleBridges[1], createdAt: 2000 }],
      deleted: [{ id: "air-45214", deletedAt: 1 }],
      tokens: { "air-45214": "token-air" },
      expectedRevision: 1,
      now: 2000,
    });
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214", "air-45214"],
    );
    assert.deepEqual(written.deleted, []);
    assert.equal(written.tokens["air-45214"].token, "token-air");
  });
});

test("re-reading a bridge does not undo its deletion", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: [sampleBridges[0]], deleted: [{ id: "air-45214", deletedAt: 1 }], tokens: {}, expectedRevision: 0, now: 1000 });

    // The fleet poll rewrites updatedAt every few seconds. Only createdAt marks
    // a registration, so a device merely left open cannot bring the bridge back.
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0], { ...sampleBridges[1], createdAt: 1, updatedAt: 9000 }],
      deleted: [{ id: "air-45214", deletedAt: 1 }],
      tokens: { "air-45214": "token-air" },
      expectedRevision: 1,
      now: 9000,
    });
    assert.deepEqual(
      written.bridges.map((bridge) => bridge.id),
      ["mini-45214"],
    );
    assert.deepEqual(written.deleted, [{ id: "air-45214", deletedAt: 1000 }]);
    assert.deepEqual(written.tokens, {});
  });
});

test("a phone with a slow clock still gets its deletion recorded", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const now = tombstoneTtlMs * 5;
    // The phone's date is set a year back, so its own deletedAt is already
    // older than the retention window.
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [{ id: "air-45214", deletedAt: now - tombstoneTtlMs * 4 }],
      tokens: {},
      expectedRevision: 0,
      now,
    });
    assert.deepEqual(written.deleted, [{ id: "air-45214", deletedAt: now }]);
  });
});

test("a phone with a fast clock cannot write an entry nothing can supersede", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const written = writeRegistry({
      ...store,
      bridges: [{ ...sampleBridges[0], createdAt: 9_000_000, updatedAt: 9_000_000, lastUsedAt: 9_000_000 }],
      tokens: {},
      expectedRevision: 0,
      now: 1000,
    });
    assert.equal(written.bridges[0].createdAt, 1000);
    assert.equal(written.bridges[0].updatedAt, 1000);
    assert.equal(written.bridges[0].lastUsedAt, 1000);
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

test("tombstones expire once they are older than the retention window", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [{ id: "air-45214", deletedAt: 1 }],
      tokens: {},
      expectedRevision: 0,
      now: 1000,
    });
    const written = writeRegistry({
      ...store,
      bridges: [sampleBridges[0]],
      deleted: [
        { id: "air-45214", deletedAt: 1 },
        { id: "recent-45214", deletedAt: 1 },
      ],
      tokens: {},
      expectedRevision: 1,
      now: 1000 + tombstoneTtlMs + 1,
    });
    assert.deepEqual(
      written.deleted.map((record) => record.id),
      ["recent-45214"],
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

// A file written by the first released version of the store: schema v1, no
// removal records, tokens as bare strings, and the AAD that version bound its
// secrets with.
function writeVersionOneBackup(store, { bridges, tokens, revision = 3 }) {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(store.keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`1:${revision}`, "utf8"));
  const data = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const payload = {
    version: 1,
    revision,
    updatedAt: 1,
    bridges,
    secrets: { alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") },
  };
  fs.writeFileSync(store.filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

test("a v1 backup is still readable and is rewritten as v2", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeVersionOneBackup(store, { bridges: sampleBridges, tokens: { "mini-45214": "token-mini" } });

    const registry = readRegistry(store);
    assert.equal(registry.version, 2);
    assert.equal(registry.revision, 3);
    assert.deepEqual(registry.deleted, []);
    assert.deepEqual(registry.tokens, { "mini-45214": { token: "token-mini", updatedAt: 0 } });

    const written = writeRegistry({ ...store, bridges: sampleBridges, tokens: registry.tokens, expectedRevision: 3 });
    assert.equal(written.revision, 4);
    assert.equal(JSON.parse(fs.readFileSync(store.filePath, "utf8")).version, 2);
    assert.deepEqual(readRegistry(store).tokens, { "mini-45214": { token: "token-mini", updatedAt: 0 } });
  });
});

test("processes racing to create the key settle on one of them", async () => {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".tmp-bridge-registry-"));
  const ports = [45214, 45224, 45234, 45244];
  const script = `
    const { registryKeyPath, registryPathForPort, writeRegistry } = require(${JSON.stringify(path.join(__dirname, "bridge-registry-store.js"))});
    const dir = process.argv[1];
    const port = process.argv[2];
    writeRegistry({
      filePath: registryPathForPort(dir, port),
      keyPath: registryKeyPath(dir),
      bridges: [{ id: "slot-" + port, baseUrl: "http://127.0.0.1:" + port }],
      tokens: { ["slot-" + port]: "token-" + port },
      expectedRevision: 0,
    });
  `;
  try {
    // Started together and left to collide: the first-run window this closes
    // only exists between one process creating the key file and writing it.
    const runs = ports.map(
      (port) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["-e", script, dir, String(port)], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (code) => resolve({ port, code, stderr }));
        }),
    );
    const results = await Promise.all(runs);
    assert.deepEqual(
      results.filter((result) => result.code !== 0),
      [],
      results.map((result) => `${result.port}: ${result.stderr}`).join("\n"),
    );
    for (const port of ports) {
      const store = storeFor(dir, port);
      assert.equal(readRegistry(store).tokens[`slot-${port}`].token, `token-${port}`);
    }
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a backup that cannot be published leaves the previous one readable", () => {
  for (const failing of ["renameSync", "fsyncSync"]) {
    withTempDir((dir) => {
      const store = storeFor(dir);
      writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });
      const before = fs.readFileSync(store.filePath, "utf8");

      const original = fs[failing];
      fs[failing] = () => {
        const error = new Error("no space left on device");
        error.code = "ENOSPC";
        throw error;
      };
      try {
        assert.throws(() => writeRegistry({ ...store, bridges: [sampleBridges[0]], tokens: {}, expectedRevision: 1 }), /no space left/);
      } finally {
        fs[failing] = original;
      }

      // The live file is only ever replaced by a rename, so a write that dies
      // partway leaves the last good backup exactly as it was.
      assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
      assert.equal(readRegistry(store).bridges.length, 2);
      assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
        [],
      );
    });
  }
});

test("a key is never published half-written", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    const original = fs.fsyncSync;
    fs.fsyncSync = () => {
      const error = new Error("disk gone");
      error.code = "EIO";
      throw error;
    };
    try {
      assert.throws(() => writeRegistry({ ...store, bridges: sampleBridges, tokens: {}, expectedRevision: 0 }), /disk gone/);
    } finally {
      fs.fsyncSync = original;
    }

    // Nothing at the key's own path until it is complete: another slot reading
    // mid-creation would otherwise find an empty file and call a good key
    // malformed, which fails the sync closed for no reason.
    assert.equal(fs.existsSync(store.keyPath), false);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

test("a stale revision is refused before anything is written", () => {
  withTempDir((dir) => {
    const store = storeFor(dir);
    writeRegistry({ ...store, bridges: sampleBridges, tokens: { "mini-45214": "token-mini" }, expectedRevision: 0 });
    const before = fs.readFileSync(store.filePath, "utf8");
    assert.throws(() => writeRegistry({ ...store, bridges: sampleBridges, tokens: {}, expectedRevision: 99 }), RegistryConflictError);
    assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
  });
});

test("each phone UI port keeps its own backup file", () => {
  withTempDir((dir) => {
    assert.notEqual(registryPathForPort(dir, 45214), registryPathForPort(dir, 45224));
    assert.ok(registryPathForPort(dir, 45224).endsWith(".phone-bridges.45224.local.json"));
    assert.throws(() => registryPathForPort(dir, "45214; rm -rf /"), /Invalid phone UI port/);
  });
});
