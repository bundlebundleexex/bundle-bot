const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const { getCollectionEndDate, isExtendedEndDate } = require("../stores/digiphile");

test("reads Digiphile's stated end date and requires a 20-hour renewal", () => {
  const html = "<div>This collection ends on Nov 26, 2026 at 2:00 AM</div>";
  const $ = cheerio.load(html);
  const date = getCollectionEndDate($, html);
  assert.ok(date);
  assert.equal(isExtendedEndDate("2026-11-25T00:00:00.000Z", date), true);
  assert.equal(isExtendedEndDate("2026-11-25T10:00:00.000Z", date), false);
  assert.equal(isExtendedEndDate(date, date), false);
});
