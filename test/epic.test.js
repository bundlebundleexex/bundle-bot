const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getActiveFreePromo,
  isEpicGameGiveaway,
  getAliases,
  isKnown,
  hasKnownOfficialTitle,
  mergeCandidates,
  formatDate,
  formatPromoWindow
} = require("../stores/epic");

test("formats Epic promo start and end in Polish local time without a remaining-time counter", () => {
  const window = formatPromoWindow({
    startDate: "2026-10-29T15:00:00Z",
    endDate: "2026-11-05T16:00:00Z"
  });
  assert.match(window, /Dostępny od: 29\.10\.2026, 16:00/);
  assert.match(window, /Dostępny do: 05\.11\.2026, 17:00/);
  assert.doesNotMatch(window, /zostało|pozostało/i);
  assert.equal(formatDate("2026-11-05T16:00:00Z"), "05.11.2026, 17:00");
});

test("uses the individual promo discount instead of a zero catalog price", () => {
  const now = new Date("2026-10-29T16:15:00Z");
  const game = {
    title: "Sorry We're Closed",
    price: { totalPrice: { discountPrice: 0 } },
    promotions: {
      promotionalOffers: [{
        promotionalOffers: [{
          startDate: "2026-10-29T15:00:00Z",
          endDate: "2026-11-02T16:00:00Z",
          discountSetting: { discountPercentage: 25 }
        }]
      }],
      upcomingPromotionalOffers: [{
        promotionalOffers: [{
          startDate: "2026-10-29T15:00:00Z",
          endDate: "2026-11-05T16:00:00Z",
          discountSetting: { discountPercentage: 0 }
        }]
      }]
    }
  };

  assert.equal(getActiveFreePromo(game, now)?.endDate, "2026-11-05T16:00:00Z");
});

test("merges duplicate regional products and keeps the latest free-promo end date", () => {
  const game = {
    id: "epic-offer-id",
    namespace: "epic-namespace",
    title: "Sorry We're Closed",
    productSlug: "sorry-were-closed"
  };
  const candidates = [
    {
      game,
      slug: "sorry-were-closed",
      activePromo: { endDate: "2026-11-02T16:00:00Z" }
    },
    {
      game: { ...game },
      slug: "sorry-were-closed",
      activePromo: { endDate: "2026-11-05T16:00:00Z" }
    }
  ];

  const merged = mergeCandidates(candidates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].activePromo.endDate, "2026-11-05T16:00:00Z");
});

test("merges official and supplemental copies of the same game and keeps Epic's end date", () => {
  const official = {
    game: { title: "Flotsam", productSlug: "flotsam-266287", keyImages: [] },
    slug: "flotsam-266287",
    aliases: ["epic:slug:flotsam-266287:2026-11-12T16:00:00.000Z"],
    activePromo: {
      startDate: "2026-11-05T16:00:00.000Z",
      endDate: "2026-11-12T16:00:00.000Z"
    }
  };
  const supplemental = {
    game: { title: "Flotsam", id: "gamerpower-123", claimUrl: "https://gamerpower.test/open" },
    slug: null,
    aliases: ["epic:gamerpower:123:2026-11-12T23:59:00.000Z"],
    activePromo: { startDate: null, endDate: "2026-11-12T23:59:00.000Z" },
    source: "GamerPower"
  };

  const merged = mergeCandidates([official, supplemental]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].activePromo.endDate, "2026-11-12T16:00:00.000Z");
  assert.equal(merged[0].source, undefined);
  assert.equal(merged[0].aliases.length, 2);
});

test("does not let GamerPower repost a title already announced from Epic with a different end date", () => {
  const known = new Set([
    "epic:title:flotsam:2026-11-12T16:00:00.000Z",
    "epic:slug:flotsam-266287:2026-11-12T16:00:00.000Z"
  ]);
  assert.equal(hasKnownOfficialTitle("Flotsam", known), true);
  assert.equal(hasKnownOfficialTitle("Different Game", known), false);
});

test("rejects expired GamerPower giveaways before constructing a supplemental post", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const expired = {
    status: "Active",
    type: "Game",
    platforms: "Epic Games Store",
    title: "Flotsam",
    end_date: "2026-11-12 23:59:00"
  };
  const active = { ...expired, end_date: "2026-11-14 23:59:00" };
  assert.equal(isEpicGameGiveaway(expired, now), false);
  assert.equal(isEpicGameGiveaway(active, now), true);
});

test("recognizes previously saved promo aliases when only the end date changed", () => {
  const game = {
    id: "epic-offer-id",
    title: "Sorry We're Closed"
  };
  const startDate = "2026-10-29T15:00:00Z";
  const oldAliases = getAliases(game, null, {
    startDate,
    endDate: "2026-11-02T16:00:00Z"
  });
  const correctedAliases = getAliases(game, null, {
    startDate,
    endDate: "2026-11-05T16:00:00Z"
  });

  assert.equal(isKnown(correctedAliases, new Set(oldAliases)), true);
});
