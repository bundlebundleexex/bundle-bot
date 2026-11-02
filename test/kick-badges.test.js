const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { normalizeCampaign, makeRewardEmbed, sendReward, getKickCategoryUrl, refreshRewardMessage, getCampaigns, check } = require("../kick-badges");

function fixture() {
  return {
    kick_id: "campaign-1",
    name: "Chat Emote - True Damage",
    starts_at: "2026-10-28T08:00:00Z",
    ends_at: "2026-11-07T08:00:00Z",
    category: { id: 5, name: "League of Legends", slug: "league-of-legends" },
    channels: [{ slug: "channelone", user: { username: "ChannelOne" } }, { slug: "channeltwo", user: { username: "ChannelTwo" } }],
    rewards: [{
      id: "reward-1",
      name: "Chat Emote - True Damage",
      required_units: 30,
      image_url: "drops/reward-image/emote.png"
    }, {
      id: "reward-skin",
      name: "Game skin",
      rule_name: "Watch 60 minutes to earn"
    }]
  };
}

test("extracts only Kick badge/emote drops and watch duration", () => {
  const rewards = normalizeCampaign(fixture());
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].type, "EMOTE");
  assert.equal(rewards[0].minutes, 30);
  assert.equal(rewards[0].gameName, "League of Legends");
  const embedData = makeRewardEmbed(rewards[0]).data;
  assert.equal(embedData.url, "https://kick.com/category/league-of-legends/drops");
  const description = embedData.description;
  assert.match(description, /\*\*Kampania:\*\* Chat Emote - True Damage/);
  assert.match(description, /\*\*Kategoria:\*\* \[League of Legends\]\(https:\/\/kick\.com\/category\/league-of-legends\/drops\)/);
  assert.match(description, /Darmowy — za oglądanie przez 30 min/);
  assert.match(embedData.description, /Dostępne dropy/);
  assert.equal(rewards[0].imageUrl, "https://ext.cdn.kick.com/drops/reward-image/emote.png");
  assert.equal(makeRewardEmbed(rewards[0]).data.footer.text, "Kick Emotka");
});

test("links category slugs to Kick instead of the scraper's internal category page", () => {
  assert.equal(
    getKickCategoryUrl({ name: "Call of Duty: Modern Warfare 4", slug: "call-of-duty-modern-warfare-4" }, "Call of Duty: Modern Warfare 4", "fallback"),
    "https://kick.com/category/call-of-duty-modern-warfare-4"
  );
  assert.equal(
    getKickCategoryUrl({ name: "League of Legends", url: "https://ttvdrops.lovinator.space/kick/games/5/" }, "League of Legends", "league-of-legends"),
    "https://kick.com/category/league-of-legends"
  );
});

test("links Kick rewards to the category page listing available drops", () => {
  const campaign = fixture();
  campaign.channels = [{ slug: "eddie", user: { username: "Eddie" } }];
  const [reward] = normalizeCampaign(campaign);
  assert.equal(reward.campaignUrl, "https://kick.com/eddie");
  assert.equal(makeRewardEmbed(reward).data.url, "https://kick.com/category/league-of-legends/drops");
  assert.match(makeRewardEmbed(reward).data.description, /https:\/\/kick\.com\/category\/league-of-legends\/drops/);
});

test("links category-wide drops to the Kick page listing available rewards", () => {
  const emoteCampaign = fixture();
  emoteCampaign.channels = [];
  const [emote] = normalizeCampaign(emoteCampaign);
  assert.equal(makeRewardEmbed(emote).data.url, "https://kick.com/category/league-of-legends/drops");
  assert.match(makeRewardEmbed(emote).data.description, /\*\*Dostępne dropy:\*\* \[Zobacz na Kicku\]/);

  const badgeCampaign = fixture();
  badgeCampaign.channels = [];
  badgeCampaign.rewards = [{ id: "badge-1", name: "MW4 Ghost Badge", required_units: 50 }];
  const [badge] = normalizeCampaign(badgeCampaign);
  assert.equal(makeRewardEmbed(badge).data.url, "https://kick.com/category/league-of-legends/drops");
});

test("posts Kick messages without role pings and uses nonce duplicate protection", async () => {
  const [reward] = normalizeCampaign(fixture());
  const sent = [];
  const channel = { send: async payload => { sent.push(payload); return { id: "msg-1" }; } };
  await sendReward(channel, reward, "started");
  assert.match(sent[0].content, /EMOTKA KICK/);
  assert.doesNotMatch(sent[0].content, /BADGE KICK/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(sent[0].enforceNonce, true);
  assert.equal(sent[0].nonce.length, 25);
});

test("keeps Kick posts to one short message with a link to available drops", async () => {
  const campaign = fixture();
  campaign.channels = Array.from({ length: 240 }, (_, index) => ({
    slug: `channel-${index + 1}`,
    user: { username: `Channel${index + 1}` }
  }));
  campaign.rewards = [{ id: "large-list-emote", name: "Large List Emote", required_units: 30 }];
  const [reward] = normalizeCampaign(campaign);
  const sent = [];
  const channel = { send: async payload => {
    sent.push(payload);
    return { id: `message-${sent.length}` };
  } };

  await sendReward(channel, reward, "started");
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /EMOTKA KICK/);
  assert.equal(sent[0].embeds.length, 1);
  assert.equal(sent[0].embeds[0].data.url, "https://kick.com/category/league-of-legends/drops");
  assert.match(sent[0].embeds[0].data.description, /Dostępne dropy/);
  assert.ok(sent[0].embeds[0].data.description.length < 1000);
});

