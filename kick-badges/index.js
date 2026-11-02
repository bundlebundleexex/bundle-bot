const axios = require("axios");
const crypto = require("node:crypto");
const { EmbedBuilder } = require("discord.js");
const { editExpiredReward } = require("../twitch-badges");

const API_URL = "https://web.kick.com/api/v1/drops/campaigns";
const IMAGE_ORIGIN = "https://ext.cdn.kick.com/";
const CHANNEL_ID = process.env.KICK_BADGE_CHANNEL_ID?.trim() || "1545521319284838602";

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
    reward.minutes,
    reward.required_units
  ));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const description = `${reward.rule_name || ""} ${reward.description || ""} ${campaign.rule_name || ""}`;
  const match = description.match(/(?:watch|oglądw*)\D{0,20}(\d+)\s*(?:minutes|minut|min)?/i);
  return match ? Number(match[1]) : 0;
}

function slugifyCategory(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getKickCategoryUrl(category, name, slug) {
  const officialUrl = typeof category === "object"
    ? [category.kick_url, category.category_url, category.url]
      .find(value => typeof value === "string" && /^https?:\/\/(?:www\.)?kick\.com\//i.test(value))
    : null;
  if (officialUrl) return officialUrl;
  const categorySlug = typeof category === "object"
    ? firstValue(category.slug, category.category_slug, category.kick_slug, slug)
    : slug;
  return categorySlug ? `https://kick.com/category/${encodeURIComponent(categorySlug)}` : null;
}

function getCampaignChannels(campaign) {
  const rawChannels = [campaign.channels, campaign.allowed_channels, campaign.participating_channels]
    .find(Array.isArray) || [];
  const bySlug = new Map();
  for (const channel of rawChannels) {
    const slug = firstValue(
      channel?.slug,
      channel?.channel_slug,
      channel?.username,
      channel?.user?.username,
      channel?.name
    );
    if (!slug) continue;
    const name = firstValue(
      channel.display_name,
      channel.user?.username,
      channel.username,
      channel.name,
      slug
    );
    const suppliedUrl = [channel.url, channel.channel_url]
      .find(value => typeof value === "string" && /^https?:\/\/(?:www\.)?kick\.com\//i.test(value));
    bySlug.set(String(slug).toLowerCase(), {
      name: String(name),
      url: suppliedUrl || `https://kick.com/${encodeURIComponent(slug)}`
    });
  }
  return [...bySlug.values()];
}

function chunkChannelLinks(channels, maxLength = 950) {
  const chunks = [];
  let current = "";
  for (const channel of channels) {
    const line = `[${channel.name.replace(/[\[\]]/g, "")}](${channel.url})`;
    const next = current ? `${current}, ${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

  const category = firstValue(campaign.category, campaign.game, campaign.game_name, campaign.category_name, {});
  const gameName = typeof category === "string"
    ? category
    : firstValue(category.display_name, category.name, campaign.game_name, campaign.category_name, "Kick");
  const gameSlug = typeof category === "object"
    ? firstValue(category.slug, category.category_slug, category.kick_slug, slugifyCategory(gameName))
    : slugifyCategory(gameName);
  const categoryUrl = getKickCategoryUrl(category, gameName, gameSlug);
  const channels = getCampaignChannels(campaign);
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
      try { imageUrl = new URL(imageValue, IMAGE_ORIGIN).toString(); } catch {}
    }
    result.push({
      key: `${id}:${rewardId}`,
      campaignId: id,
      campaignName: firstValue(campaign.name, campaign.title, name),
      campaignChannels: channels,
      name,
      type: isEmote ? "EMOTE" : "BADGE",
      imageUrl,
      minutes,
      campaignStart: start,
      campaignEnd: end,
      gameName,
      campaignUrl: categoryUrl ? `${categoryUrl}/drops` : "https://kick.com/drops",
      categoryUrl
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
      `**Kampania:** ${reward.campaignName}`,
      `**Kategoria:** ${reward.categoryUrl ? `[${reward.gameName}](${reward.categoryUrl})` : reward.gameName}`,
      `**Dostęp:** Darmowy — za oglądanie przez ${reward.minutes} min na Kick`,
      `**Start:** ${formatDate(reward.campaignStart)}`,
      `**Koniec:** ${formatDate(reward.campaignEnd)}`
    ].join("\n"))
    .setFooter({ text: `Kick ${label}` })
    .setTimestamp();
  const channelChunks = chunkChannelLinks(reward.campaignChannels || []);
  if (channelChunks.length) {
    channelChunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? "Kanały" : "Kanały (ciąg dalszy)",
        value: chunk,
        inline: false
      });
    });
  } else {
    embed.addFields({ name: "Kanały", value: "Wszystkie kanały w tej kategorii", inline: false });
  }
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

async function refreshRewardMessage(channel, state, reward) {
  if (!state?.messageId || !channel?.messages?.fetch) return false;
  try {
    const message = await channel.messages.fetch(state.messageId);
    await message.edit({
      embeds: [makeRewardEmbed(reward)],
      allowedMentions: { parse: [] }
    });
    state.reward = reward;
    state.startAt = reward.campaignStart;
    state.endAt = reward.campaignEnd;
    return true;
  } catch (err) {
    console.log(`Kick Drops: nie udało się odświeżyć wiadomości ${reward.name}: ${err.message}`);
    return false;
  }
}

async function getCampaigns() {
  const response = await axios.get(API_URL, { timeout: 20000 });
  const data = response.data;
  const items = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.campaigns)
        ? data.campaigns
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.data?.campaigns)
            ? data.data.campaigns
            : [];
  // Kick may return several entries for one campaign, each with only a subset
  // of its rewards. Keep every entry; reward-key state deduplicates repeats.
  return items;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    savedData.kickDropRewardStates ??= {};
    const states = savedData.kickDropRewardStates;
    const summaries = await getCampaigns();
    const channel = await client.channels.fetch(CHANNEL_ID);
    let sent = 0;

    for (const campaign of summaries) {
      const rewards = normalizeCampaign(campaign);
      for (const reward of rewards) {
        const existing = states[reward.key];
        const now = Date.now();
        const start = Date.parse(reward.campaignStart);
        const end = Date.parse(reward.campaignEnd);
        if (end <= now) continue;
        const phase = start > now ? "scheduled" : "started";
        if (existing?.status === phase) {
          if (JSON.stringify(existing.reward || {}) !== JSON.stringify(reward)) {
            if (await refreshRewardMessage(channel, existing, reward)) saveData();
          }
          continue;
        }
        if (existing?.status === "started") continue;
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
module.exports.refreshRewardMessage = refreshRewardMessage;
module.exports.slugifyCategory = slugifyCategory;
module.exports.getKickCategoryUrl = getKickCategoryUrl;
module.exports.getCampaigns = getCampaigns;
