const axios = require("axios");
const crypto = require("node:crypto");
const { EmbedBuilder } = require("discord.js");

const API_URL = "https://ttvdrops.lovinator.space/api/v1/twitch/campaigns/";
const API_ORIGIN = "https://ttvdrops.lovinator.space";
const REWARD_CAMPAIGNS_URL = "https://drops.sunkwi.com/api/twitch/rewards";
const GLOBAL_BADGES_URL = "https://drops.sunkwi.com/api/twitch/badges";
// Sunkwi's anonymous API limit is one request per route per five minutes.
const REWARD_SOURCE_CACHE_MS = 5 * 60 * 1000 + 15 * 1000;
const CHANNEL_ID = "1545521319284838602";
const FREE_ROLE_ID = process.env.TWITCH_BADGE_FREE_ROLE_ID?.trim() || "1545400230504046602";
const PAID_ROLE_ID = process.env.TWITCH_BADGE_PAID_ROLE_ID?.trim() || "1545511812148236378";
const REWARD_MESSAGE_FORMAT_VERSION = 9;
const PAGE_SIZE = 500;
const DETAIL_CONCURRENCY = 10;
const GAME_ITEM_TYPES = new Set(["DIRECT_ENTITLEMENT", "IN_GAME_ITEM", "GAME_ITEM", "SKIN", "LOOT"]);
const TWITCH_REWARD_SOURCE_CACHE_VERSION = 5;
const EXTRA_GAME_REWARD_TYPES = new Set([
  "SKIN",
  "IN_GAME_ITEM",
  "GAME_ITEM",
  "LOOT"
]);
const POKEMON_EVOLUTION_PARENTS = new Map([
  ["pikachu", "Pichu"],
  ["ivysaur", "Bulbasaur"], ["venusaur", "Ivysaur"],
  ["wartortle", "Squirtle"], ["blastoise", "Wartortle"],
  ["charmeleon", "Charmander"], ["charizard", "Charmeleon"],
  ["haunter", "Gastly"], ["gengar", "Haunter"]
]);
const POKEMON_EVOLUTION_ROOTS = new Map([
  ["pikachu", "Pichu"],
  ["ivysaur", "Bulbasaur"], ["venusaur", "Bulbasaur"],
  ["wartortle", "Squirtle"], ["blastoise", "Squirtle"],
  ["charmeleon", "Charmander"], ["charizard", "Charmander"],
  ["haunter", "Gastly"], ["gengar", "Gastly"]
]);
const POKEMON_BASE_FALLBACKS = new Map([
  ["pichu", { paid: false, endAt: "2026-11-02T08:59:59+01:00" }],
  ["bulbasaur", { paid: true, endAt: "2026-10-02T08:59:59+02:00" }],
  ["charmander", { paid: true, endAt: "2026-10-02T08:59:59+02:00" }],
  ["squirtle", { paid: true, endAt: "2026-10-02T08:59:59+02:00" }],
  ["gastly", { paid: true, endAt: "2026-10-25T08:59:59+02:00", claimUntil: "23 lis 2026", progressRequired: true }]
]);
const POKEMON_EVOLUTION_CATEGORIES = [
  "Pokémon FireRed/LeafGreen", "Pokémon Pokopia", "Pokémon UNITE", "Pokémon Champions",
  "Pokémon GO", "Pokémon Legends: Z-A", "Pokémon Scarlet/Violet",
  "Pokémon Trading Card Game Pocket", "Pokémon Trading Card Game", "Pokémon Trading Card Game Live",
  "Just Chatting", "DJs", "Art", "Special Events", "Sports", "Music",
  "Talk Shows & Podcasts", "Animals, Aquariums, and Zoos", "Co-working & Studying", "Makers & Crafting"
];

function slugifyGameCategory(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

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

  if (campaign.source === "sunkwi-reward-campaigns") {
    const startAt = Date.parse(campaign.start_at || "");
    const endAt = Date.parse(campaign.end_at || "");
    if (![startAt, endAt].every(Number.isFinite)) return "reward campaign dates missing or invalid";
    if (startAt >= endAt) return "invalid reward campaign date range";
    if (!new Set(["active", "upcoming"]).has(String(campaign.status).toLowerCase())) {
      return "reward campaign is not active/upcoming";
    }
    return null;
  }
  if (campaign.source === "sunkwi-global-badges") {
    const startAt = Date.parse(campaign.start_at || "");
    const endAt = Date.parse(campaign.end_at || "");
    if (![startAt, endAt].every(Number.isFinite)) return "badge campaign dates missing or invalid";
    if (startAt >= endAt) return "invalid badge campaign date range";
    if (!new Set(["active", "upcoming"]).has(String(campaign.status).toLowerCase())) {
      return "badge campaign is not active/upcoming";
    }
    return null;
  }

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
  if (!campaign || typeof campaign !== "object") return rewards;

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
      const allowedChannels = [
        benefit.allowed_channels,
        drop.allowed_channels,
        campaign.allowed_channels
      ].find(Array.isArray) || [];
      rewards.push({
        key: `${campaign.twitch_id}:${drop.twitch_id}:${benefit.twitch_id}`,
        type,
        name: benefit.name,
        imageUrl: benefit.image_url
          ? new URL(benefit.image_url, API_ORIGIN).toString()
          : null,
        minutes,
        subs,
        specificDay: benefit.specific_day || drop.specificDay || null,
        randomSubCollectionSize: benefit.random_sub_collection_size || drop.randomSubCollectionSize || null,
        evolutionFrom: benefit.evolution_from || null,
        evolutionInfo: benefit.evolution_info || null,
        collectionInfo: benefit.collection_info || drop.collectionInfo || null,
        dropName: drop.name,
        campaignName: campaign.name,
        campaignId: campaign.twitch_id,
        campaignStart: drop.start_at || campaign.start_at,
        campaignEnd: drop.end_at || campaign.end_at,
        campaignUrl: `https://dashboard.twitch.tv/viewer-rewards/drops?id=${campaign.twitch_id}`,
        gameName: drop.game?.display_name || drop.game?.name || campaign.game?.display_name || campaign.game?.name || "Twitch",
        gameSlug: slugifyGameCategory(
          drop.game?.slug || drop.game?.category_slug || campaign.game?.slug || campaign.game?.category_slug ||
          campaign.game?.name || campaign.game?.display_name
        ),
        channels: allowedChannels,
        isGlobalTwitchEmote: type === "EMOTE" && benefit.is_global_twitch_emote !== false &&
          !benefit.channel_id && !benefit.channelId && !benefit.channel,
        repeat: drop.repeat || benefit.repeat || null,
        description: campaign.description || ""
      });
    }
  }

  return rewards;
}

