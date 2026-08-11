// The connection sheet closes on any click that lands outside it, and every
// control that opens it sits outside it. So an opener that is not marked with
// `data-opens-bridge-fleet` opens the sheet and closes it again within the same
// click, and reads on the phone as a button that does nothing. That is how the
// approval banner's 承認一覧 button behaved before it was marked, and nothing in
// the unit tests could see it: the wiring, not the rule, was wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const mainSource = fs.readFileSync(path.join(publicDir, "main.js"), "utf8");
const indexSource = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const marker = "data-opens-bridge-fleet";

function elementIdFor(name) {
  const declaration = new RegExp(`const ${name} = document\\.querySelector\\("#([\\w-]+)"\\)`).exec(mainSource);
  return declaration ? declaration[1] : "";
}

function markedInMarkup(id) {
  const tag = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`).exec(indexSource);
  return Boolean(tag) && tag[0].includes(marker);
}

function markedInScript(name) {
  return mainSource.includes(`${name}.setAttribute("${marker}"`);
}

test("every control wired to open the connection sheet is marked as an opener", () => {
  const openers = mainSource
    .split("\n")
    .filter((line) => line.includes('addEventListener("click"') && line.includes("openBridgeFleet"))
    .map((line) => /(\w+)\??\.addEventListener\("click"/.exec(line)?.[1] || "");

  assert.ok(openers.length >= 4, `expected the known openers, found ${openers.length}`);
  assert.ok(!openers.includes(""), "an opener registration was written in a shape this check cannot read");

  for (const name of openers) {
    const id = elementIdFor(name);
    const marked = id ? markedInMarkup(id) : markedInScript(name);
    assert.ok(marked, `${name}${id ? ` (#${id})` : ""} opens the connection sheet but is not marked with ${marker}`);
  }
});

test("the sheet itself and its close button are not marked as openers", () => {
  assert.ok(!markedInMarkup("bridgeFleetSheet"));
  assert.ok(!markedInMarkup("closeBridgeFleet"));
});
