const axios = require("axios");
const crypto = require("node:crypto");
const { EmbedBuilder } = require("discord.js");
const { editExpiredReward } = require("../twitch-badges");

const API_URL = "https://web.kick.com/api/v1/drops/campaigns";
const IMAGE_ORIGIN = "https://ext.cdn.kick.com/";
const CHANNEL_ID = process.env.KICK_BADGE_CHANNEL_ID?.trim() || "1545521319284838602";
const RENEWAL_MIN_EXTENSION_MS = 20 * 60 * 60 * 1000;
const SCHEDULED_ANNOUNCEMENT_LEAD_MS = 12 * 60 * 60 * 1000;
const HISTORY_MAX_PAGES = 15;
const HISTORY_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;

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
  // Kick's live Drops API currently uses `start`/`end`; other snapshots and
  // older responses use the *_at / camelCase variants. Accept all of them so
  // a valid campaign is not discarded before its rewards are inspected.
  return asDate(firstValue(campaign.starts_at, campaign.start_at, campaign.startsAt, campaign.start));
}

function getCampaignEnd(campaign) {
  return asDate(firstValue(campaign.ends_at, campaign.end_at, campaign.endsAt, campaign.end));
}

function getRewardPhase(startAt, now = Date.now()) {
  const start = Date.parse(startAt || "");
  if (!Number.isFinite(start)) return null;
  if (start <= now) return "started";
  return start - now >= SCHEDULED_ANNOUNCEMENT_LEAD_MS ? "scheduled" : null;
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

function getRewardType(reward, name, typeOverride, campaign) {
  if (typeOverride?.type === "EMOTE" || typeOverride?.type === "BADGE") return typeOverride.type;

  // The Kick campaign endpoint does not currently expose a consistent type
  // field. Read the common API spellings (including nested metadata) before
  // falling back to the reward's visible text.
  const typeValues = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:type|kind|reward_?type|distribution_?type|benefit_?type|reward_?kind|asset_?type)$/i.test(key)) {
        if (typeof child === "string") typeValues.push(child);
      }
      // extractRewardEntries attaches the parent drop for its watch rule;
      // don't let a sibling benefit's type leak into this reward's type.
      if (key === "drop") continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(reward);
  const rawType = typeValues.join(" ").toLowerCase();
  const text = `${name || ""} ${reward.description || ""} ${reward.rule_name || ""} ${reward.drop?.description || ""} ${reward.drop?.rule_name || ""} ${reward.display_type || ""} ${rawType}`.toLowerCase();
  const isExplicitChatEmote = /chat\s*(?:emote|emoji|emoticon)/.test(text);
  const hasEmoteLabel = /emote|emoticon/.test(text);
  if (isExplicitChatEmote) return "EMOTE";
  if (hasEmoteLabel) {
    const organization = String(campaign?.organization?.name || campaign?.organization?.display_name || "")
      .trim()
      .toLowerCase();
    // A publisher's game reward called "Emote" is not necessarily a Kick
    // chat emote. For generic names, require Kick as the organizer unless the
    // payload explicitly identifies a chat emote or a verified override exists.
    if (organization !== "kick") return null;
    return "EMOTE";
  }
  if (/badge/.test(text)) return "BADGE";
  return null;
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

function getKickCategoryDropsUrl(categoryUrl) {
  if (!categoryUrl) return null;
  return categoryUrl.replace(/\/+$/, "").replace(/\/drops$/i, "") + "/drops";
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

function normalizeCampaign(campaign, ignoredRewards = [], rewardTypeOverrides = []) {
  const ignoreList = Array.isArray(ignoredRewards) ? ignoredRewards : [];
  const typeOverrides = Array.isArray(rewardTypeOverrides) ? rewardTypeOverrides : [];
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
  const categoryDropsUrl = getKickCategoryDropsUrl(categoryUrl);
  const channels = getCampaignChannels(campaign);
  const result = [];
  for (const reward of extractRewardEntries(campaign)) {
    const name = firstValue(reward.name, reward.title, reward.display_name);
    const ignored = ignoreList.some(item =>
      String(item?.campaignId || "") === id &&
      String(item?.name || "").trim().toLowerCase() === String(name || "").trim().toLowerCase()
    );
    if (ignored) continue;
    const typeOverride = typeOverrides.find(item =>
      String(item?.campaignId || "") === id &&
      String(item?.name || "").trim().toLowerCase() === String(name || "").trim().toLowerCase()
    );
    const rewardType = getRewardType(reward, name, typeOverride, campaign);
    const isEmote = rewardType === "EMOTE";
    const isBadge = rewardType === "BADGE";
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
      campaignUrl: channels.length === 1
        ? channels[0].url
        : categoryDropsUrl || "https://kick.com/drops",
      categoryUrl: categoryDropsUrl
    });
  }
  return result;
}

