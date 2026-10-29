const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getActiveFreePromo,
  getAliases,
  isKnown,
  mergeCandidates
} = require("../stores/epic");

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
