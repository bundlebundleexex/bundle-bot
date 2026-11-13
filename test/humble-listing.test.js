const test = require("node:test");
const assert = require("node:assert/strict");
const { extractGameBundles, getGameBundleLink, parseJsonScripts, getChoicePageInfo, formatDate } = require("../stores/humble");
const axios = require("axios");
const { check } = require("../stores/humble");

const generationZero = {
  tile_name: "Generation Zero: Complete Bundle 2026",
  product_url: "/games/generation-zero-complete-bundle-2026",
  category: "bundle",
  "end_date|datetime": "2026-12-01T19:00:00Z",
  hero_highlights: [{ heading: "Starting at €7.99" }]
};

test("finds Humble game bundles when JSON moved to the landingPage-json-data script", () => {
  const html = `<html><head><script id="unrelated" type="application/json">{"hello":"world"}</script></head>
    <body><script id="landingPage-json-data" type="application/json">${JSON.stringify({
      data: { games: { mosaic: [{ products: [generationZero] }] } }
    })}</script></body></html>`;
  const bundles = extractGameBundles(html);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].tile_name, "Generation Zero: Complete Bundle 2026");
  assert.equal(getGameBundleLink(bundles[0]), "https://www.humblebundle.com/games/generation-zero-complete-bundle-2026");
});

test("searches every JSON script and nested product collection instead of relying on script position", () => {
  const html = `<script type="application/json">{"unrelated":true}</script>
    <script type="application/json">${JSON.stringify({ page: { products: [generationZero] } })}</script>`;
  const payloads = parseJsonScripts(html);
  assert.equal(payloads.length, 2);
  assert.equal(extractGameBundles(html).length, 1);
});

test("falls back to Humble /games links when embedded JSON is absent", () => {
  const html = `<div data-testid="product-card">
    <a data-testid="product-link" href="/games/generation-zero-complete-bundle-2026" aria-hidden="true">
      <div data-testid="product-thumbnail"><img src="https://hb.imgix.net/generation-zero.jpg"></div>
      <div data-testid="bundle-hover-titles">Get Generation Zero - Camo Weapon Skins Pack, and more!</div>
    </a>
    <div data-testid="product-card-footer"><a data-testid="product-link" href="/games/generation-zero-complete-bundle-2026">Generation Zero: Complete Bundle 2026</a></div>
  </div>`;
  const [bundle] = extractGameBundles(html);
  assert.equal(bundle.tile_name, "Generation Zero: Complete Bundle 2026");
  assert.equal(bundle.short_marketing_blurb, "Get Generation Zero - Camo Weapon Skins Pack, and more!");
  assert.equal(bundle.tile_image, "https://hb.imgix.net/generation-zero.jpg");
});

test("does not treat Humble store product URLs as game bundles", () => {
  assert.equal(getGameBundleLink({ product_url: "/store/some-game" }), null);
  assert.equal(getGameBundleLink({ product_url: "https://example.com/games/not-humble" }), null);
});

test("reads Humble Choice name and price from the redesigned page metadata", () => {
  const html = `<html><head><meta name="description" content="Get November 2026 Humble Choice and more when you subscribe"></head>
    <body><p>Get great games every month for only €12.99</p></body></html>`;
  assert.deepEqual(getChoicePageInfo(html), {
    machineName: "november_2026_choice",
    humanName: "November 2026 Humble Choice",
    price: { amount: 12.99, currency: "EUR" },
    endDate: null
  });
});

test("announces Generation Zero from the redesigned listing payload", async t => {
  const gamesHtml = `<div data-testid="product-card">
    <a data-testid="product-link" href="/games/generation-zero-complete-bundle-2026"><div data-testid="product-thumbnail"><img src="https://hb.imgix.net/generation-zero.jpg"></div></a>
    <div data-testid="product-card-footer"><a data-testid="product-link" href="/games/generation-zero-complete-bundle-2026">Generation Zero: Complete Bundle 2026</a></div>
  </div>`;
  const bundlePage = {
    id: "94a42531-32d8-4101-a10d-e72a16bd522c",
    slug: "generation-zero-complete-bundle-2026",
    title: "Generation Zero: Complete Bundle 2026",
    bundleType: "games",
    headline: "Fight for the future",
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    startDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    thumbnailImageUrl: "https://hb-prd.imgix.net/generation-zero.jpg",
    tiers: [{ price: { amount: 7.14, currencyCode: "EUR" } }]
  };
  const flight = `e:[["$","section",null,{"bundlePage":${JSON.stringify(bundlePage)}}]]\n`;
  const detailHtml = `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
  const choiceHtml = `<meta name="description" content="Get November 2026 Humble Choice and more when you subscribe">
    <p>Get great games every month for only €12.99</p>`;
  t.mock.method(axios, "get", async url => ({
    data: String(url) === "https://www.humblebundle.com/games" ? gamesHtml
      : String(url).includes("generation-zero-complete-bundle-2026") ? detailHtml
        : choiceHtml
  }));
  const sent = [];
  const channel = { send: async payload => { sent.push(payload); return { id: String(sent.length) }; } };
  const savedData = {
    humbleBundles: [],
    humbleBundleHistory: [],
    humbleChoice: "november_2026_choice"
  };

  await check({ channels: { fetch: async () => channel } }, savedData, () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].data.url, "https://www.humblebundle.com/games/generation-zero-complete-bundle-2026");
  assert.match(sent[0].embeds[0].data.title, /Generation Zero: Complete Bundle 2026/);
  assert.equal(sent[0].embeds[0].data.fields[0].value, "€7.14");
  assert.match(sent[0].embeds[0].data.description, /Fight for the future/);
  assert.ok(sent[0].embeds[0].data.fields.some(field => field.value === formatDate(bundlePage.endDate)));
  assert.equal(savedData.humbleBundles.length, 1);
});
