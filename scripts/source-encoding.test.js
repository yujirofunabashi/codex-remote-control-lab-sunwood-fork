const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const NUL = String.fromCharCode(0);

// Assets are expected to be binary; only text is held to the rule below.
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tgz", ".mp3", ".mp4", ".mov", ".wav",
  ".db", ".sqlite", ".sqlite3",
]);

test("no tracked text file carries a raw NUL byte", () => {
  // A sentinel that has to contain a NUL belongs in the source as an escape,
  // never as the byte itself: grep, diff and most editors call a file with one
  // binary and stop reading it. recentViewKey was written with the raw byte and
  // silently cost every grep of public/main.js its matches.
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split(NUL)
    .filter(Boolean);

  // Guard against a silent pass if the listing ever comes back empty.
  assert.ok(tracked.length > 0, "expected git to list tracked files");

  const offenders = tracked.filter((file) => {
    if (binaryExtensions.has(path.extname(file).toLowerCase())) return false;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(repoRoot, file));
    } catch {
      return false;
    }
    return bytes.includes(0);
  });

  assert.deepEqual(offenders, []);
});
