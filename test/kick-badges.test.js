const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCampaign, makeRewardEmbed, sendReward } = require("../kick-badges");

function fixture() {
  return {
    kick_id: "campaign-1",
    name: "Chat Emote - True Damage",
    starts_at: "2026-10-28T08:00:00Z",
    ends_at: "2026-11-07T08:00:00Z",
    category: { name: "League of Legends" },
    rewards: [{
      id: "reward-1",
      name: "Chat Emote - True Damage",
      rule_name: "Watch 30 minutes to earn",
      image_url: "https://cdn.example/emote.png"
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
  assert.match(makeRewardEmbed(rewards[0]).data.description, /Darmowy — za oglądanie przez 30 min/);
  assert.equal(makeRewardEmbed(rewards[0]).data.footer.text, "Kick Emotka");
});

test("posts Kick messages without role pings and uses nonce duplicate protection", async () => {
  const [reward] = normalizeCampaign(fixture());
  const sent = [];
  const channel = { send: async payload => { sent.push(payload); return { id: "msg-1" }; } };
  await sendReward(channel, reward, "started");
  assert.match(sent[0].content, /BADGE\/EMOTKA KICK/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(sent[0].enforceNonce, true);
  assert.equal(sent[0].nonce.length, 25);
});

