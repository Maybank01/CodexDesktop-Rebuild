const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ORIGINAL,
  LEGACY_PATCHED,
  ORIGINAL_COMPILED_EFFECT,
  PATCHED_COMPILED_EFFECT,
  patchSource,
} = require("../patch-windows-onboarding-recovery");

test("patches the stale Windows onboarding effect exactly once", () => {
  const result = patchSource(`before${ORIGINAL}after`);

  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${LEGACY_PATCHED}after`);
});

test("upgrades the legacy patch so readiness changes re-run the effect", () => {
  const result = patchSource(`before${ORIGINAL_COMPILED_EFFECT}after`);

  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${PATCHED_COMPILED_EFFECT}after`);
});

test("accepts an already fully patched onboarding bundle", () => {
  const result = patchSource(`before${PATCHED_COMPILED_EFFECT}after`);

  assert.equal(result.changed, false);
  assert.equal(result.matched, true);
  assert.equal(result.source, `before${PATCHED_COMPILED_EFFECT}after`);
});

test("rejects an unknown onboarding bundle shape", () => {
  assert.throws(
    () => patchSource("no onboarding effect"),
    /Expected one Windows onboarding recovery effect/,
  );
});
