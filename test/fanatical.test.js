const test = require("node:test");
const assert = require("node:assert/strict");
const { getBundleKey, isPermanentlyBlocked, isGameBundle, hasSeenBundle, hasLegacyBundleKey, findPreviousEndDate, pruneInactiveFanaticalBundles } = require("../stores/fanatical");

test("does not treat Fanatical book bundles as game bundles", () => {
  assert.equal(isGameBundle({
    slug: "mass-effect-and-dragon-age-build-your-own-bioware-book-bundle",
    name: "Mass Effect and Dragon Age Build your own BioWare Book Bundle",
    display_type: "bundle"
  }), false);
  assert.equal(isGameBundle({
    slug: "bioware-rpg-bundle",
    name: "BioWare RPG Bundle",
    display_type: "bundle",
    drm: ["steam"]
  }), true);
});

test("permanently blocks the two Fanatical bundles requested", () => {
  assert.equal(isPermanentlyBlocked({ slug: "batman-arkham-collection", name: "Batman: Arkham Collection" }), true);
  assert.equal(isPermanentlyBlocked({ slug: "neurovoider-deluxe-edition", name: "NeuroVoider - Deluxe Edition" }), true);
  assert.equal(isPermanentlyBlocked({ slug: "some-other-game", name: "Some Other Game" }), false);
});

test("detects a renewed Fanatical offer as the same bundle with a changed end date", () => {
  const previous = { slug: "some-game-bundle", available_valid_from: "2026-11-01T10:00:00Z", available_valid_to: "2026-11-10T10:00:00Z" };
  const renewed = { ...previous, available_valid_to: "2026-11-17T10:00:00Z" };
  const key = getBundleKey(previous);
  assert.notEqual(key, getBundleKey(renewed));
  assert.equal(hasSeenBundle(new Set([key]), renewed.slug), true);
});

test("recognizes old persisted bundle keys so deployment does not call them renewals", () => {
  assert.equal(hasLegacyBundleKey(new Set(["old-game-bundle"]), "old-game-bundle"), true);
  assert.equal(hasLegacyBundleKey(new Set(["old-game-bundle:2026-10-01"]), "old-game-bundle"), true);
  assert.equal(hasLegacyBundleKey(new Set(["old-game-bundle:2026-10-01T10:00:00Z:2026-10-07T10:00:00Z"]), "old-game-bundle"), false);
});

test("reads the last known end date for a Fanatical bundle", () => {
  const history = new Set([
    "some-bundle:2026-10-01T10:00:00Z:2026-10-10T10:00:00Z",
    "some-bundle:2026-10-01T10:00:00Z:2026-10-17T10:00:00Z"
  ]);
  assert.equal(findPreviousEndDate(history, "some-bundle"), "2026-10-17T10:00:00Z");
});

test("keeps prior Fanatical end-date history while a bundle slug remains active", () => {
  const previousDate = "some-bundle:2026-10-01T10:00:00Z:2026-10-10T10:00:00Z";
  const inactive = "inactive-bundle:2026-10-01T10:00:00Z:2026-10-10T10:00:00Z";
  const savedData = { fanaticalBundles: [previousDate, inactive] };
  pruneInactiveFanaticalBundles(savedData, new Set([
    "some-bundle:2026-10-01T10:00:00Z:2026-10-11T10:00:00Z"
  ]), () => {});
  assert.deepEqual(savedData.fanaticalBundles, [previousDate]);
});