function makeRewardEmbed(reward) {
  const label = reward.type === "EMOTE" ? "Emotka" : "Badge";
  const embed = new EmbedBuilder()
    .setColor(0x53fc18)
    .setTitle(`${reward.type === "EMOTE" ? "🎭" : "🎖️"} ${reward.name}`)
    .setURL(reward.categoryUrl || reward.campaignUrl)
    .setDescription([
      `**Kampania:** ${reward.campaignName}`,
      `**Kategoria:** ${reward.categoryUrl ? `[${reward.gameName}](${reward.categoryUrl})` : reward.gameName}`,
      `**Dostęp:** Darmowy — za oglądanie przez ${reward.minutes} min na Kick`,
      `**Start:** ${formatDate(reward.campaignStart)}`,
      `**Koniec:** ${formatDate(reward.campaignEnd)}`,
      reward.categoryUrl ? `**Dostępne dropy:** [Zobacz na Kicku](${reward.categoryUrl})` : null
    ].filter(Boolean).join("\n"))
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

function rewardFingerprint(reward) {
  return [reward.name, reward.campaignName, formatDate(reward.campaignStart)]
    .map(value => String(value || "").trim().toLowerCase())
    .join("|");
}

function parsePolishDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})$/i);
  if (!match) return null;
  const months = { sty: 0, lut: 1, mar: 2, kwi: 3, maj: 4, cze: 5, lip: 6, sie: 7, wrz: 8, paź: 9, paz: 9, lis: 10, gru: 11 };
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const month = months[monthText.toLowerCase()];
  if (month === undefined) return null;
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const lastSunday = monthIndex => {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return lastDay - new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay();
  };
  const dstStart = Date.UTC(year, 2, lastSunday(2));
  const dstEnd = Date.UTC(year, 9, lastSunday(9));
  const localDay = Date.UTC(year, month, day);
  const offsetHours = localDay >= dstStart && localDay < dstEnd ? 2 : 1;
  return new Date(Date.UTC(year, month, day, hour, minute) - offsetHours * 60 * 60 * 1000).toISOString();
}

function messageRewardFingerprint(message) {
  const embed = message.embeds?.[0];
  if (!embed?.title || !embed?.description) return null;
  const title = embed.title.replace(/^(?:🎭|🎖️)\s*/u, "").trim();
  const campaign = embed.description.match(/^\*\*Kampania:\*\*\s*(.+)$/m)?.[1]?.trim();
  const start = embed.description.match(/^\*\*Start:\*\*\s*(.+)$/m)?.[1]?.trim();
  if (!campaign || !start) return null;
  const normalizedStart = parsePolishDate(start);
  return [title, campaign, normalizedStart ? formatDate(normalizedStart) : start]
    .map(value => value.toLowerCase())
    .join("|");
}

async function loadRecentRewardMessages(channel, botUserId) {
  const matches = new Map();
  if (!channel?.messages?.fetch || !botUserId) return matches;
  const cutoff = Date.now() - HISTORY_LOOKBACK_MS;
  let before;
  try {
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const messages = [...batch.values()];
      if (!messages.length) break;
      for (const message of messages) {
        if (message.author?.id !== botUserId || !message.content || message.createdTimestamp < cutoff) continue;
        const fingerprint = messageRewardFingerprint(message);
        if (fingerprint) {
          if (!matches.has(fingerprint)) matches.set(fingerprint, []);
          matches.get(fingerprint).push(message);
        }
      }
      const oldest = messages[messages.length - 1];
      if (!oldest?.id || oldest.createdTimestamp < cutoff || messages.length < 100) break;
      before = oldest.id;
    }
  } catch (err) {
    console.log(`Kick Drops: nie udało się sprawdzić historii kanału pod kątem duplikatów: ${err.message}`);
  }
  return matches;
}

async function sendReward(channel, reward, phase) {
  const nonce = crypto.createHash("sha256").update(`kick:${reward.key}:${phase}`).digest("hex").slice(0, 25);
  return channel.send({
    content: rewardMessageContent(reward, phase),
    embeds: [makeRewardEmbed(reward)],
    nonce,
    enforceNonce: true,
    allowedMentions: { parse: [] }
  });
}

