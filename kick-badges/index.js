const axios = require("axios");
const crypto = require("node:crypto");
const { EmbedBuilder } = require("discord.js");
const { editExpiredReward } = require("../twitch-badges");

const API_URL = "https://ttvdrops.lovinator.space/api/v1/kick/campaigns/";
const API_ORIGIN = "https://ttvdrops.lovinator.space";
const CHANNEL_ID = process.env.KICK_BADGE_CHANNEL_ID?.trim() || "1545521319284838602";
const PAGE_SIZE = 500;

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function asDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function getCampaignId(campaign) {
  return String(firstValue(campaign.kick_id, campaign.id, campaign.campaign_id, ""));
}

function getCampaignStart(campaign) {
  return asDate(firstValue(campaign.starts_at, campaign.start_at, campaign.startsAt));
}

function getCampaignEnd(campaign) {
  return asDate(firstValue(campaign.ends_at, campaign.end_at, campaign.endsAt));
}

function getRewardMinutes(reward, campaign) {
  const direct = Number(firstValue(
    reward.required_minutes_watched,
    reward.watch_minutes,
    reward.minutes_watched,
    reward.required_watch_minutes,
    reward.duration_minutes,
    reward.minutes
  ));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const description = `${reward.rule_name || ""} ${reward.description || ""} ${campaign.rule_name || ""}`;
  const match = description.match(/(?:watch|oglądw*)\D{0,20}(\d+)\s*(?:minutes|minut|min)?/i);
  return match ? Number(match[1]) : 0;
}

function extractRewardEntries(campaign) {
  const directRewards = Array.isArray(campaign.rewards) ? campaign.rewards : [];
  const drops = Array.isArray(campaign.drops) ? campaign.drops : [];
  const nested = drops.flatMap(drop => (Array.isArray(drop.benefits) ? drop.benefits : []).map(benefit => ({
    ...benefit,
    drop,
    required_minutes_watched: firstValue(
      benefit.required_minutes_watched,
      drop.required_minutes_watched,
      drop.watch_minutes
    )
  })));
  return [...directRewards, ...nested];
}

function normalizeCampaign(campaign) {
  const id = getCampaignId(campaign);
  const start = getCampaignStart(campaign);
  const end = getCampaignEnd(campaign);
  if (!id || !start || !end || Date.parse(start) >= Date.parse(end)) return [];

  const category = firstValue(campaign.game, campaign.category, campaign.game_name, campaign.category_name, {});
  const gameName = typeof category === "string"
    ? category
    : firstValue(category.display_name, category.name, campaign.game_name, campaign.category_name, "Kick");
  const result = [];
  for (const reward of extractRewardEntries(campaign)) {
    const name = firstValue(reward.name, reward.title, reward.display_name);
    const rawType = String(firstValue(reward.distribution_type, reward.reward_type, reward.type, "")).toLowerCase();
    const text = `${name || ""} ${reward.description || ""} ${reward.rule_name || ""} ${rawType}`.toLowerCase();
    const isEmote = /emote|emoticon|chat emote/.test(text);
    const isBadge = /badge/.test(text);
    if (!name || (!isEmote && !isBadge)) continue;

    const minutes = getRewardMinutes(reward, campaign);
    if (minutes <= 0) continue;
    const rewardId = String(firstValue(reward.kick_id, reward.id, reward.reward_id, reward.slug, name));
    const imageValue = firstValue(reward.image_url, reward.image, reward.icon_url, reward.icon);
    let imageUrl = null;
    if (typeof imageValue === "string") {
      try { imageUrl = new URL(imageValue, API_ORIGIN).toString(); } catch {}
    }
    result.push({
      key: `${id}:${rewardId}`,
      campaignId: id,
      name,
      type: isEmote ? "EMOTE" : "BADGE",
      imageUrl,
      minutes,
      campaignStart: start,
      campaignEnd: end,
      gameName,
      campaignUrl: `https://ttvdrops.lovinator.space/kick/campaigns/${encodeURIComponent(id)}/`,
      categoryUrl: category.url || category.channel_url || null
    });
  }
  return result;
}

