const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ORIGINAL,
  PATCHED,
  patchSource,
} = require("../patch-windows-process-snapshot-fallback");

test("makes the optional CPU WMI query non-blocking", () => {
  const result = patchSource(`before${ORIGINAL}after`);

  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${PATCHED}after`);
});

test("patches every duplicate process-snapshot implementation", () => {
  const result = patchSource(`${ORIGINAL}\n${ORIGINAL}`);

  assert.equal(result.source, `${PATCHED}\n${PATCHED}`);
});

test("accepts an already patched bundle", () => {
  const result = patchSource(`before${PATCHED}after`);

  assert.equal(result.changed, false);
  assert.equal(result.matched, true);
});

test("ignores unrelated bundles", () => {
  const result = patchSource("unrelated");

  assert.equal(result.changed, false);
  assert.equal(result.matched, false);
});
