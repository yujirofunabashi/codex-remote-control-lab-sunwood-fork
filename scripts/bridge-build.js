// App code identity is deliberately separate from the selected chat workdir.
// Local settings, credentials, histories and file timestamps are not build IDs.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000,
  }).trim();
}

function codeFiles(root) {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = `${relative}/${entry.name}`;
      // Do not read a linked file outside this application, including secrets.
      if (entry.isSymbolicLink()) throw new Error("Linked source is not a known build");
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile()) continue;
      if (relative === "scripts" && /(?:\.test|[-.]smoke)\.[cm]?js$/.test(entry.name)) continue;
      if (relative === "scripts" && /^test_lab_.*\.py$/.test(entry.name)) continue;
      if (/\.(?:[cm]?js|py|sh|html|css|json|webmanifest|svg|png|ico|woff2?)$/.test(entry.name)) files.push(name);
    }
  }
  for (const directory of ["public", "scripts"]) walk(directory);
  for (const file of ["package.json", "package-lock.json"]) if (fs.existsSync(path.join(root, file))) files.push(file);
  return files.sort();
}

function fingerprint(root, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error("Linked source is not a known build");
    const content = fs.readFileSync(absolute);
    hash.update(`${file}\0${content.length}\0`).update(content).update("\0");
  }
  return hash.digest("hex");
}

function sourceSnapshot(root) {
  try {
    if (fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== fs.realpathSync(root)) throw new Error("Not the app repository root");
    const files = codeFiles(root);
    let upstream = null;
    try {
      const name = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
      const [ahead, behind] = git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).split(/\s+/).map(Number);
      if (name && Number.isInteger(ahead) && Number.isInteger(behind)) upstream = { name, ahead, behind };
    } catch { /* No known tracking reference is not evidence of sharing. */ }
    return {
      schema: 1, available: true, root: path.resolve(root),
      branch: git(root, ["branch", "--show-current"]) || null,
      head: git(root, ["rev-parse", "HEAD"]),
      dirty: Boolean(git(root, ["status", "--porcelain=v1", "--untracked-files=normal"])),
      fingerprint: fingerprint(root, files),
      clientFingerprint: fingerprint(root, files.filter(file => file.startsWith("public/"))),
      serverFingerprint: fingerprint(root, files.filter(file => !file.startsWith("public/"))),
      upstream,
    };
  } catch {
    return { schema: 1, available: false, restartRequired: null };
  }
}

function createBuildTracker(root, { cacheMs = 5000 } = {}) {
  const running = sourceSnapshot(root);
  let snapshot = running, checkedAt = Date.now();
  return {
    status() {
      if (cacheMs === 0 || Date.now() - checkedAt >= cacheMs) {
        snapshot = sourceSnapshot(root);
        checkedAt = Date.now();
      }
      return {
        ...snapshot,
        runningServerFingerprint: running.serverFingerprint || null,
        restartRequired: snapshot.available && running.available
          ? snapshot.serverFingerprint !== running.serverFingerprint : null,
      };
    },
  };
}

module.exports = { sourceSnapshot, createBuildTracker };
