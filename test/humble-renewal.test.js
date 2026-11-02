const test = require("node:test");
const assert = require("node:assert/strict");
const { isBundleExtension } = require("../stores/humble");

test("recognizes an exact Humble bundle extension whenever its end date moves later", () => {
  assert.equal(isBundleExtension("2026-11-02T10:00:00Z", "2026-11-09T10:00:00Z"), true);
  assert.equal(isBundleExtension("2026-11-02T10:00:00Z", "2026-11-02T09:59:00Z"), false);
  assert.equal(isBundleExtension(null, "2026-11-09T10:00:00Z"), false);
});
