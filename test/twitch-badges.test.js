const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const {
  flattenCampaignRewards,
  flattenCampaignBenefits,
  getAccessDescription,
  getWhereToWatch,
  validateCampaignSnapshot,
  makeRewardEmbed,
  check,
  sendReward
} = require("../twitch-badges");

function campaignFixture() {
  const startAt = new Date(Date.now() + 120000).toISOString();
  const endAt = new Date(Date.now() + 3600000).toISOString();
  return {
    twitch_id: "campaign-123",
    name: "Test campaign",
    description: "Test campaign description",
    status: "upcoming",
    start_at: startAt,
    end_at: endAt,
    updated_at: "2030-01-01T00:00:00Z",
    is_fully_imported: true,
    operation_names: ["ViewerDropsDashboard", "DropCampaignDetails"],
    game: { twitch_id: "game-123", display_name: "Test Game", slug: "test-game" },
    allowed_channels: [{ name: "channelone", display_name: "ChannelOne" }],
    drops: [
      {
        twitch_id: "drop-free",
        name: "Watch Drop",
        required_minutes_watched: 30,
        required_subs: 0,
        start_at: startAt,
        end_at: endAt,
        benefits: [{
          twitch_id: "emote-123",
          name: "Test Emote",
          image_url: "/media/emote.png",
          distribution_type: "EMOTE"
        }]
      },
      {
        twitch_id: "drop-paid",
        name: "Sub Drop",
        required_minutes_watched: 0,
        required_subs: 1,
        benefits: [{
          twitch_id: "badge-123",
          name: "Test Badge",
          image_url: "/media/badge.png",
          distribution_type: "BADGE"
        }]
      },
      {
        twitch_id: "drop-unqualified",
        name: "Other Drop",
        required_minutes_watched: 0,
        required_subs: 0,
        benefits: [{
          twitch_id: "ignored-123",
          name: "Not a Drop Reward",
          distribution_type: "EMOTE"
        }]
      },
      {
        twitch_id: "drop-skin",
        name: "Game Item Drop",
        required_minutes_watched: 60,
        required_subs: 0,
        start_at: startAt,
        end_at: endAt,
        benefits: [{
          twitch_id: "skin-123",
          name: "Limited Game Skin",
          distribution_type: "IN_GAME_ITEM"
        }]
      }
    ]
  };
}

test("keeps only badge/emote rewards with a watch or sub requirement", () => {
  const rewards = flattenCampaignRewards(campaignFixture());
  assert.deepEqual(rewards.map(reward => [reward.type, reward.name]), [
    ["EMOTE", "Test Emote"],
    ["BADGE", "Test Badge"]
  ]);
  assert.equal(rewards[0].imageUrl, "https://ttvdrops.lovinator.space/media/emote.png");
  assert.equal(flattenCampaignBenefits(campaignFixture()).find(item => item.name === "Limited Game Skin").type, "IN_GAME_ITEM");
});

test("formats watch and paid-sub requirements clearly", () => {
  const [emote, badge] = flattenCampaignRewards(campaignFixture());
  assert.match(getAccessDescription(emote), /Darmowy — za oglądanie przez 30 min/);
  assert.equal(emote.subs, 0, "zero required subs is treated as a free watch reward");
  assert.match(getAccessDescription(badge), /Płatny — za zakup subskrypcji/);
  assert.doesNotMatch(getAccessDescription(badge), /Prime/);
  badge.relatedDrops = [];
  assert.match(makeRewardEmbed(badge).data.description, /\*\*Sub z Prime się nie liczy\.\*\*/);
});

test("prefers detailed Twitch campaign data when summaries disagree", () => {
  const campaign = campaignFixture();
  const summary = {
    twitch_id: campaign.twitch_id,
    name: campaign.name,
    status: campaign.status,
    start_at: campaign.start_at,
    end_at: campaign.end_at,
    game: { twitch_id: campaign.game.twitch_id }
  };
  assert.equal(validateCampaignSnapshot(summary, campaign), null);
  assert.equal(validateCampaignSnapshot({ ...summary, status: "active" }, campaign), null);
  assert.match(
    validateCampaignSnapshot({ ...summary, end_at: "invalid" }, { ...campaign, end_at: "invalid" }),
    /dates missing or invalid/
  );
});

test("includes other active and scheduled rewards of the same category as a curiosity", () => {
  const [emote] = flattenCampaignRewards(campaignFixture());
  emote.relatedDrops = [{
    key: "other:drop:badge",
    type: "IN_GAME_ITEM",
    name: "Upcoming skin",
    subs: 0,
    minutes: 45,
    campaignStart: new Date(Date.now() + 3600000).toISOString(),
    campaignEnd: new Date(Date.now() + 7200000).toISOString()
  }, {
    key: "other:badge:badge",
    type: "BADGE",
    name: "Another Twitch badge",
    subs: 1,
    minutes: 0,
    campaignStart: new Date(Date.now() - 1000).toISOString(),
    campaignEnd: new Date(Date.now() + 7200000).toISOString()
  }, {
    key: "other:entitlement:drop",
    type: "DIRECT_ENTITLEMENT",
    name: "Game costume",
    subs: 1,
    minutes: 0,
    campaignStart: new Date(Date.now() - 1000).toISOString(),
    campaignEnd: new Date(Date.now() + 7200000).toISOString()
  }];
  const description = makeRewardEmbed(emote).data.description;
  assert.doesNotMatch(description, /\*\*Kampania:\*\*/);
  assert.match(description, /\*\*Gra\/kategoria:\*\* Test Game/);
  assert.match(description, /Dodatkowo dla tej kategorii/);
  assert.match(description, /Upcoming skin/);
  assert.match(description, /przedmiot do gry/);
  assert.match(description, /zaplanowane od/);
  assert.match(description, /45 min oglądania/);
  assert.doesNotMatch(description, /Another Twitch badge/);
  assert.doesNotMatch(description, /Game costume/);
  assert.doesNotMatch(description, /DIRECT_ENTITLEMENT|direct entitlement/i);
});

