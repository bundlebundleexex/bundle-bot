const test = require("node:test");
const assert = require("node:assert/strict");
const { getCountdownRemainingMs } = require("../stores/indiegala");

test("reads IndieGala countdown units whether the number or label appears first", () => {
  const expected = ((15 * 24 + 23) * 60 + 15) * 60000 + 50 * 1000;
  assert.equal(getCountdownRemainingMs("15 days 23 hours 15 mins 50 secs"), expected);
  assert.equal(getCountdownRemainingMs("days 15 hours 23 mins 15 secs 50"), expected);
  assert.equal(getCountdownRemainingMs("bundle without a countdown"), null);
});
