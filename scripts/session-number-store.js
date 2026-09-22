const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sessionNumberDirectory(env = process.env, home = os.homedir()) {
  // Machine/user scoped, not checkout, port, browser origin or workdir scoped.
  return env.PHONE_SESSION_NUMBERS_DIR || path.join(home, ".codex-phone", "session-numbers");
}

function validateSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length > 64) throw new TypeError("sessions must contain at most 64 conversations");
  return sessions.map(({ provider, threadId } = {}) => {
    if (!["codex", "claude", "gemini"].includes(provider)
      || typeof threadId !== "string" || !threadId.trim() || threadId.length > 512) {
      throw new TypeError("invalid conversation identity");
    }
    return { provider, threadId };
  });
}

class SessionNumberStore {
  constructor(directory = sessionNumberDirectory()) {
    this.directory = directory;
    this.providers = new Map();
  }

  assign(sessions) {
    // Validate the complete request before creating any files.
    return validateSessions(sessions).map((session) => ({ ...session, sessionNumber: this.numberFor(session) }));
  }

  numberFor({ provider, threadId }) {
    if (!this.providers.has(provider)) this.providers.set(provider, { numbers: new Map(), scanned: 0 });
    const cache = this.providers.get(provider);
    const directory = path.join(this.directory, provider);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    while (!cache.numbers.has(threadId)) {
      const number = cache.scanned + 1;
      const file = path.join(directory, `${number}.json`);
      let saved;
      try {
        saved = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Publish a fully written immutable slot, exclusively. Another bridge
        // winning this slot makes us read it again, never skip it. Because all
        // writers scan every preceding slot, simultaneous requests for one
        // conversation cannot allocate two numbers. No stale lock or mutable
        // shared counter can survive a crashed bridge.
        const temp = path.join(directory, `.${process.pid}-${crypto.randomUUID()}.tmp`);
        try {
          const fd = fs.openSync(temp, "wx", 0o600);
          try {
            fs.writeFileSync(fd, JSON.stringify({ threadId }));
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          try { fs.linkSync(temp, file); }
          catch (publishError) { if (publishError.code !== "EEXIST") throw publishError; }
        } finally { fs.rmSync(temp, { force: true }); }
        continue;
      }
      if (!saved || typeof saved.threadId !== "string" || !saved.threadId.trim()) throw new Error("Saved conversation number is unreadable");
      if (cache.numbers.has(saved.threadId)) throw new Error("Saved conversation number is duplicated");
      cache.numbers.set(saved.threadId, number);
      cache.scanned = number;
    }
    return cache.numbers.get(threadId);
  }
}

module.exports = { SessionNumberStore, sessionNumberDirectory };