test("links specific channels by name and category-wide drops to the Twitch category", () => {
  const [emote] = flattenCampaignRewards(campaignFixture());
  assert.equal(
    getWhereToWatch(emote),
    "na kanale: [ChannelOne](https://www.twitch.tv/channelone)"
  );
  assert.match(getWhereToWatch({ ...emote, channels: [] }), /w kategorii: \[Test Game\]\(https:\/\/www\.twitch\.tv\/directory\/category\/test-game\)/);
});

test("links every allowed channel instead of truncating the list", () => {
  const channels = Array.from({ length: 40 }, (_, index) => ({
    name: `channel${index + 1}`,
    display_name: `Channel ${index + 1}`
  }));
  const location = getWhereToWatch({ channels });
  assert.equal((location.match(/\]\(https:\/\/www\.twitch\.tv\//g) || []).length, 40);
  assert.match(location, /Channel 40/);
  assert.doesNotMatch(location, /i jeszcze/);
});

test("uses stable phase-specific Discord nonces for duplicate-send protection", async () => {
  const [reward] = flattenCampaignRewards(campaignFixture());
  const payloads = [];
  const channel = { send: async payload => payloads.push(payload) };

  await Promise.all([
    sendReward(channel, reward, "scheduled"),
    sendReward(channel, reward, "scheduled")
  ]);

  assert.equal(payloads[0].nonce, payloads[1].nonce);
  assert.equal(payloads[0].nonce.length, 25);
  assert.equal(payloads[0].enforceNonce, true);
});

test("sends each qualifying badge/emote as a separate message and deduplicates", async t => {
  const fixture = campaignFixture();
  const summary = {
    twitch_id: fixture.twitch_id,
    name: fixture.name,
    status: fixture.status,
    start_at: fixture.start_at,
    end_at: fixture.end_at,
    game: { twitch_id: fixture.game.twitch_id },
    is_fully_imported: true,
    updated_at: fixture.updated_at
  };
  let detailFetches = 0;

  t.mock.method(axios, "get", async (url, config) => {
    if (url.endsWith("/api/v1/twitch/campaigns/")) {
      return {
        data: config.params.status === "active"
          ? { items: [summary] }
          : { items: [] }
      };
    }
    detailFetches++;
    return { data: fixture };
  });

  const sent = [];
  const client = {
    channels: {
      fetch: async id => {
        assert.equal(id, "1545521319284838602");
        return { send: async payload => sent.push(payload) };
      }
    }
  };
  const savedData = {};
  const saveData = () => {};

  await check(client, savedData, saveData);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(payload => payload.embeds.length === 1));
  assert.match(sent[0].content, /NADCHODZĄCA EMOTKA TWITCH/);
  assert.doesNotMatch(sent[0].content, /<@&/);
  assert.match(sent[1].content, /NADCHODZĄCY BADGE TWITCH/);
  assert.deepEqual(sent[0].allowedMentions.roles, []);
  assert.match(sent[1].embeds[0].data.description, /Sub z Prime się nie liczy/);
  assert.match(sent[1].embeds[0].data.description, /Płatny — za zakup subskrypcji na kanale/);
  assert.match(sent[0].embeds[0].data.description, /ChannelOne/);
  assert.doesNotMatch(sent[1].embeds[0].data.description, /Organizator|źródło|badge’a\]\(/i);
  assert.equal(sent[1].embeds[0].data.footer.text, "Twitch Badge");

  fixture.start_at = new Date(Date.now() - 60000).toISOString();
  fixture.end_at = new Date(Date.now() + 3600000).toISOString();
  fixture.status = "active";
  summary.status = "active";
  summary.start_at = fixture.start_at;
  summary.end_at = fixture.end_at;
  for (const drop of fixture.drops) {
    drop.start_at = fixture.start_at;
    drop.end_at = fixture.end_at;
  }
  summary.updated_at = "2030-01-02T00:00:00Z";
  await check(client, savedData, saveData);
  assert.equal(sent.length, 4, "campaign start sends a second, separate alert for each reward");
  assert.match(sent[2].content, /EMOTKA TWITCH DOSTĘPNA DO ZDOBYCIA/);
  assert.match(sent[2].content, /<@&1545400230504046602>/);
  assert.deepEqual(sent[2].allowedMentions.roles, ["1545400230504046602"]);

  await check(client, savedData, saveData);
  assert.equal(sent.length, 4, "start ping is sent only once");
  assert.equal(detailFetches, 2, "unchanged campaigns are not downloaded again");
});