function imageUrlFromRewardImage(image) {
  if (typeof image === "string") return image;
  return image?.image1xURL || image?.url || null;
}

function normalizeRewardCampaign(campaign) {
  if (!campaign?.id || !campaign?.name) return null;
  const startsAt = campaign.startsAt || campaign.starts_at;
  const endsAt = campaign.endsAt || campaign.ends_at;
  const status = String(campaign.status || "").toLowerCase();
  if (!startsAt || !endsAt || !["active", "upcoming"].includes(status)) return null;

  const groupRows = Array.isArray(campaign.rewardGroups) && campaign.rewardGroups.length
    ? campaign.rewardGroups
    : [{ id: `${campaign.id}:all`, unlockRequirements: campaign.unlockRequirements, rewards: campaign.rewards }];
  const campaignGame = campaign.game || groupRows.flatMap(group => group.categories || [])[0] || null;
  const seenRewardIds = new Set();
  const drops = [];
  for (let groupIndex = 0; groupIndex < groupRows.length; groupIndex++) {
    const group = groupRows[groupIndex];
    const requirements = group.unlockRequirements || campaign.unlockRequirements || {};
    const minutes = Number(requirements.minuteWatchedGoal ?? requirements.requiredMinutesWatched ?? 0);
    const subs = Number(requirements.subsGoal ?? requirements.requiredSubs ?? 0);
    if (!Number.isFinite(minutes) || !Number.isFinite(subs) || minutes < 0 || subs < 0 ||
        minutes > 100000 || subs > 100) continue;

    const categories = Array.isArray(group.categories) ? group.categories : [];
    const game = categories[0] || campaign.game || null;
    const groupRewards = Array.isArray(group.rewards) ? group.rewards : [];
    const benefits = [];
    for (const reward of groupRewards) {
      const rewardName = String(reward?.name || "").trim();
      if (!reward?.id || !rewardName) continue;
      if (/\bchest\b/i.test(rewardName)) continue;
      const rewardId = String(reward.id);
      if (seenRewardIds.has(rewardId)) continue;
      const sourceType = String(reward.distributionType || reward.distribution_type || reward.type || "").toUpperCase();
      const isGameItem = GAME_ITEM_TYPES.has(sourceType);
      const hasChannelScope = Boolean(reward.channel_id || reward.channelId || reward.channel);
      const type = !isGameItem && !hasChannelScope &&
        (/EMOTE/.test(sourceType) || /emote/i.test(rewardName))
        ? "EMOTE"
        : null;
      // RewardCampaigns also include game rewards. This source supplements
      // global badges with explicitly identified emotes; badges come from the
      // dedicated Twitch global-badge requirements feed below.
      if (!type) continue;
      seenRewardIds.add(rewardId);
      benefits.push({
        twitch_id: rewardId,
        name: rewardName,
        distribution_type: type,
        is_global_twitch_emote: type === "EMOTE" && subs === 0 &&
          !reward.channel_id && !reward.channelId && !reward.channel,
        image_url: imageUrlFromRewardImage(reward.thumbnailImage) ||
          imageUrlFromRewardImage(reward.bannerImage) || reward.image_url || null
      });
    }
    if (!benefits.length) continue;
    drops.push({
      twitch_id: String(group.id || `${campaign.id}:${groupIndex}`),
      name: campaign.name,
      required_minutes_watched: minutes,
      required_subs: subs,
      start_at: startsAt,
      end_at: endsAt,
      benefits,
      allowed_channels: [],
      categories,
      game: game ? {
        twitch_id: String(game.id || game.twitch_id || ""),
        display_name: game.displayName || game.display_name || game.name || "Twitch",
        name: game.displayName || game.display_name || game.name || "Twitch",
        slug: game.slug || game.category_slug || ""
      } : null
    });
  }
  if (!drops.length) return null;

  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
    id: campaign.id, startsAt, endsAt, status, game: campaignGame, drops
  })).digest("hex");
  const normalized = {
    twitch_id: String(campaign.id),
    name: campaign.name,
    description: campaign.summary || campaign.instructions || "",
    status,
    start_at: startsAt,
    end_at: endsAt,
    updated_at: fingerprint,
    is_fully_imported: true,
    source: "sunkwi-reward-campaigns",
    game: campaignGame ? {
      twitch_id: String(campaignGame.id || campaignGame.twitch_id || ""),
      display_name: campaignGame.displayName || campaignGame.display_name || campaignGame.name || "Twitch",
      name: campaignGame.displayName || campaignGame.display_name || campaignGame.name || "Twitch",
      slug: campaignGame.slug || campaignGame.category_slug || ""
    } : null,
    drops
  };
  return normalized;
}

