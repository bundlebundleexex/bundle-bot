const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFanaticalDate, getEndDateKey } = require("../stores/fanatical");

test("treats Fanatical year 3001 as an open-ended sentinel", () => {
  assert.equal(parseFanaticalDate("3001-01-01T00:00:00Z"), null);
  assert.equal(getEndDateKey({ valid_until: "3001-01-01T00:00:00Z" }), "unknown-end");
});

test("keeps valid Fanatical expiration dates", () => {
  assert.equal(
    getEndDateKey({ valid_until: "2026-11-19T08:00:00Z" }),
    "2026-11-19T08:00:00Z"
  );
});