function makeRewardEmbed(reward) {
  const label = reward.type === "EMOTE" ? "Emotka" : "Badge";
  const embed = new EmbedBuilder()
    .setColor(0x53fc18)
    .setTitle(`${reward.type === "EMOTE" ? "😀" : "🎖️"} ${reward.name}`)
    .setURL(reward.campaignUrl)
    .setDescription([
      `**Gra/kategoria:** ${reward.categoryUrl ? `[${reward.gameName}](${reward.categoryUrl})` : reward.gameName}`,
      `**Dostęp:** Darmowy — za oglądanie przez ${reward.minutes} min na Kick`,
      `**Start:** ${formatDate(reward.campaignStart)}`,
      `**Koniec:** ${formatDate(reward.campaignEnd)}`
    ].join("\n"))
    .setFooter({ text: `Kick ${label}` })
    .setTimestamp();
  if (reward.imageUrl) embed.setThumbnail(reward.imageUrl);
  return embed;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

async function sendReward(channel, reward, phase) {
  const nonce = crypto.createHash("sha256").update(`kick:${reward.key}:${phase}`).digest("hex").slice(0, 25);
  const isScheduled = phase === "scheduled";
  return channel.send({
    content: isScheduled
      ? "🕒 **NADCHODZĄCY BADGE/EMOTKA KICK**"
      : "🎖️ **BADGE/EMOTKA KICK**",
    embeds: [makeRewardEmbed(reward)],
    nonce,
    enforceNonce: true,
    allowedMentions: { parse: [] }
  });
}

async function getCampaigns() {
  const lists = await Promise.all(["active", "upcoming"].map(async status => {
    const response = await axios.get(API_URL, {
      params: { status, page: 1, page_size: PAGE_SIZE },
      timeout: 20000
    });
    return Array.isArray(response.data?.items) ? response.data.items : [];
  }));
  return [...new Map(lists.flat().map(item => [getCampaignId(item), item]).filter(([id]) => id)).values()];
}

async function getCampaignDetails(summary) {
  const id = getCampaignId(summary);
  if (extractRewardEntries(summary).length) return summary;
  const response = await axios.get(`${API_URL}${encodeURIComponent(id)}/`, { timeout: 20000 });
  return response.data;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    savedData.kickDropRewardStates ??= {};
    const states = savedData.kickDropRewardStates;
    const summaries = await getCampaigns();
    const channel = await client.channels.fetch(CHANNEL_ID);
    let sent = 0;

    for (const summary of summaries) {
      let campaign;
      try {
        campaign = await getCampaignDetails(summary);
      } catch (err) {
        console.log(`Kick Drops: błąd kampanii ${getCampaignId(summary)}: ${err.response?.status || err.message}`);
        continue;
      }

      const rewards = normalizeCampaign(campaign);
      for (const reward of rewards) {
        const existing = states[reward.key];
        const now = Date.now();
        const start = Date.parse(reward.campaignStart);
        const end = Date.parse(reward.campaignEnd);
        if (end <= now) continue;
        const phase = start > now ? "scheduled" : "started";
        if (existing?.status === "started" || (existing?.status === "scheduled" && phase === "scheduled")) continue;
        const message = await sendReward(channel, reward, phase);
        states[reward.key] = {
          status: phase,
          startAt: reward.campaignStart,
          endAt: reward.campaignEnd,
          reward,
          messageId: message?.id || null
        };
        saveData();
        sent++;
      }
    }

    for (const state of Object.values(states)) {
      if (!["started", "scheduled"].includes(state.status)) continue;
      const start = Date.parse(state.startAt || state.reward?.campaignStart || "");
      const end = Date.parse(state.endAt || state.reward?.campaignEnd || "");
      if (!Number.isFinite(end) || end <= Date.now()) {
        await editExpiredReward(channel, state, "KICK");
        state.status = "expired";
        saveData();
      } else if (state.status === "scheduled" && Number.isFinite(start) && start <= Date.now()) {
        const message = await sendReward(channel, state.reward, "started");
        state.status = "started";
        state.messageId = message?.id || null;
        saveData();
        sent++;
      }
    }
    console.log(`Kick Drops: kampanii=${summaries.length}, wysłano=${sent}`);
  } catch (err) {
    console.log("Kick Drops error:", err.response?.status || err.message);
  }
};

module.exports.normalizeCampaign = normalizeCampaign;
module.exports.makeRewardEmbed = makeRewardEmbed;
module.exports.sendReward = sendReward;
