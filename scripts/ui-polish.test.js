const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("mobile viewport enables safe-area layout", () => {
  const html = read("public/index.html");
  const serviceWorker = read("public/service-worker.js");
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(serviceWorker, /const CACHE_NAME = "codex-phone-shell-v4";/);
});

test("utility panels hide Review Center tabs until Review Center is active", () => {
  const html = read("public/index.html");
  const main = read("public/main.js");
  const css = read("public/style.css");

  assert.match(html, /class="artifact-panel" data-panel-mode="utility"/);
  assert.match(main, /function clearPanel[\s\S]*artifactPanel\.dataset\.panelMode = "utility";/);
  assert.match(main, /function showReviewCenter[\s\S]*artifactPanel\.dataset\.panelMode = "review";/);
  assert.match(css, /\.artifact-panel\[data-panel-mode="utility"\] \.review-tabs\s*\{\s*display: none;/);
});

test("chat stream only follows output when the reader is near the bottom", () => {
  const main = read("public/main.js");

  assert.match(main, /const logAutoScrollThresholdPx = 72;/);
  assert.match(main, /function shouldAutoScrollLog\(\)/);
  assert.match(main, /function scrollLogToBottomIfNeeded\(shouldScroll = shouldAutoScrollLog\(\)\)/);
  assert.equal((main.match(/log\.scrollTop = log\.scrollHeight;/g) || []).length, 1);
  assert.match(
    main,
    /function addStatusGroupItem\(text\) \{\s+const shouldStickToBottom = shouldAutoScrollLog\(\);[\s\S]*scrollLogToBottomIfNeeded\(shouldStickToBottom\);/,
  );
  assert.match(
    main,
    /function addEntry\(kind, text, images = \[\], options = \{\}\) \{[\s\S]*const shouldStickToBottom = shouldAutoScrollLog\(\);[\s\S]*scrollLogToBottomIfNeeded\(shouldStickToBottom\);/,
  );
  assert.match(
    main,
    /if \(msg\.type === "assistantDelta"\) \{[\s\S]*const shouldStickToBottom = shouldAutoScrollLog\(\);[\s\S]*scrollLogToBottomIfNeeded\(shouldStickToBottom\);/,
  );
});