test("labels badge rewards separately and uses matching scheduled wording", async () => {
  const campaign = fixture();
  campaign.rewards = [{ id: "badge-1", name: "MW4 Ghost Badge", required_units: 50 }];
  const [reward] = normalizeCampaign(campaign);
  const sent = [];
  const channel = { send: async payload => { sent.push(payload); return { id: "msg-badge" }; } };
  await sendReward(channel, reward, "started");
  await sendReward(channel, reward, "scheduled");
  assert.match(sent[0].content, /BADGE KICK/);
  assert.match(sent[1].content, /NADCHODZĄCY BADGE KICK/);
  assert.doesNotMatch(sent[0].content, /EMOTKA KICK/);
});

test("refreshes an existing Kick post with full campaign and channel data without reposting", async () => {
  const [reward] = normalizeCampaign(fixture());
  let editPayload;
  const state = { messageId: "message-123", reward: { name: "old data" } };
  const channel = { messages: { fetch: async id => {
    assert.equal(id, "message-123");
    return { edit: async payload => { editPayload = payload; } };
  } } };
  assert.equal(await refreshRewardMessage(channel, state, reward), true);
  assert.equal(state.reward, reward);
  assert.match(editPayload.embeds[0].data.description, /Dostępne dropy/);
  assert.deepEqual(editPayload.allowedMentions, { parse: [] });
});

test("replaces old Kick channel continuation posts with the single-message layout", async () => {
  const [reward] = normalizeCampaign(fixture());
  const deleted = [];
  const state = { messageId: "main", messageIds: ["main", "old-continuation"], reward: {} };
  const channel = { messages: { fetch: async id => ({
    edit: async () => {},
    delete: async () => deleted.push(id)
  }) } };
  assert.equal(await refreshRewardMessage(channel, state, reward), true);
  assert.deepEqual(deleted, ["old-continuation"]);
  assert.deepEqual(state.messageIds, ["main"]);
  assert.equal(state.messageFormatVersion, 2);
});

test("keeps separate Kick API records for one campaign so every reward is scanned", async () => {
  const first = { ...fixture(), rewards: [{ id: "badge-1", name: "One Badge", required_units: 10 }] };
  const second = { ...fixture(), rewards: [{ id: "badge-2", name: "Second Badge", required_units: 20 }] };
  const originalGet = axios.get;
  axios.get = async () => ({ data: [first, second] });
  try {
    const campaigns = await getCampaigns();
    assert.equal(campaigns.length, 2);
    assert.deepEqual(campaigns.flatMap(normalizeCampaign).map(reward => reward.name), ["One Badge", "Second Badge"]);
  } finally {
    axios.get = originalGet;
  }
});

