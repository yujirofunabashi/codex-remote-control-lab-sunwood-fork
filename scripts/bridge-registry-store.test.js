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
    assert.deepEqual(registry.tokens, { "mini-45214": "token-mini", "air-45214": "token-air" });
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
    assert.deepEqual(written.tokens, { "air-45214": "token-air" });
    assert.deepEqual(readRegistry(store).tokens, { "air-45214": "token-air" });
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
    assert.deepEqual(written.tokens, { "mini-45214": "token-mini" });
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

test("each phone UI port keeps its own backup file", () => {
  withTempDir((dir) => {
    assert.notEqual(registryPathForPort(dir, 45214), registryPathForPort(dir, 45224));
    assert.ok(registryPathForPort(dir, 45224).endsWith(".phone-bridges.45224.local.json"));
    assert.throws(() => registryPathForPort(dir, "45214; rm -rf /"), /Invalid phone UI port/);
  });
});