function normalizeGlobalBadgeCampaigns(badges, now = Date.now()) {
  const groups = new Map();
  const badgeByTitle = new Map((badges || []).map(badge => [
    String(badge?.title || badge?.name || "").trim().toLowerCase(), badge
  ]).filter(([title]) => title));
  for (const badge of badges || []) {
    const requirement = badge?.requirement;
    const campaignId = String(requirement?.campaignId || requirement?.campaign_id || "");
    if (!campaignId || String(requirement?.source || "").toUpperCase() !== "DROPS") continue;
    const startAt = requirement.startAt || requirement.start_at;
    const endAt = requirement.endAt || requirement.end_at;
    const startMs = Date.parse(startAt || "");
    const endMs = Date.parse(endAt || "");
    if (![startMs, endMs].every(Number.isFinite) || endMs <= now || startMs >= endMs) continue;
    const minutes = Number(requirement.requiredMinutes ?? requirement.required_minutes ?? 0);
    let subs = Number(requirement.requiredSubs ?? requirement.required_subs ?? 0);
    const title = String(badge.title || badge.name || "").trim();
    const isCollectionCompletion = Boolean(requirement.collection?.completeAll) ||
      /golden iguana/i.test(title);
    const collectionInfo = isCollectionCompletion ? {
      requiresFree: true,
      requiresPaid: true,
      freeBadgeCount: 6,
      paidBadgeCount: 6,
      paidEmoteCount: 6,
      paidSubscriptionCount: 3,
      watchMinutes: 60,
      watchDays: Number(requirement.repeat?.times) || 6
    } : null;
    const requiredMinutes = isCollectionCompletion ? (minutes || 60) : minutes;
    if (isCollectionCompletion && subs <= 0) subs = 3;
    if (!Number.isFinite(requiredMinutes) || !Number.isFinite(subs) ||
        requiredMinutes < 0 || requiredMinutes > 100000 || subs < 0 || subs > 100 ||
        (requiredMinutes <= 0 && subs <= 0)) continue;

    const badgeDescription = String(badge.description || "");
    const setId = String(badge.setId || badge.set_id || "");
    const versionId = String(badge.versionId || badge.version_id || badge.twitch_id || "");
    if (!title || !setId || !versionId) continue;
    const categories = Array.isArray(requirement.categories) ? requirement.categories : [];
    const category = categories[0] || null;
    const gameName = category?.name || category?.displayName || requirement.gameName || "Twitch";
    const game = category || (gameName !== "Twitch" ? { name: gameName } : null);
    const campaignName = requirement.campaignName || requirement.campaign_name || "Twitch Drops";
    const dayMatch = badgeDescription.match(/watching\s+(\d+)\s+day\b/i);
    const dayByName = new Map([
      ["purple chain", 1], ["bronze chain", 2], ["silver chain", 3],
      ["gold chain", 4], ["diamond chain", 5], ["miami chain", 6]
    ]).get(title.toLowerCase());
    const dayNumber = dayMatch ? Number(dayMatch[1]) : dayByName || null;
    const isEvolution = /evolv(?:e|ed|ing)/i.test(badgeDescription);
    const evolutionFrom = isEvolution ? POKEMON_EVOLUTION_PARENTS.get(title.toLowerCase()) || null : null;
    const evolutionRoot = isEvolution ? POKEMON_EVOLUTION_ROOTS.get(title.toLowerCase()) || null : null;
    const rootBadge = evolutionRoot ? badgeByTitle.get(evolutionRoot.toLowerCase()) : null;
    const rootRequirement = rootBadge?.requirement || {};
    const fallbackRoot = evolutionRoot ? POKEMON_BASE_FALLBACKS.get(evolutionRoot.toLowerCase()) : null;
    const rootEndAt = rootRequirement.endAt || rootRequirement.end_at || fallbackRoot?.endAt || null;
    const rootSubs = Number(rootRequirement.requiredSubs ?? rootRequirement.required_subs ?? (fallbackRoot?.paid ? 1 : 0));
    const evolutionInfo = isEvolution ? {
      parent: evolutionFrom,
      rootBadge: evolutionRoot,
      basePaid: rootSubs > 0 || Boolean(fallbackRoot?.paid),
      baseEndAt: rootEndAt,
      baseEnded: rootEndAt ? Date.parse(rootEndAt) <= now : null,
      claimUntil: fallbackRoot?.claimUntil || null,
      progressRequired: Boolean(fallbackRoot?.progressRequired),
      categories: POKEMON_EVOLUTION_CATEGORIES
    } : null;
    const collectionSize = Number(requirement.collection?.chestSize || 0);
    const isGtaSixSubCollection = !isCollectionCompletion && gameName.toLowerCase() === "grand theft auto vi" && subs === 3;
    const isRandomSubCollection = (subs > 1 && collectionSize === subs && collectionSize > 1) ||
      isGtaSixSubCollection;
    const randomSubCount = isGtaSixSubCollection ? 3 : collectionSize;
    const key = campaignId;
    if (!groups.has(key)) {
      groups.set(key, {
        twitch_id: campaignId,
        name: campaignName,
        description: "",
        status: startMs > now ? "upcoming" : "active",
        start_at: startAt,
        end_at: endAt,
        is_fully_imported: true,
        source: "sunkwi-global-badges",
        game: game ? {
          twitch_id: String(game.id || game.twitch_id || ""),
          display_name: game.displayName || game.display_name || game.name || gameName,
          name: game.displayName || game.display_name || game.name || gameName,
          slug: game.slug || game.category_slug || slugifyGameCategory(gameName)
        } : null,
        drops: []
      });
    }

    const campaign = groups.get(key);
    campaign.start_at = new Date(Math.min(Date.parse(campaign.start_at), startMs)).toISOString();
    campaign.end_at = new Date(Math.max(Date.parse(campaign.end_at), endMs)).toISOString();
    const listedChannels = Array.isArray(requirement.channels) ? requirement.channels : [];
    const channelCount = Number(requirement.channelCount ?? requirement.channel_count ?? listedChannels.length);
    const channels = Number.isFinite(channelCount) && channelCount > listedChannels.length
      ? []
      : listedChannels.map(channel => typeof channel === "string"
        ? { name: channel, display_name: channel }
        : channel);
    const rewardId = `global-${crypto.createHash("sha256").update(`${setId}:${versionId}`).digest("hex").slice(0, 20)}`;
    campaign.drops.push({
      twitch_id: `global-badge:${rewardId}`,
      name: campaignName,
      required_minutes_watched: requiredMinutes,
      required_subs: isRandomSubCollection ? 1 : subs,
      repeat: requirement.repeat || null,
      specificDay: dayNumber,
      randomSubCollectionSize: isRandomSubCollection ? randomSubCount : null,
      collectionInfo,
      start_at: startAt,
      end_at: endAt,
      benefits: [{
        twitch_id: rewardId,
        name: title,
        distribution_type: "BADGE",
        description: badgeDescription,
        specific_day: dayNumber,
        random_sub_collection_size: isRandomSubCollection ? randomSubCount : null,
        evolution_from: evolutionFrom,
        evolution_info: evolutionInfo,
        collection_info: collectionInfo,
        image_url: badge.imageUrl4x || badge.imageUrl2x || badge.imageUrl1x || null
      }],
      allowed_channels: channels,
      game: game ? {
        twitch_id: String(game.id || game.twitch_id || ""),
        display_name: game.displayName || game.display_name || game.name || gameName,
        name: game.displayName || game.display_name || game.name || gameName,
        slug: game.slug || game.category_slug || slugifyGameCategory(gameName)
      } : null
    });
  }

  for (const campaign of groups.values()) {
    campaign.status = Date.parse(campaign.start_at) > now ? "upcoming" : "active";
    campaign.updated_at = crypto.createHash("sha256").update(JSON.stringify(campaign.drops)).digest("hex");
  }
  return [...groups.values()];
}

