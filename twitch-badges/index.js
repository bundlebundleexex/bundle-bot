const axios = require("axios");
const crypto = require("node:crypto");
const { EmbedBuilder } = require("discord.js");

const API_URL = "https://ttvdrops.lovinator.space/api/v1/twitch/campaigns/";
const API_ORIGIN = "https://ttvdrops.lovinator.space";
const CHANNEL_ID = "1545521319284838602";
const FREE_ROLE_ID = process.env.TWITCH_BADGE_FREE_ROLE_ID?.trim() || "1545400230504046602";
const PAID_ROLE_ID = process.env.TWITCH_BADGE_PAID_ROLE_ID?.trim() || "1545511812148236378";
const PAGE_SIZE = 500;
const DETAIL_CONCURRENCY = 10;
const TARGET_TYPES = new Set(["BADGE", "EMOTE"]);
const EXTRA_GAME_REWARD_TYPES = new Set([
  "SKIN",
  "IN_GAME_ITEM",
  "GAME_ITEM",
  "LOOT"
]);

function formatDate(value) {
  if (!value) return "brak danych";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "brak danych";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function validateCampaignSnapshot(summary, campaign, now = Date.now()) {
  if (!summary || !campaign || summary.twitch_id !== campaign.twitch_id) {
    return "campaign id mismatch";
  }
  if (!campaign.is_fully_imported) return "campaign details incomplete";

  const operations = new Set(campaign.operation_names || []);
  if (!operations.has("ViewerDropsDashboard") || !operations.has("DropCampaignDetails")) {
    return "missing Twitch campaign operation provenance";
  }

  const startAt = Date.parse(campaign.start_at || "");
  const endAt = Date.parse(campaign.end_at || "");
  if (![startAt, endAt].every(Number.isFinite)) {
    return "campaign dates missing or invalid";
  }
  if (startAt >= endAt) return "invalid campaign date range";

  const status = String(campaign.status).toLowerCase();
  if (!new Set(["active", "upcoming"]).has(status)) return "campaign is not active/upcoming";

  const summaryGameId = summary.game?.twitch_id;
  const detailGameId = campaign.game?.twitch_id;
  // The detailed Twitch campaign response is the source of truth when list summaries lag.
  if (summaryGameId && detailGameId && summaryGameId !== detailGameId) {
    console.log(`Twitch Drops: rozbieżna kategoria dla ${campaign.name}; używam szczegółów kampanii`);
  }
  if (summary.name !== campaign.name || summary.status !== campaign.status ||
      Date.parse(summary.start_at || "") !== startAt || Date.parse(summary.end_at || "") !== endAt) {
    console.log(`Twitch Drops: lista i szczegóły ${campaign.name} się różnią; używam szczegółów kampanii`);
  }

  return null;
}

function flattenCampaignBenefits(campaign) {
  const rewards = [];
  const allowedChannels = Array.isArray(campaign.allowed_channels)
    ? campaign.allowed_channels
    : [];

  for (const drop of campaign.drops || []) {
    const minutes = Number(drop.required_minutes_watched);
    const subs = Number(drop.required_subs);
    if (!Number.isFinite(minutes) || !Number.isFinite(subs)) continue;
    if (minutes < 0 || minutes > 900 || subs < 0 || subs > 5) continue;
    if (minutes <= 0 && subs <= 0) continue;

    const campaignStart = Date.parse(campaign.start_at);
    const campaignEnd = Date.parse(campaign.end_at);
    const dropStart = Date.parse(drop.start_at || campaign.start_at);
    const dropEnd = Date.parse(drop.end_at || campaign.end_at);
    if (
      ![campaignStart, campaignEnd, dropStart, dropEnd].every(Number.isFinite) ||
      dropStart < campaignStart ||
      dropEnd > campaignEnd ||
      dropStart >= dropEnd
    ) continue;

    for (const benefit of drop.benefits || []) {
      const type = String(benefit?.distribution_type || "OTHER").toUpperCase();
      if (!benefit?.twitch_id || !benefit?.name) continue;
      rewards.push({
        key: `${campaign.twitch_id}:${drop.twitch_id}:${benefit.twitch_id}`,
        type,
        name: benefit.name,
        imageUrl: benefit.image_url
          ? new URL(benefit.image_url, API_ORIGIN).toString()
          : null,
        minutes,
        subs,
        dropName: drop.name,
        campaignName: campaign.name,
        campaignId: campaign.twitch_id,
        campaignStart: drop.start_at || campaign.start_at,
        campaignEnd: drop.end_at || campaign.end_at,
        campaignUrl: `https://dashboard.twitch.tv/viewer-rewards/drops?id=${campaign.twitch_id}`,
        gameName: campaign.game?.display_name || campaign.game?.name || "Twitch",
        gameSlug: campaign.game?.slug || "",
        channels: allowedChannels,
        description: campaign.description || ""
      });
    }
  }

  return rewards;
}

function flattenCampaignRewards(campaign) {
  return flattenCampaignBenefits(campaign).filter(reward => TARGET_TYPES.has(reward.type));
}

function getRewardTypeLabel(type) {
  const value = String(type || "OTHER").toUpperCase();
  const labels = {
    BADGE: "badge",
    EMOTE: "emotka",
    SKIN: "skin",
    IN_GAME_ITEM: "przedmiot do gry",
    GAME: "gra",
    GAME_ITEM: "przedmiot do gry",
    LOOT: "loot"
  };
  return labels[value] || value.toLowerCase().replace(/[_-]+/g, " ");
}

function getAccessDescription(reward) {
  const location = getWhereToWatch(reward);
  if (reward.subs > 0) {
    const subs = reward.subs === 1
      ? "zakup subskrypcji"
      : `zakup ${reward.subs} subskrypcji`;
    const extraWatch = reward.minutes > 0
      ? ` oraz oglądanie przez ${reward.minutes} min`
      : "";
    return `**Dostęp:** Płatny — za ${subs}${extraWatch} ${location}`;
  }

  return `**Dostęp:** Darmowy — za oglądanie przez ${reward.minutes} min ${location}`;
}

function getWhereToWatch(reward) {
  const channels = (Array.isArray(reward.channels) ? reward.channels : [])
    .filter(channel => channel?.name);
  if (channels.length) {
    const links = channels.map(channel => {
      const label = channel.display_name || channel.name;
      return `[${label}](https://www.twitch.tv/${encodeURIComponent(channel.name)})`;
    });
    const label = channels.length === 1 ? "na kanale:" : "na kanałach:";
    return `${label} ${links.join(", ")}`;
  }

  if (reward.gameSlug) {
    const categoryUrl = `https://www.twitch.tv/directory/category/${encodeURIComponent(reward.gameSlug)}`;
    return `w kategorii: [${reward.gameName}](${categoryUrl})`;
  }

  return `w kategorii: ${reward.gameName}`;
}

function makeRewardEmbed(reward) {
  const extraDrops = (reward.relatedDrops || [])
    .filter(item => item.key !== reward.key && EXTRA_GAME_REWARD_TYPES.has(item.type));
  const related = extraDrops
    .slice(0, 5)
    .map(item => `• **${item.name}** (${getRewardTypeLabel(item.type)}) — ${Date.parse(item.campaignStart) > Date.now() ? `zaplanowane od ${formatDate(item.campaignStart)}, ` : ""}${item.subs > 0
      ? `sub${item.subs > 1 ? ` x${item.subs}` : ""}${item.minutes > 0 ? ` + ${item.minutes} min oglądania` : ""}`
      : `${item.minutes} min oglądania`}`);
  const description = [
    `**Gra/kategoria:** ${reward.gameName}`,
    getAccessDescription(reward),
    `**Start:** ${formatDate(reward.campaignStart)}`,
    `**Koniec:** ${formatDate(reward.campaignEnd)}`,
    reward.subs > 0 ? "**Sub z Prime się nie liczy.**" : null,
    related.length
      ? `\n**Dodatkowo dla tej kategorii:**\n${related.join("\n")}${extraDrops.length > 5 ? `\n…i jeszcze ${extraDrops.length - 5}` : ""}`
      : null
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setTitle(`${reward.type === "EMOTE" ? "😀" : "🏅"} ${reward.name}`)
    .setURL(reward.campaignUrl)
    .setDescription(description)
    .setFooter({ text: "Twitch Badge" })
    .setTimestamp();

  if (reward.imageUrl) embed.setThumbnail(reward.imageUrl);
  return embed;
}

async function sendReward(channel, reward, phase) {
  const isScheduled = phase === "scheduled";
  const roleId = reward.subs > 0 ? PAID_ROLE_ID : FREE_ROLE_ID;
  const scheduledHeadline = reward.type === "EMOTE"
    ? "NADCHODZĄCA EMOTKA TWITCH"
    : "NADCHODZĄCY BADGE TWITCH";
  const liveHeadline = reward.type === "EMOTE"
    ? "EMOTKA TWITCH DOSTĘPNA DO ZDOBYCIA!"
    : "BADGE TWITCH DOSTĘPNY DO ZDOBYCIA!";
  const nonce = crypto
    .createHash("sha256")
    .update(`${reward.key}:${phase}`)
    .digest("hex")
    // Discord rejects nonces longer than 25 characters.
    .slice(0, 25);

  await channel.send({
    content: isScheduled
      ? `🕒 **${scheduledHeadline}**`
      : `${reward.type === "EMOTE" ? "😀" : "🏅"} **${liveHeadline}** <@&${roleId}>`,
    embeds: [makeRewardEmbed(reward)],
    nonce,
    enforceNonce: true,
    allowedMentions: {
      parse: [],
      roles: !isScheduled ? [roleId] : []
    }
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function getCampaignSummaries() {
  const statuses = ["active", "upcoming"];
  const pages = await Promise.all(statuses.map(async status => {
    const response = await axios.get(API_URL, {
      params: { status, page: 1, page_size: PAGE_SIZE },
      timeout: 20000
    });
    return Array.isArray(response.data?.items) ? response.data.items : [];
  }));

  return [...new Map(pages.flat().map(campaign => [campaign.twitch_id, campaign])).values()];
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    const summaries = await getCampaignSummaries();
    if (!summaries.length) {
      console.log("Twitch Drops: brak aktywnych/nadchodzących kampanii — pomijam zapis");
      return;
    }

    if (!Array.isArray(savedData.twitchDropRewardIds)) savedData.twitchDropRewardIds = [];
    if (!savedData.twitchDropRewardStates || typeof savedData.twitchDropRewardStates !== "object") {
      savedData.twitchDropRewardStates = {};
    }
    if (!savedData.twitchDropCampaignVersions || typeof savedData.twitchDropCampaignVersions !== "object") {
      savedData.twitchDropCampaignVersions = {};
    }

    const rewardStates = savedData.twitchDropRewardStates;
    for (const key of savedData.twitchDropRewardIds) {
      if (!rewardStates[key]) rewardStates[key] = { status: "started" };
    }
    const oldVersions = savedData.twitchDropCampaignVersions;
    const changed = summaries.filter(campaign =>
      !campaign.is_fully_imported || oldVersions[campaign.twitch_id] !== campaign.updated_at
    );

    const details = await mapWithConcurrency(changed, DETAIL_CONCURRENCY, async summary => {
      try {
        const response = await axios.get(
          `${API_URL}${encodeURIComponent(summary.twitch_id)}/`,
          { timeout: 20000 }
        );
        return response.data;
      } catch (err) {
        console.log(`Twitch Drops: błąd kampanii ${summary.name}: ${err.response?.status || err.message}`);
        return null;
      }
    });

    const detailsById = new Map(changed.map((summary, index) => [summary.twitch_id, details[index]]));
    const getDetails = async summary => {
      if (detailsById.has(summary.twitch_id)) return detailsById.get(summary.twitch_id);
      try {
        const response = await axios.get(
          `${API_URL}${encodeURIComponent(summary.twitch_id)}/`,
          { timeout: 20000 }
        );
        detailsById.set(summary.twitch_id, response.data);
        return response.data;
      } catch (err) {
        console.log(`Twitch Drops: nie udało się pobrać ciekawostki ${summary.name}: ${err.response?.status || err.message}`);
        detailsById.set(summary.twitch_id, null);
        return null;
      }
    };

    const channel = await client.channels.fetch(CHANNEL_ID);
    let sentCount = 0;
    let rewardCount = 0;
    let alreadyAnnouncedCount = 0;

    for (let index = 0; index < changed.length; index++) {
      const campaign = details[index];
      if (!campaign) continue;
      const validationError = validateCampaignSnapshot(changed[index], campaign);
      if (validationError) {
        console.log(`Twitch Drops: pomijam ${campaign.name || changed[index].name}: ${validationError}`);
        continue;
      }

      const rewards = flattenCampaignRewards(campaign);
      rewardCount += rewards.length;
      const gameId = campaign.game?.twitch_id;
      const peerSummaries = gameId
        ? summaries.filter(item => item.twitch_id !== campaign.twitch_id && item.game?.twitch_id === gameId)
        : [];
      const peerDetails = await mapWithConcurrency(peerSummaries, DETAIL_CONCURRENCY, getDetails);
      const relatedDrops = flattenCampaignBenefits(campaign);
      for (let peerIndex = 0; peerIndex < peerSummaries.length; peerIndex++) {
        const peer = peerDetails[peerIndex];
        if (peer && !validateCampaignSnapshot(peerSummaries[peerIndex], peer)) {
          relatedDrops.push(...flattenCampaignBenefits(peer));
        }
      }
      const now = Date.now();
      for (const reward of rewards) {
        reward.relatedDrops = relatedDrops.filter(item => {
          if (item.key === reward.key) return false;
          if (!EXTRA_GAME_REWARD_TYPES.has(item.type)) return false;
          const start = Date.parse(item.campaignStart || "");
          const end = Date.parse(item.campaignEnd || "");
          return Number.isFinite(start) && Number.isFinite(end) && end > now;
        });
        const existing = rewardStates[reward.key];
        const startAt = Date.parse(reward.campaignStart || "");
        const endAt = Date.parse(reward.campaignEnd || "");
        const startsLater = Number.isFinite(startAt) && startAt > Date.now();
        const isExpired = Number.isFinite(endAt) && endAt <= Date.now();

        if (isExpired) {
          if (existing?.status === "scheduled") {
            existing.status = "expired";
            saveData();
          }
          continue;
        }

        if (startsLater) {
          if (!existing) {
            await sendReward(channel, reward, "scheduled");
            rewardStates[reward.key] = {
              status: "scheduled",
              startAt: reward.campaignStart,
              endAt: reward.campaignEnd,
              reward
            };
            saveData();
            sentCount++;
          } else if (existing.status === "scheduled") {
            existing.startAt = reward.campaignStart;
            existing.endAt = reward.campaignEnd;
            existing.reward = reward;
          }
          continue;
        }

        if (existing?.status === "started") {
          alreadyAnnouncedCount++;
          continue;
        }

        if (!existing || existing.status === "scheduled") {
          await sendReward(channel, reward, "started");
          rewardStates[reward.key] = {
            status: "started",
            startAt: reward.campaignStart,
            endAt: reward.campaignEnd,
            reward
          };
          if (!savedData.twitchDropRewardIds.includes(reward.key)) {
            savedData.twitchDropRewardIds.push(reward.key);
          }
          saveData();
          sentCount++;
        }
      }

      oldVersions[campaign.twitch_id] = changed[index].updated_at;
    }

    for (const [key, state] of Object.entries(rewardStates)) {
      if (state.status !== "scheduled" || !state.reward) continue;
      const startAt = Date.parse(state.startAt || state.reward.campaignStart || "");
      const endAt = Date.parse(state.endAt || state.reward.campaignEnd || "");
      if (Number.isFinite(endAt) && endAt <= Date.now()) {
        state.status = "expired";
        saveData();
        continue;
      }
      if (!Number.isFinite(startAt) || startAt > Date.now()) continue;

      await sendReward(channel, state.reward, "started");
      state.status = "started";
      if (!savedData.twitchDropRewardIds.includes(key)) {
        savedData.twitchDropRewardIds.push(key);
      }
      saveData();
      sentCount++;
    }

    const currentIds = new Set(summaries.map(campaign => campaign.twitch_id));
    for (const id of Object.keys(oldVersions)) {
      if (!currentIds.has(id)) delete oldVersions[id];
    }

    savedData.twitchDropRewardIds = [...new Set(savedData.twitchDropRewardIds)].slice(-4000);
    saveData();
    console.log(
      `Twitch Drops: ${summaries.length} kampanii, ${rewardCount} badge/emote nagród, wysłano ${sentCount}, pominięto już ogłoszone ${alreadyAnnouncedCount}`
    );
  } catch (err) {
    console.log("Twitch Drops error:", err.response?.status || err.message);
  }
};

module.exports.flattenCampaignRewards = flattenCampaignRewards;
module.exports.flattenCampaignBenefits = flattenCampaignBenefits;
module.exports.getAccessDescription = getAccessDescription;
module.exports.getWhereToWatch = getWhereToWatch;
module.exports.validateCampaignSnapshot = validateCampaignSnapshot;
module.exports.makeRewardEmbed = makeRewardEmbed;
module.exports.mapWithConcurrency = mapWithConcurrency;
module.exports.sendReward = sendReward;
