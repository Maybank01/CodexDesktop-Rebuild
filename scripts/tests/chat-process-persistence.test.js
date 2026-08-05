const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ORIGINAL_READ,
  ORIGINAL_WRITE,
  PATCH_MARKER,
  patchSource,
} = require("../patch-chat-process-persistence");

test("makes chat process persistence atomic and recovers corrupt JSON", () => {
  const result = patchSource(`before${ORIGINAL_READ}${ORIGINAL_WRITE}after`);

  assert.equal(result.changed, true);
  assert.equal(result.matched, true);
  assert.match(result.source, /\.corrupt-\$\{Date\.now\(\)\}/u);
  assert.match(result.source, /\.tmp`/u);
  assert.match(result.source, /\.rename\)/u);
  assert.match(result.source, /flag:`wx`/u);
  assert.ok(result.source.includes(PATCH_MARKER));
});

test("accepts a bundle that already contains the persistence patch", () => {
  const result = patchSource(`before${PATCH_MARKER}after`);

  assert.equal(result.changed, false);
  assert.equal(result.matched, true);
});

test("rejects a partial match instead of shipping half a persistence fix", () => {
  assert.throws(
    () => patchSource(ORIGINAL_READ),
    /reader=1, writer=0/u,
  );
});

test("ignores unrelated bundles", () => {
  const result = patchSource("unrelated");

  assert.equal(result.changed, false);
  assert.equal(result.matched, false);
});
