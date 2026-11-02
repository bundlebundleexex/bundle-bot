const test = require("node:test");
const assert = require("node:assert/strict");
const { isBundleExtension, getBundleEndDate } = require("../stores/humble");

test("recognizes an exact Humble bundle extension whenever its end date moves later", () => {
  assert.equal(isBundleExtension("2026-11-02T10:00:00Z", "2026-11-09T10:00:00Z"), true);
  assert.equal(isBundleExtension("2026-11-02T10:00:00Z", "2026-11-02T09:59:00Z"), false);
  assert.equal(isBundleExtension(null, "2026-11-09T10:00:00Z"), false);
});

test("reads Humble end dates from the listing payload, including datetime-suffixed keys", () => {
  assert.equal(
    getBundleEndDate({ tile_data: { "end_date|datetime": "2026-11-19T09:00:00Z" } }),
    "2026-11-19T09:00:00.000Z"
  );
});

test("does not turn an open-ended or invalid Humble date into a deadline", () => {
  assert.equal(getBundleEndDate({ end_date: "3001-01-01T00:00:00Z" }), null);
  assert.equal(getBundleEndDate({}), null);
});