async function sendRenewalNotice(channel, reward, previousEnd) {
  const isEmote = reward.type === "EMOTE";
  const kind = isEmote ? "EMOTKA" : "BADGE";
  const notice = new EmbedBuilder()
    .setColor(0xf0a52b)
    .setTitle(`🔁 ${reward.name}`)
    .setURL(reward.categoryUrl || reward.campaignUrl)
    .setDescription([
      `**Kampania:** ${reward.campaignName}`,
      `**Kategoria:** ${reward.categoryUrl ? `[${reward.gameName}](${reward.categoryUrl})` : reward.gameName}`,
      `Termin zdobycia ${isEmote ? "emotki" : "badge'a"} został przedłużony.`,
      `**Poprzednio do:** ${formatDate(previousEnd)}`,
      `**Nowy termin:** ${formatDate(reward.campaignEnd)}`
    ].join("\n"))
    .setFooter({ text: `Kick ${isEmote ? "Emotka" : "Badge"} · przedłużenie` })
    .setTimestamp();
  if (reward.imageUrl) notice.setThumbnail(reward.imageUrl);
  const nonce = crypto.createHash("sha256")
    .update(`kick-renewal:${reward.key}:${reward.campaignEnd}`)
    .digest("hex")
    .slice(0, 25);
  return channel.send({
    content: `🔁 **${kind} KICK PRZEDŁUŻON${isEmote ? "A" : "Y"}**`,
    embeds: [notice],
    nonce,
    enforceNonce: true,
    allowedMentions: { parse: [] }
  });
}

async function notifyRewardRenewal(channel, state, reward, previousEnd, saveData) {
  const baselineEnd = state.renewalBaselineEndAt || state.lastRenewalNotifiedEndAt || previousEnd;
  const previousEndMs = Date.parse(baselineEnd || "");
  const nextEndMs = Date.parse(reward.campaignEnd);
  if (!Number.isFinite(previousEndMs)) return false;
  let changed = false;
  if (!state.renewalBaselineEndAt) {
    state.renewalBaselineEndAt = new Date(previousEndMs).toISOString();
    changed = true;
  }
  if (nextEndMs - previousEndMs < RENEWAL_MIN_EXTENSION_MS ||
      state.lastRenewalNotifiedEndAt === reward.campaignEnd) {
    if (changed) saveData();
    return false;
  }
  try {
    await sendRenewalNotice(channel, reward, new Date(previousEndMs).toISOString());
    state.lastRenewalNotifiedEndAt = reward.campaignEnd;
    state.renewalBaselineEndAt = reward.campaignEnd;
    state.lastRenewalNotifiedAt = new Date().toISOString();
    saveData();
    return true;
  } catch (err) {
    console.log(`Kick Drops: nie udało się wysłać informacji o przedłużeniu ${reward.name}: ${err.message}`);
    return false;
  }
}

function rewardMessageContent(reward, phase) {
  const isScheduled = phase === "scheduled";
  const isEmote = reward.type === "EMOTE";
  const heading = isEmote ? "EMOTKA KICK" : "BADGE KICK";
  const scheduledHeading = isEmote ? "NADCHODZĄCA EMOTKA KICK" : "NADCHODZĄCY BADGE KICK";
  return isScheduled
    ? `🕒 **${scheduledHeading}**`
    : `${isEmote ? "🎭" : "🎖️"} **${heading}**`;
}

async function refreshRewardMessage(channel, state, reward, phase = null) {
  if (!state?.messageId || !channel?.messages?.fetch) return false;
  try {
    const message = await channel.messages.fetch(state.messageId);
    const update = {
      embeds: [makeRewardEmbed(reward)],
      allowedMentions: { parse: [] }
    };
    if (phase) update.content = rewardMessageContent(reward, phase);
    await message.edit(update);
    for (const id of new Set(state.messageIds || [])) {
      if (!id || id === state.messageId) continue;
      try {
        const continuation = await channel.messages.fetch(id);
        await continuation.delete();
      } catch (err) {
        if (err.code !== 10008) console.log(`Kick Drops: nie udało się usunąć starej kontynuacji ${id}: ${err.message}`);
      }
    }
    state.reward = reward;
    state.startAt = reward.campaignStart;
    state.endAt = reward.campaignEnd;
    state.messageIds = [state.messageId];
    state.messageFormatVersion = 2;
    return true;
  } catch (err) {
    console.log(`Kick Drops: nie udało się odświeżyć wiadomości ${reward.name}: ${err.message}`);
    return false;
  }
}