async function getRewardCampaignSnapshots(savedData, saveData) {
  const previous = savedData.twitchRewardCampaignCache;
  if (Date.parse(previous?.retryAt || "") > Date.now()) {
    return {
      campaigns: Array.isArray(previous?.campaigns) ? previous.campaigns : [],
      badgeCampaigns: Array.isArray(previous?.badgeCampaigns) ? previous.badgeCampaigns : []
    };
  }
  const cacheIsFresh = previous?.version === TWITCH_REWARD_SOURCE_CACHE_VERSION &&
    Date.now() - Date.parse(previous.fetchedAt || "") < REWARD_SOURCE_CACHE_MS;
  if (cacheIsFresh) {
    return { campaigns: previous.campaigns || [], badgeCampaigns: previous.badgeCampaigns || [] };
  }

  const headers = process.env.TWITCH_DROPS_API_KEY
    ? { "X-API-Key": process.env.TWITCH_DROPS_API_KEY.trim() }
    : undefined;
  try {
    const [campaignResponse, badgeResponse] = await Promise.all([
      axios.get(REWARD_CAMPAIGNS_URL, { timeout: 20000, headers }),
      axios.get(GLOBAL_BADGES_URL, { timeout: 20000, headers })
    ]);
    const badgeRows = Array.isArray(badgeResponse.data?.badges) ? badgeResponse.data.badges : [];
    const badgeCampaigns = normalizeGlobalBadgeCampaigns(badgeRows);
    const campaignRows = Array.isArray(campaignResponse.data?.campaigns)
      ? campaignResponse.data.campaigns
      : [];
    const campaigns = campaignRows
      .map(item => normalizeRewardCampaign(item))
      .filter(Boolean);
    savedData.twitchRewardCampaignCache = {
      version: TWITCH_REWARD_SOURCE_CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      refreshedAt: campaignResponse.data?.refreshedAt || null,
      campaigns,
      badgeCampaigns
    };
    saveData();
    return { campaigns, badgeCampaigns };
  } catch (err) {
    console.log(`Twitch reward campaigns: źródło nagród chwilowo niedostępne (${err.response?.status || err.code || err.message})`);
    savedData.twitchRewardCampaignCache = {
      ...(previous || {}),
      retryAt: new Date(Date.now() + REWARD_SOURCE_CACHE_MS).toISOString()
    };
    saveData();
    return {
      campaigns: Array.isArray(previous?.campaigns) ? previous.campaigns : [],
      badgeCampaigns: Array.isArray(previous?.badgeCampaigns) ? previous.badgeCampaigns : []
    };
  }
}

function flattenCampaignRewards(campaign) {
  return flattenCampaignBenefits(campaign).filter(reward =>
    (reward.type === "BADGE" && !/\bchest\b/i.test(reward.name)) ||
    (reward.type === "EMOTE" && reward.subs === 0 && reward.isGlobalTwitchEmote)
  );
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
  if (reward.evolutionFrom && reward.subs === 0) {
    return getPokemonEvolutionAccess(reward);
  }
  if (reward.subs > 0) {
    const subs = reward.subs === 1
      ? "zakup subskrypcji"
      : `zakup ${reward.subs} subskrypcji`;
    const extraWatch = reward.minutes > 0
      ? ` oraz oglądanie przez ${reward.minutes} min`
      : "";
    return `**Dostęp:** Płatny: za ${subs}${extraWatch} ${location}`;
  }

  return `**Dostęp:** Darmowy: za oglądanie przez ${reward.minutes} min ${location}`;
}

function getWhereToWatch(reward) {
  const categoryUrl = getTwitchCategoryDropsUrl(reward);
  const channels = (Array.isArray(reward.channels) ? reward.channels : [])
    .filter(channel => channel?.name);
  if (channels.length) {
    const links = getAllowedChannelLinks(reward);
    const label = channels.length === 1 ? "na kanale:" : "na kanałach:";
    const categoryFilter = categoryUrl
      ? ` · [kanały z włączonymi dropami](${categoryUrl})`
      : "";
    return `${label} ${links.join(", ")}${categoryFilter}`;
  }

  if (categoryUrl) {
    return `w kategorii: [${reward.gameName}](${categoryUrl})`;
  }

  return `w kategorii: ${reward.gameName}`;
}

function getTwitchCategoryDropsUrl(reward) {
  const slug = reward.gameSlug || slugifyGameCategory(reward.gameName);
  return slug
    ? `https://www.twitch.tv/directory/category/${encodeURIComponent(slug)}?filter=drops`
    : null;
}

