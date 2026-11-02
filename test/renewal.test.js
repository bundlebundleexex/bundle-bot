const test = require("node:test");
const assert = require("node:assert/strict");
const { MIN_RENEWAL_EXTENSION_MS, isSignificantExtension } = require("../stores/renewal");

test("requires at least 20 hours for a bundle renewal notice", () => {
  const previous = "2026-11-02T10:00:00Z";
  assert.equal(MIN_RENEWAL_EXTENSION_MS, 20 * 60 * 60 * 1000);
  assert.equal(isSignificantExtension(previous, "2026-11-03T06:00:00Z"), true);
  assert.equal(isSignificantExtension(previous, "2026-11-03T05:59:59Z"), false);
  assert.equal(isSignificantExtension(previous, "2026-11-02T10:17:00Z"), false);
  assert.equal(isSignificantExtension(previous, "2026-11-02T09:00:00Z"), false);
});