async function getCampaigns() {
  const response = await axios.get(API_URL, { timeout: 20000 });
  const data = response.data;
  const payload = data?.data ?? data;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.campaigns)
        ? payload.campaigns
        : Array.isArray(payload?.data?.items)
          ? payload.data.items
          : Array.isArray(payload?.data?.campaigns)
            ? payload.data.campaigns
            : [];
  // Kick may return several entries for one campaign, each with only a subset
  // of its rewards. Keep every entry; reward-key state deduplicates repeats.
  return items;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    savedData.kickDropRewardStates ??= {};
    const states = savedData.kickDropRewardStates;
    const ignoredRewards = Array.isArray(savedData.kickDropIgnoredRewards)
      ? savedData.kickDropIgnoredRewards
      : [];
    const rewardTypeOverrides = Array.isArray(savedData.kickDropRewardTypeOverrides)
      ? savedData.kickDropRewardTypeOverrides
      : [];
    const renewalBaselines = Array.isArray(savedData.kickDropRenewalBaselines)
      ? savedData.kickDropRenewalBaselines
      : [];
    const getRenewalBaseline = reward => renewalBaselines.find(item =>
      item?.campaignId === reward.campaignId && item?.currentEndAt === reward.campaignEnd
    )?.previousEndAt || null;
    for (const state of Object.values(states)) {
      if (state?.reward && !state.renewalBaselineEndAt) {
        const baseline = renewalBaselines.find(item =>
          item?.campaignId === state.reward.campaignId && item?.currentEndAt === state.reward.campaignEnd
        )?.previousEndAt;
        if (baseline) {
          state.renewalBaselineEndAt = baseline;
          saveData();
        }
      }
    }
    const summaries = await getCampaigns();
    const channel = await client.channels.fetch(CHANNEL_ID);
    let sent = 0;
    let rawRewards = 0;
    let eligibleRewards = 0;
    let alreadyKnown = 0;
    let expiredRewards = 0;
    let recentRewardMessages = null;
    const unclassifiedRewards = [];

    for (const campaign of summaries) {
      let rewards;
      try {
        const entries = extractRewardEntries(campaign);
        rawRewards += entries.length;
        rewards = normalizeCampaign(campaign, ignoredRewards, rewardTypeOverrides);
        if (getCampaignStart(campaign) && getCampaignEnd(campaign)) {
          for (const item of entries) {
            const name = firstValue(item.name, item.title, item.display_name);
            if (!name || getRewardMinutes(item, campaign) <= 0) continue;
            const ignored = ignoredRewards.some(entry =>
              String(entry?.campaignId || "") === getCampaignId(campaign) &&
              String(entry?.name || "").trim().toLowerCase() === String(name).trim().toLowerCase()
            );
            if (ignored) continue;
            const override = rewardTypeOverrides.find(entry =>
              String(entry?.campaignId || "") === getCampaignId(campaign) &&
              String(entry?.name || "").trim().toLowerCase() === String(name).trim().toLowerCase()
            );
            if (!getRewardType(item, name, override, campaign)) {
              unclassifiedRewards.push(`${firstValue(campaign.name, campaign.title, "Kick")}: ${name}`);
            }
          }
        }
      } catch (err) {
        console.log(`Kick Drops: pomijam nieprawidłową kampanię ${campaign?.name || campaign?.id || "bez nazwy"}: ${err.message}`);
        continue;
      }
      eligibleRewards += rewards.length;
      for (const reward of rewards) {
        const existing = states[reward.key];
        const now = Date.now();
        const start = Date.parse(reward.campaignStart);
        const end = Date.parse(reward.campaignEnd);
        if (end <= now) {
          expiredRewards++;
          continue;
        }
        const phase = getRewardPhase(reward.campaignStart, now);
        if (!phase) {
          // Don't publish an "upcoming" post less than 12 hours before start.
          // If we already announced it earlier, keep that post and refresh its
          // dates while preserving its scheduled heading.
          if (existing?.status === "scheduled" &&
              (existing.messagePhase !== "scheduled" ||
               JSON.stringify(existing.reward || {}) !== JSON.stringify(reward))) {
            if (await refreshRewardMessage(channel, existing, reward, "scheduled")) {
              existing.messagePhase = "scheduled";
              saveData();
            }
          }
          continue;
        }
        if (existing?.status === phase) {
          alreadyKnown++;
          const previousEnd = existing.endAt || existing.reward?.campaignEnd;
          if (existing.messagePhase !== phase ||
              existing.messageFormatVersion !== 2 ||
              JSON.stringify(existing.reward || {}) !== JSON.stringify(reward)) {
            if (await refreshRewardMessage(channel, existing, reward, phase)) {
              existing.messagePhase = phase;
              saveData();
            }
          }
          await notifyRewardRenewal(channel, existing, reward, previousEnd, saveData);
          continue;
        }
        if (existing?.status === "started" && phase === "scheduled") {
          if (await refreshRewardMessage(channel, existing, reward, phase)) {
            existing.status = phase;
            existing.messagePhase = phase;
            saveData();
          }
          continue;
        }
        // A campaign can be extended after a scan already marked it expired.
        // Reuse its original Discord post when the same campaign/reward becomes
        // active again; do not announce the extension as a second new drop.
        if (existing?.status === "expired" && phase === "started" && existing.messageId) {
          alreadyKnown++;
          const previousEnd = existing.endAt || existing.reward?.campaignEnd;
          if (await refreshRewardMessage(channel, existing, reward, "started")) {
            existing.status = "started";
            existing.messagePhase = "started";
            saveData();
          }
          await notifyRewardRenewal(channel, existing, reward, previousEnd, saveData);
          continue;
        }
        if (existing?.status === "started") {
          alreadyKnown++;
          continue;
        }
        if (!existing) {
          if (recentRewardMessages === null) {
            recentRewardMessages = await loadRecentRewardMessages(channel, client.user?.id);
          }
          const fingerprint = rewardFingerprint(reward);
          const candidates = recentRewardMessages.get(fingerprint) || [];
          const compatibleMessages = candidates.filter(message => {
            const isScheduled = message.content.includes("NADCHODZĄC");
            const isExpired = message.content.includes("ZAKOŃCZONE");
            // Started announcements can have older campaign dates in their
            // embeds after Kick extends the campaign. Match by reward
            // fingerprint and phase marker, not by byte-for-byte post text.
            return phase === "scheduled" ? isScheduled : !isScheduled;
          });
          const priorMessage = compatibleMessages.sort((left, right) =>
            left.createdTimestamp - right.createdTimestamp
          )[0];
          if (priorMessage) {
            const previousEnd = parsePolishDate(
              priorMessage.embeds[0]?.description?.match(/^\*\*Koniec:\*\*\s*(.+)$/m)?.[1]
            ) || reward.campaignEnd;
            const recovered = {
              status: phase,
              startAt: reward.campaignStart,
              endAt: previousEnd,
              renewalBaselineEndAt: getRenewalBaseline(reward),
              reward: { ...reward, campaignEnd: previousEnd },
              messageId: priorMessage.id,
              messageIds: [priorMessage.id],
              messagePhase: phase,
              messageFormatVersion: 2
            };
            if (await refreshRewardMessage(channel, recovered, reward, phase)) {
              states[reward.key] = recovered;
              saveData();
              await notifyRewardRenewal(channel, recovered, reward, previousEnd, saveData);
              alreadyKnown++;
              continue;
            }
          }
        }
        try {
          const message = await sendReward(channel, reward, phase);
          states[reward.key] = {
            status: phase,
            startAt: reward.campaignStart,
            endAt: reward.campaignEnd,
            renewalBaselineEndAt: getRenewalBaseline(reward),
            reward,
            messageId: message?.id || null,
            messageIds: message?.id ? [message.id] : [],
            messagePhase: phase,
            messageFormatVersion: 2
          };
          recentRewardMessages?.set(rewardFingerprint(reward), {
            id: message?.id,
            content: rewardMessageContent(reward, phase),
            author: { id: client.user?.id }
          });
          saveData();
          sent++;
        } catch (err) {
          console.log(`Kick Drops: nie udało się wysłać ${reward.name} (${reward.gameName}): ${err.message}`);
        }
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
        state.messageIds = message?.id ? [message.id] : [];
        state.messagePhase = "started";
        state.messageFormatVersion = 2;
        saveData();
        sent++;
      }
    }
    console.log(
      `Kick Drops: kampanii=${summaries.length}, nagrody=${rawRewards}, badge/emotki=${eligibleRewards}, bez typu=${unclassifiedRewards.length}, zapisane=${alreadyKnown}, wygasłe=${expiredRewards}, wysłano=${sent}`
    );
    if (unclassifiedRewards.length) {
      console.log(`Kick Drops: nagrody bez typu (do weryfikacji): ${[...new Set(unclassifiedRewards)].slice(0, 10).join(" | ")}`);
    }
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
module.exports.getRewardPhase = getRewardPhase;
