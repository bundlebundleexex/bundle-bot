const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { normalizeCampaign, makeRewardEmbed, sendReward, getKickCategoryUrl, refreshRewardMessage, getCampaigns } = require("../kick-badges");

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
  const channelField = makeRewardEmbed(rewards[0]).data.fields.find(field => field.name === "Kanały");
  assert.match(channelField.value, /\[ChannelOne\]\(https:\/\/kick\.com\/channelone\)/);
  assert.match(channelField.value, /\[ChannelTwo\]\(https:\/\/kick\.com\/channeltwo\)/);
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

test("links a channel-specific reward title directly to that channel", () => {
  const campaign = fixture();
  campaign.channels = [{ slug: "eddie", user: { username: "Eddie" } }];
  const [reward] = normalizeCampaign(campaign);
  assert.equal(reward.campaignUrl, "https://kick.com/eddie");
  assert.equal(makeRewardEmbed(reward).data.url, "https://kick.com/eddie");
  assert.match(makeRewardEmbed(reward).data.description, /https:\/\/kick\.com\/category\/league-of-legends\/drops/);
});

test("describes category-wide badge and emote drops with correct Polish wording", () => {
  const emoteCampaign = fixture();
  emoteCampaign.channels = [];
  const [emote] = normalizeCampaign(emoteCampaign);
  assert.equal(
    makeRewardEmbed(emote).data.fields.find(field => field.name === "Kanały").value,
    "Emotka do zdobycia na każdym kanale w tej kategorii"
  );

  const badgeCampaign = fixture();
  badgeCampaign.channels = [];
  badgeCampaign.rewards = [{ id: "badge-1", name: "MW4 Ghost Badge", required_units: 50 }];
  const [badge] = normalizeCampaign(badgeCampaign);
  assert.equal(
    makeRewardEmbed(badge).data.fields.find(field => field.name === "Kanały").value,
    "Badge do zdobycia na każdym kanale w tej kategorii"
  );
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
  assert.match(editPayload.embeds[0].data.fields[0].value, /ChannelOne/);
  assert.deepEqual(editPayload.allowedMentions, { parse: [] });
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