test("recognizes all seven named active Kick badge/emote rewards with their UTC campaign dates", () => {
  const campaigns = [
    {
      kick_id: "lol-campaign",
      name: "Chat Emote - True Damage",
      starts_at: "2026-10-28T08:00:00Z",
      ends_at: "2026-11-07T08:00:00Z",
      category: { name: "League of Legends", slug: "league-of-legends" },
      rewards: [{ id: "lol-emote", name: "Chat Emote - True Damage", required_units: 30 }]
    },
    {
      kick_id: "mw4-campaign",
      name: "Modern Warfare 4",
      starts_at: "2026-10-23T00:00:00Z",
      ends_at: "2026-11-23T00:00:00Z",
      category: { name: "Call of Duty: Modern Warfare 4", slug: "call-of-duty-modern-warfare-4" },
      rewards: [{ id: "mw4-badge", name: "MW4 Ghost Badge", required_units: 3000 }]
    },
    {
      kick_id: "moon-campaign",
      name: "MOON Trading",
      starts_at: "2026-10-13T13:30:00Z",
      ends_at: "2026-11-03T12:30:00Z",
      category: { name: "Crypto & Trading", slug: "crypto-and-trading" },
      rewards: [
        { id: "moon-1", name: "1000X MOON Emote", required_units: 60 },
        { id: "moon-2", name: "God Candle Emote", required_units: 120 },
        { id: "moon-3", name: "TJR To The Moon Emote", required_units: 300 }
      ]
    },
    {
      kick_id: "talk-campaign",
      name: "KICK Talk Ed VS Ethan",
      starts_at: "2026-10-10T13:00:00Z",
      ends_at: "2026-11-07T17:00:00Z",
      category: { name: "Just Chatting", slug: "just-chatting" },
      channels: [{ slug: "eddie", user: { username: "Eddie" } }],
      rewards: [
        { id: "ethan-emote", name: "Ethan Emote", required_units: 60 },
        { id: "eddie-emote", name: "Eddie Emote", required_units: 120 },
        { id: "other-reward", name: "Eddie VS Ethan", required_units: 180 }
      ]
    }
  ];
  const rewards = campaigns.flatMap(normalizeCampaign);
  assert.deepEqual(rewards.map(reward => reward.name), [
    "Chat Emote - True Damage",
    "MW4 Ghost Badge",
    "1000X MOON Emote",
    "God Candle Emote",
    "TJR To The Moon Emote",
    "Ethan Emote",
    "Eddie Emote"
  ]);
  assert.equal(rewards[0].campaignStart, "2026-10-28T08:00:00.000Z");
  assert.match(makeRewardEmbed(rewards[0]).data.description, /Start:\*\* 28 paź 2026, 09:00/);
  const moonEnd = rewards.find(reward => reward.name === "1000X MOON Emote").campaignEnd;
  assert.match(makeRewardEmbed(rewards.find(reward => reward.name === "1000X MOON Emote")).data.description, /Koniec:\*\* 3 lis 2026, 13:30/);
  assert.equal(moonEnd, "2026-11-03T12:30:00.000Z");
});

test("unwraps Kick API list responses nested under data", async () => {
  const originalGet = axios.get;
  const records = [fixture()];
  axios.get = async () => ({ data: { data: { campaigns: records } } });
  try {
    assert.deepEqual(await getCampaigns(), records);
  } finally {
    axios.get = originalGet;
  }
});

test("scans every campaign reward and posts each badge/emote separately", async t => {
  const futureStart = new Date(Date.now() - 60_000).toISOString();
  const futureEnd = new Date(Date.now() + 86_400_000).toISOString();
  const campaigns = [
    { kick_id: "lol", name: "LOL", starts_at: futureStart, ends_at: futureEnd,
      category: { name: "League of Legends", slug: "league-of-legends" },
      rewards: [{ id: "lol-1", name: "Chat Emote - True Damage", required_units: 30 }] },
    { kick_id: "mw4", name: "Modern Warfare 4", starts_at: futureStart, ends_at: futureEnd,
      category: { name: "Call of Duty: Modern Warfare 4", slug: "call-of-duty-modern-warfare-4" },
      rewards: [{ id: "mw4-1", name: "MW4 Ghost Badge", required_units: 3000 }] },
    { kick_id: "moon", name: "MOON Trading", starts_at: futureStart, ends_at: futureEnd,
      category: { name: "Crypto & Trading", slug: "crypto-and-trading" },
      channels: Array.from({ length: 240 }, (_, index) => ({ slug: `moon-${index}`, user: { username: `Moon${index}` } })),
      rewards: [
        { id: "moon-1", name: "1000X MOON Emote", required_units: 60 },
        { id: "moon-2", name: "God Candle Emote", required_units: 120 },
        { id: "moon-3", name: "TJR To The Moon Emote", required_units: 300 }
      ] },
    { kick_id: "talk", name: "KICK Talk Ed VS Ethan", starts_at: futureStart, ends_at: futureEnd,
      category: { name: "Just Chatting", slug: "just-chatting" },
      rewards: [
        { id: "talk-1", name: "Ethan Emote", required_units: 60 },
        { id: "talk-2", name: "Eddie Emote", required_units: 120 },
        { id: "talk-3", name: "Eddie VS Ethan", required_units: 180 }
      ] }
  ];
  t.mock.method(axios, "get", async () => ({ data: campaigns }));
  const sent = [];
  const channel = { send: async payload => {
    sent.push(payload);
    return { id: `message-${sent.length}` };
  } };
  const client = { channels: { fetch: async () => channel } };
  const savedData = {};

  await check(client, savedData, () => {});

  const rewardPosts = sent.filter(payload => payload.content);
  assert.equal(rewardPosts.length, 7);
  assert.deepEqual(rewardPosts.map(payload => payload.embeds[0].data.title), [
    "🎭 Chat Emote - True Damage",
    "🎖️ MW4 Ghost Badge",
    "🎭 1000X MOON Emote",
    "🎭 God Candle Emote",
    "🎭 TJR To The Moon Emote",
    "🎭 Ethan Emote",
    "🎭 Eddie Emote"
  ]);
  assert.ok(sent.every(payload => payload.embeds.length === 1));
  assert.equal(Object.keys(savedData.kickDropRewardStates).length, 7);
});

