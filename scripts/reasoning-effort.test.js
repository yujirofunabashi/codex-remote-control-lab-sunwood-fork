const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { normalizeReasoningEffort } = require("./start-phone");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("reasoning effort normalizer accepts app-server values and UI aliases", () => {
  assert.equal(normalizeReasoningEffort("low"), "low");
  assert.equal(normalizeReasoningEffort("XH"), "xhigh");
  assert.equal(normalizeReasoningEffort("maximum"), "max");
  assert.equal(normalizeReasoningEffort("ULTRA"), "ultra");
  assert.equal(normalizeReasoningEffort(null, { allowNull: true }), null);
  assert.equal(normalizeReasoningEffort(undefined), undefined);
  assert.throws(() => normalizeReasoningEffort("turbo"), /Unsupported reasoning effort: turbo/);
});

test("phone UI exposes model-gated Max and Ultra and sends the selected effort", () => {
  const html = read("public/index.html");
  const main = read("public/main.js");
  const utils = read("public/phone-ui-utils.js");
  const bridge = read("scripts/start-phone.js");

  assert.match(html, /data-reasoning="MAX"/);
  assert.match(html, /data-reasoning="ULTRA"/);
  assert.match(main, /reasoningCodesForModel\?\.\(record \|\| \{\}, fallback\)/);
  assert.match(utils, /model\?\.supportedReasoningEfforts/);
  assert.match(main, /reasoningEffortForCode\?\.\(effectiveReasoningCode\(\), "medium"\)/);
  assert.match(main, /const preferDefaultReasoning = hasReadyReasoning && msg\.reasoningEffort === null;/);
  assert.match(main, /requestSeq !== modelCatalogRequestSeq/);
  assert.match(main, /selectionVersion === reasoningSelectionVersion && requestedModel === selectedModel/);
  assert.match(main, /modelCatalog = \[\];\s+modelCatalogRequestSeq \+= 1;/);
  assert.match(bridge, /params\.effort = effort;/);
  assert.match(bridge, /reasoningEffort: this\.reasoningEffort,/);
  assert.match(bridge, /this\.pendingTurnSettings\.set\(id, \{ model: params\.model, reasoningEffort: requestedReasoningEffort \}\);/);
  assert.match(bridge, /this\.reasoningEffort = requestedSettings\.reasoningEffort;/);
});
