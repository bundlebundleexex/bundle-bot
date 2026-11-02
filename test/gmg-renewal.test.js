const test = require("node:test");
const assert = require("node:assert/strict");
const { getOfferRemainingMs } = require("../stores/gmg");

test("reads the Green Man Gaming countdown into a remaining duration", () => {
  assert.equal(getOfferRemainingMs("Offer ends 11 d 01 h 54 m 00 s"), (((11 * 24 + 1) * 60 + 54) * 60) * 1000);
  assert.equal(getOfferRemainingMs("Offer ends 00 d 00 h 00 m 00 s"), 0);
  assert.equal(getOfferRemainingMs("no end date shown"), null);
});