function getAllowedChannelNames(reward) {
  const seen = new Set();
  return (Array.isArray(reward.channels) ? reward.channels : [])
    .filter(channel => channel?.name)
    .filter(channel => {
      const key = String(channel.name).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(channel => String(channel.display_name || channel.name).replace(/[\r\n,]/g, " "));
}

function getPokemonEvolutionAccess(reward) {
  const info = reward.evolutionInfo || {};
  const rootName = info.rootBadge || reward.evolutionFrom;
  const baseKind = info.basePaid ? "Płatny" : "Darmowy";
  let baseStatus = "";
  if (info.baseEnded && info.progressRequired && info.claimUntil) {
    baseStatus = ` Kampania subskrypcyjna zakończona; nagrodę można jeszcze odblokować do ${info.claimUntil}, jeśli rozpoczęto wymagany postęp w czasie kampanii.`;
  } else if (info.baseEnded && info.baseEndAt) {
    baseStatus = ` Kampania bazowego badge’a zakończona ${formatDate(info.baseEndAt)}; nowi odbiorcy nie mogą już rozpocząć zdobywania.`;
  } else if (info.baseEndAt) {
    baseStatus = ` Dostępny do ${formatDate(info.baseEndAt)}.`;
  }
  const base = `**Badge bazowy:** ${baseKind}: ${rootName}${info.basePaid ? " (wymagał nowej subskrypcji; Prime się nie liczy)." : "."}${baseStatus}`;
  const repeat = reward.repeat;
  const days = Number(repeat?.times) > 1 ? ` dziennie przez ${repeat.times} dni` : "";
  const evolution = `**Ewolucja:** Darmowa: załóż badge ${reward.evolutionFrom} i oglądaj przez ${reward.minutes} min${days} w kwalifikującej się kategorii poniżej.`;
  const categories = (info.categories || POKEMON_EVOLUTION_CATEGORIES).map(name =>
    `[${name}](https://www.twitch.tv/directory/category/${encodeURIComponent(slugifyGameCategory(name))}?filter=drops)`
  );
  return [base, evolution, `**Kategorie do ewolucji:** ${categories.join(", ")}`].join("\n");
}

function getAccessLine(reward) {
  const categoryUrl = getTwitchCategoryDropsUrl(reward);
  const channelCount = getAllowedChannelNames(reward).length;
  const location = channelCount
    ? `${channelCount === 1 ? "na kanale biorącym udział" : "na kanałach biorących udział"} (lista poniżej)`
    : categoryUrl
      ? `w kategorii: [${reward.gameName}](${categoryUrl})`
      : `w kategorii: ${reward.gameName}`;
  if (reward.collectionInfo) {
    const info = reward.collectionInfo;
    const category = categoryUrl ? `[${reward.gameName}](${categoryUrl})` : reward.gameName;
    return [
      `**Część darmowa:** oglądaj ${info.watchMinutes} min dziennie przez ${info.watchDays} różnych dni, aby zdobyć ${info.freeBadgeCount} badge’y Bling.`,
      `**Część płatna:** ${info.paidSubscriptionCount} nowe subskrypcje w kategorii ${category} odblokowują ${info.paidBadgeCount} badge’y i ${info.paidEmoteCount} emotek Heist. Suby Prime się nie liczą.`,
      "**Golden Iguana:** odblokuje się po zdobyciu wszystkich badge’y i emotek z kolekcji GTAVI Launch Celebration."
    ].join("\n");
  }
  if (reward.subs > 0) {
    if (reward.randomSubCollectionSize > 1) {
      const wholeCollection = reward.randomSubCollectionSize === 3
        ? "3 nowe subskrypcje odblokowują cały komplet"
        : `${reward.randomSubCollectionSize} nowych subskrypcji odblokowuje cały komplet`;
      return `**Dostęp:** Płatny: 1 nowa subskrypcja ${location} daje losową parę badge + emotka; ${wholeCollection}.`;
    }
    const subs = reward.subs === 1 ? "zakup subskrypcji" : `zakup ${reward.subs} subskrypcji`;
    const extraWatch = reward.minutes > 0 ? ` oraz oglądanie przez ${reward.minutes} min` : "";
    return `**Dostęp:** Płatny: za ${subs}${extraWatch} ${location}`;
  }
  const repeat = reward.repeat;
  if (reward.evolutionFrom) {
    return getPokemonEvolutionAccess(reward);
  }
  if (reward.specificDay > 0) {
    return `**Dostęp:** Darmowy: za oglądanie przez ${reward.minutes} min w ${reward.specificDay}. dniu kampanii ${location}`;
  }
  const viewing = repeat && Number(repeat.times) > 1
    ? Number(repeat.everyHours) === 24
      ? `oglądanie przez ${reward.minutes} min dziennie przez ${repeat.times} dni`
      : `oglądanie przez ${reward.minutes} min (${repeat.times} razy${repeat.everyHours ? ` co ${repeat.everyHours} godz.` : ""})`
    : `oglądanie przez ${reward.minutes} min`;
  return `**Dostęp:** Darmowy: za ${viewing} ${location}`;
}

function getAllowedChannelLinks(reward) {
  const seen = new Set();
  return (Array.isArray(reward.channels) ? reward.channels : [])
    .filter(channel => channel?.name)
    .filter(channel => {
      const key = String(channel.name).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(channel => {
      const label = String(channel.display_name || channel.name).replace(/[\[\]]/g, "");
      return `[${label}](https://twitch.tv/${encodeURIComponent(channel.name)})`;
    });
}

function getEmbedTextLength(embed) {
  const data = embed.toJSON();
  return (data.title || "").length + (data.description || "").length +
    (data.footer?.text || "").length + (data.author?.name || "").length +
    (data.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function makeRewardEmbed(reward) {
  const embed = new EmbedBuilder()
    .setColor(0x9146ff)
    .setTitle(`${reward.type === "EMOTE" ? "😀" : "🎖️"} ${reward.name}`)
    .setURL(reward.campaignUrl)
    .setFooter({ text: "Twitch Badge" })
    .setTimestamp();

  if (reward.imageUrl) embed.setThumbnail(reward.imageUrl);
  const channelLinks = getAllowedChannelLinks(reward);
  const categoryUrl = getTwitchCategoryDropsUrl(reward);
  const categoryLabel = channelLinks.length
    ? reward.gameName
    : categoryUrl
      ? `[${reward.gameName}](${categoryUrl})`
      : reward.gameName;
  const details = [
    `**Kategoria:** ${categoryLabel}`,
    getAccessLine(reward),
    `**Start:** ${formatDate(reward.campaignStart)}`,
    `**Koniec:** ${formatDate(reward.campaignEnd)}`,
    reward.subs > 0 && !reward.collectionInfo ? "**Sub z Prime się nie liczy.**" : null
  ].filter(Boolean);

  const extraDrops = (reward.relatedDrops || [])
    .filter(item => item.key !== reward.key && EXTRA_GAME_REWARD_TYPES.has(item.type));
  const related = extraDrops.slice(0, 5).map(item => {
    const timing = Date.parse(item.campaignStart) > Date.now()
      ? `zaplanowane od ${formatDate(item.campaignStart)}, `
      : "";
    const requirement = item.subs > 0
      ? `sub${item.subs > 1 ? ` x${item.subs}` : ""}${item.minutes > 0 ? ` + ${item.minutes} min oglądania` : ""}`
      : `${item.minutes} min oglądania`;
    return `• **${item.name}** (${getRewardTypeLabel(item.type)}): ${timing}${requirement}`;
  });
  if (related.length) {
    details.push(`**Dodatkowo dla tej kategorii:**\n${related.join("\n")}${extraDrops.length > 5 ? `\n…i jeszcze ${extraDrops.length - 5}` : ""}`);
  }

  if (channelLinks.length > 0 && channelLinks.length <= 9) {
    // A short campaign-specific allowlist is more useful than a generic
    // category directory and avoids implying that unrelated drops qualify.
    details.push(`**Kanały biorące udział:** ${channelLinks.join(", ")}`);
  } else if (channelLinks.length > 9) {
    const header = "**Kanały biorące udział:** ";
    const directoryLink = categoryUrl
      ? `[Zobacz transmisje z aktywnymi dropami w tej kategorii](${categoryUrl})`
      : null;
    const baseDescription = details.join("\n");
    const visibleLinks = [];

    for (const link of channelLinks) {
      const candidateLinks = [...visibleLinks, link];
      const remaining = channelLinks.length - candidateLinks.length;
      const suffix = [
        remaining > 0 ? `… i jeszcze ${remaining} kanałów.` : null,
        directoryLink
      ].filter(Boolean).join("\n");
      const candidateDescription = [
        baseDescription,
        `${header}${candidateLinks.join(", ")}`,
        suffix
      ].filter(Boolean).join("\n");

      if (candidateDescription.length > 4096) break;
      visibleLinks.push(link);
    }

    const remaining = channelLinks.length - visibleLinks.length;
    details.push(`${header}${visibleLinks.join(", ")}`);
    if (remaining > 0) details.push(`… i jeszcze ${remaining} kanałów.`);
    if (directoryLink) details.push(directoryLink);
  }
  embed.setDescription(details.join("\n"));
  return embed;
}

function makeRewardContent(reward, phase) {
  const isScheduled = phase === "scheduled";
  const roleIds = getRewardRoleIds(reward);
  const scheduledHeadline = reward.type === "EMOTE"
    ? "NADCHODZĄCA EMOTKA TWITCH"
    : "NADCHODZĄCY BADGE TWITCH";
  const liveHeadline = reward.type === "EMOTE"
    ? "EMOTKA TWITCH DOSTĘPNA DO ZDOBYCIA!"
    : "BADGE TWITCH DOSTĘPNY DO ZDOBYCIA!";
  const headline = isScheduled
    ? `🕒 **${scheduledHeadline}**`
    : `${reward.type === "EMOTE" ? "😀" : "🎖️"} **${liveHeadline}** ${roleIds.map(id => `<@&${id}>`).join(" ")}`;
  const content = headline;

  const embed = makeRewardEmbed(reward);
  if (content.length > 2000 || getEmbedTextLength(embed) > 6000) {
    throw new Error(`wiadomość kampanii ${reward.name} przekracza limity pojedynczej wiadomości Discorda`);
  }
  return { content, embed };
}

function getRewardRoleIds(reward) {
  const roleIds = [];
  if (reward.collectionInfo?.requiresPaid) roleIds.push(PAID_ROLE_ID);
  if (reward.subs > 0 || reward.evolutionInfo?.basePaid) roleIds.push(PAID_ROLE_ID);
  if (reward.collectionInfo?.requiresFree) roleIds.push(FREE_ROLE_ID);
  if (reward.subs === 0 || reward.evolutionInfo) roleIds.push(FREE_ROLE_ID);
  return [...new Set(roleIds)];
}

async function sendReward(channel, reward, phase) {
  const isScheduled = phase === "scheduled";
  const roleIds = getRewardRoleIds(reward);
  const nonce = crypto
    .createHash("sha256")
    .update(`${reward.key}:${phase}`)
    .digest("hex")
    .slice(0, 25);
  const { content, embed } = makeRewardContent(reward, phase);
  if (getEmbedTextLength(embed) > 6000) {
    throw new Error(`lista kanałów kampanii ${reward.name} przekracza limit pojedynczej wiadomości Discorda`);
  }
  return channel.send({
    content,
    embeds: [embed],
    nonce,
    enforceNonce: true,
    allowedMentions: {
      parse: [],
      roles: !isScheduled ? roleIds : []
    }
  });
}

async function refreshRewardMessage(channel, state, reward) {
  if (!state?.messageId || !channel?.messages?.fetch) return false;
  try {
    const message = await channel.messages.fetch(state.messageId);
    const { content, embed } = makeRewardContent(reward, state.status);
    await message.edit({ content, embeds: [embed], allowedMentions: { parse: [] } });
    for (const id of new Set(state.previewMessageIds || [])) {
      try {
        const preview = await channel.messages.fetch(id);
        await preview.edit({ content, embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err) {
        if (Number(err.code) !== 10008 && !/unknown message/i.test(err.message || "")) {
          console.log(`Twitch Drops: nie udało się odświeżyć podglądu ${id}: ${err.message}`);
        }
      }
    }
    for (const id of new Set(state.messageIds || [])) {
      if (!id || id === state.messageId) continue;
      try {
        const continuation = await channel.messages.fetch(id);
        await continuation.delete();
      } catch (err) {
        if (err.code !== 10008) console.log(`Twitch Drops: nie udało się usunąć starej kontynuacji ${id}: ${err.message}`);
      }
    }
    state.reward = reward;
    state.messageIds = [state.messageId];
    state.messageFormatVersion = REWARD_MESSAGE_FORMAT_VERSION;
    return true;
  } catch (err) {
    if (Number(err.code) === 10008 || /unknown message/i.test(err.message || "")) {
      state.messageId = null;
      state.messageIds = [];
      state.messageMissing = true;
      state.messageFormatVersion = REWARD_MESSAGE_FORMAT_VERSION;
      return true;
    }
    console.log(`Twitch Drops: nie udało się skrócić wiadomości ${reward.name}: ${err.message}`);
    return false;
  }
}

async function editExpiredReward(channel, state, platform = "TWITCH") {
  const messageIds = [...new Set([...(state?.messageIds || []), ...(state?.previewMessageIds || []), state?.messageId].filter(Boolean))];
  if (!messageIds.length || !channel?.messages?.fetch) return false;
  try {
    const messages = await Promise.all(messageIds.map(id => channel.messages.fetch(id)));
    const label = state.reward?.type === "EMOTE" ? "EMOTKA" : "BADGE";
    await Promise.all(messages.map((message, index) => message.edit({
      content: index === 0 ? `🏁 **${label} ${platform} - ZAKOŃCZONE**` : "🏁 **Kampania zakończona**",
      allowedMentions: { parse: [] }
    })));
    return true;
  } catch (err) {
    if (Number(err.code) === 10008 || /unknown message/i.test(err.message || "")) {
      state.messageId = null;
      state.messageIds = [];
      state.messageMissing = true;
      return true;
    }
    console.log(`${platform} Drops: nie udało się oznaczyć zakończonej wiadomości: ${err.message}`);
    return false;
  }
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

function mergeTwitchCampaignSources(primary, rewardCampaign, badgeCampaign) {
  const canonicalBadges = badgeCampaign?.drops || [];
  const emoteSources = [primary, rewardCampaign].filter(Boolean);
  const emoteDrops = [];
  const seenEmotes = new Set();
  for (const source of emoteSources) {
    for (const drop of source.drops || []) {
      if (Number(drop.required_subs || 0) > 0) continue;
      const emoteBenefits = (drop.benefits || []).filter(benefit => {
        const type = String(benefit?.distribution_type || "").toUpperCase();
        const channelScope = benefit?.channel_id || benefit?.channelId || benefit?.channel;
        return type === "EMOTE" && !GAME_ITEM_TYPES.has(type) && !channelScope;
      });
      if (!emoteBenefits.length) continue;
      const uniqueBenefits = emoteBenefits.filter(benefit => {
        const id = String(benefit.twitch_id || benefit.name || "").toLowerCase();
        if (seenEmotes.has(id)) return false;
        seenEmotes.add(id);
        return true;
      });
      if (uniqueBenefits.length) emoteDrops.push({ ...drop, benefits: uniqueBenefits });
    }
  }

  const sources = [primary, rewardCampaign, badgeCampaign].filter(Boolean);
  if (!sources.length) return null;
  const drops = [...canonicalBadges, ...emoteDrops];
  const allStarts = drops.map(drop => Date.parse(drop.start_at || "")).filter(Number.isFinite);
  const allEnds = drops.map(drop => Date.parse(drop.end_at || "")).filter(Number.isFinite);
  const startAt = allStarts.length ? new Date(Math.min(...allStarts)).toISOString() : sources[0].start_at;
  const endAt = allEnds.length ? new Date(Math.max(...allEnds)).toISOString() : sources[0].end_at;
  const preferred = primary || badgeCampaign || rewardCampaign;
  const merged = {
    ...preferred,
    twitch_id: preferred.twitch_id,
    name: preferred.name || sources.find(item => item.name)?.name || "Twitch Drops",
    description: primary?.description || rewardCampaign?.description || "",
    start_at: startAt,
    end_at: endAt,
    game: primary?.game || rewardCampaign?.game || badgeCampaign?.game || null,
    drops
  };
  if (!primary) merged.source = badgeCampaign ? "sunkwi-global-badges" : "sunkwi-reward-campaigns";
  merged.updated_at = crypto.createHash("sha256").update(JSON.stringify({
    primary: primary?.updated_at,
    rewards: rewardCampaign?.updated_at,
    badges: badgeCampaign?.updated_at,
    drops
  })).digest("hex");
  return merged;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    let primarySourceSummaries = [];
    try {
      primarySourceSummaries = await getCampaignSummaries();
    } catch (err) {
      console.log(`Twitch Drops: główne źródło kampanii niedostępne (${err.response?.status || err.code || err.message}); sprawdzam źródło kampanii nagród`);
    }
    const { campaigns: rewardCampaigns, badgeCampaigns } = await getRewardCampaignSnapshots(savedData, saveData);
    const rewardById = new Map(rewardCampaigns.map(item => [item.twitch_id, item]));
    const badgesById = new Map(badgeCampaigns.map(item => [item.twitch_id, item]));
    const primaryIds = new Set(primarySourceSummaries.map(campaign => campaign.twitch_id));
    const primarySummaries = primarySourceSummaries.map(summary => {
      const rewardDetails = rewardById.get(summary.twitch_id);
      const badgeDetails = badgesById.get(summary.twitch_id);
      if (!rewardDetails && !badgeDetails) return summary;
      const combinedVersion = crypto.createHash("sha256").update(JSON.stringify({
        primary: summary.updated_at,
        reward: rewardDetails?.updated_at,
        badge: badgeDetails?.updated_at
      })).digest("hex");
      return {
        ...summary,
        updated_at: combinedVersion,
        _rewardCampaignDetails: rewardDetails || null,
        _badgeCampaignDetails: badgeDetails || null
      };
    });
    const fallbackIds = new Set([...rewardById.keys(), ...badgesById.keys()]);
    const fallbackSummaries = [...fallbackIds]
      .filter(id => !primaryIds.has(id))
      .map(id => {
        const campaign = mergeTwitchCampaignSources(null, rewardById.get(id), badgesById.get(id));
        return {
          twitch_id: campaign.twitch_id,
          name: campaign.name,
          status: campaign.status,
          start_at: campaign.start_at,
          end_at: campaign.end_at,
          updated_at: campaign.updated_at,
          is_fully_imported: true,
          source: campaign.source,
          _campaignDetails: campaign,
          game: campaign.game
        };
      });
    const summaries = [...primarySummaries, ...fallbackSummaries];
    if (!summaries.length) {
      console.log("Twitch Drops: brak aktywnych/nadchodzących kampanii — sprawdzam zapisane kampanie");
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
      if (summary._campaignDetails) return summary._campaignDetails;
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
      if (summary._campaignDetails) return summary._campaignDetails;
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
      let campaign = details[index] || changed[index]._campaignDetails;
      if (!campaign) continue;
      if (changed[index]._rewardCampaignDetails || changed[index]._badgeCampaignDetails) {
        campaign = mergeTwitchCampaignSources(
          campaign,
          changed[index]._rewardCampaignDetails,
          changed[index]._badgeCampaignDetails
        );
      }
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
        const startAt = Date.parse(reward.campaignStart || "");
        const endAt = Date.parse(reward.campaignEnd || "");
        const startsLater = Number.isFinite(startAt) && startAt > Date.now();
        const isExpired = Number.isFinite(endAt) && endAt <= Date.now();
        let existing = rewardStates[reward.key];
        if (!existing) {
          const normalizedName = String(reward.name || "").trim().toLocaleLowerCase();
          existing = Object.values(rewardStates).find(state =>
            ["started", "scheduled"].includes(state?.status) &&
            state.reward?.campaignId === reward.campaignId &&
            String(state.reward?.name || "").trim().toLocaleLowerCase() === normalizedName
          );
        }

        const benefitId = reward.key.split(":").at(-1);
        const importedFingerprint = `${reward.campaignId}:${benefitId}`;
        const importedRewards = Array.isArray(savedData.twitchDropImportedRewards)
          ? savedData.twitchDropImportedRewards
          : [];
        const wasImportedAsAnnounced = importedRewards
          .some(item => item.fingerprint === importedFingerprint);
        if (wasImportedAsAnnounced && !existing) {
          existing = rewardStates[reward.key] = {
            status: startsLater ? "scheduled" : "started",
            startAt: reward.campaignStart,
            endAt: reward.campaignEnd,
            reward,
            messageId: null,
            messageIds: [],
            messageFormatVersion: REWARD_MESSAGE_FORMAT_VERSION,
            announcementImported: true
          };
          if (!savedData.twitchDropRewardIds.includes(reward.key)) {
            savedData.twitchDropRewardIds.push(reward.key);
          }
          saveData();
          alreadyAnnouncedCount++;
          continue;
        }

        if (isExpired) {
          continue;
        }

        if (startsLater) {
          if (!existing) {
            const message = await sendReward(channel, reward, "scheduled");
            rewardStates[reward.key] = {
              status: "scheduled",
              startAt: reward.campaignStart,
              endAt: reward.campaignEnd,
              reward,
              messageId: message?.id || null,
              messageIds: message?.id ? [message.id] : [],
              messageFormatVersion: REWARD_MESSAGE_FORMAT_VERSION
            };
            saveData();
            sentCount++;
          } else if (existing.status === "scheduled") {
            if (existing.messageFormatVersion !== REWARD_MESSAGE_FORMAT_VERSION ||
                JSON.stringify(existing.reward || {}) !== JSON.stringify(reward)) {
              await refreshRewardMessage(channel, existing, reward);
            }
            existing.startAt = reward.campaignStart;
            existing.endAt = reward.campaignEnd;
            existing.reward = reward;
          }
          continue;
        }

        if (existing?.status === "started") {
          if (existing.messageFormatVersion !== REWARD_MESSAGE_FORMAT_VERSION ||
              JSON.stringify(existing.reward || {}) !== JSON.stringify(reward)) {
            await refreshRewardMessage(channel, existing, reward);
            saveData();
          }
          alreadyAnnouncedCount++;
          continue;
        }

        if (!existing || existing.status === "scheduled") {
          const message = await sendReward(channel, reward, "started");
          rewardStates[reward.key] = {
            status: "started",
            startAt: reward.campaignStart,
            endAt: reward.campaignEnd,
            reward,
            messageId: message?.id || null,
            messageIds: message?.id ? [message.id] : [],
            messageFormatVersion: REWARD_MESSAGE_FORMAT_VERSION
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

    for (const state of Object.values(rewardStates)) {
      if (!["started", "scheduled"].includes(state.status) || !state.reward ||
          state.messageFormatVersion === REWARD_MESSAGE_FORMAT_VERSION) continue;
      if (await refreshRewardMessage(channel, state, state.reward)) saveData();
    }

    for (const [key, state] of Object.entries(rewardStates)) {
      if (state.status !== "scheduled" || !state.reward) continue;
      const startAt = Date.parse(state.startAt || state.reward.campaignStart || "");
      const endAt = Date.parse(state.endAt || state.reward.campaignEnd || "");
      if (Number.isFinite(endAt) && endAt <= Date.now()) {
        continue;
      }
      if (!Number.isFinite(startAt) || startAt > Date.now()) continue;

      const message = await sendReward(channel, state.reward, "started");
      state.status = "started";
      state.messageId = message?.id || null;
      state.messageIds = message?.id ? [message.id] : [];
      state.messageFormatVersion = REWARD_MESSAGE_FORMAT_VERSION;
      if (!savedData.twitchDropRewardIds.includes(key)) {
        savedData.twitchDropRewardIds.push(key);
      }
      saveData();
      sentCount++;
    }

    let recentMessages = null;
    for (const state of Object.values(rewardStates)) {
      if (!["started", "scheduled"].includes(state.status)) continue;
      const endAt = Date.parse(state.endAt || state.reward?.campaignEnd || "");
      if (!Number.isFinite(endAt) || endAt > Date.now()) continue;
      if (!state.messageId && !state.messageIds?.length && state.reward?.campaignUrl && channel.messages?.fetch) {
        if (recentMessages === null) {
          try {
            recentMessages = await channel.messages.fetch({ limit: 100 });
          } catch {
            recentMessages = [];
          }
        }
        const found = recentMessages.find(message =>
          message.author?.id === client.user?.id &&
          message.embeds?.some(embed =>
            embed.url === state.reward.campaignUrl && embed.title?.endsWith(state.reward.name)
          )
        );
        if (found) state.messageId = found.id;
      }
      await editExpiredReward(channel, state);
      state.status = "expired";
      saveData();
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
module.exports.normalizeRewardCampaign = normalizeRewardCampaign;
module.exports.normalizeGlobalBadgeCampaigns = normalizeGlobalBadgeCampaigns;
module.exports.mergeTwitchCampaignSources = mergeTwitchCampaignSources;
module.exports.getAccessDescription = getAccessDescription;
module.exports.getWhereToWatch = getWhereToWatch;
module.exports.makeRewardContent = makeRewardContent;
module.exports.validateCampaignSnapshot = validateCampaignSnapshot;
module.exports.makeRewardEmbed = makeRewardEmbed;
module.exports.mapWithConcurrency = mapWithConcurrency;
module.exports.sendReward = sendReward;
module.exports.refreshRewardMessage = refreshRewardMessage;
module.exports.editExpiredReward = editExpiredReward;
