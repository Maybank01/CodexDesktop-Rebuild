const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ORIGINAL,
  PATCHED,
  patchSource,
} = require("../patch-windows-onboarding-recovery");

test("patches the stale Windows onboarding effect exactly once", () => {
  const result = patchSource(`before${ORIGINAL}after`);

  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${PATCHED}after`);
});

test("accepts an already patched onboarding bundle", () => {
  const result = patchSource(`before${PATCHED}after`);

  assert.equal(result.changed, false);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${PATCHED}after`);
});

test("rejects an unknown onboarding bundle shape", () => {
  assert.throws(
    () => patchSource("no onboarding effect"),
    /Expected one Windows onboarding recovery effect/,
  );
});
