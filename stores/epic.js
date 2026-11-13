const axios = require("axios");
const http = require("http");
const https = require("https");
const { EmbedBuilder } = require("discord.js");
const cheerio = require("cheerio");

const CHANNEL_ID = process.env.EPIC_CHANNEL_ID || "1531289390360428564";
const ROLE_ID = process.env.EPIC_ROLE_ID || "1371121977628295390";

const API_BASE =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
const GAMERPOWER_API =
  "https://www.gamerpower.com/api/giveaways?platform=epic-games-store&type=game";

const API_REQUESTS = [
  { locale: "pl-PL", country: "PL", allowCountries: "PL" },
  { locale: "en-US", country: "PL", allowCountries: "PL" }
];

const MAX_SAVED_KEYS = 1500;

const axiosInstance = axios.create({
  timeout: 20000,
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false }),
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
});

function buildApiUrl(request) {
  return `${API_BASE}?${new URLSearchParams(request).toString()}`;
}

function formatDate(dateString) {
  if (!dateString) return "brak daty";

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return String(dateString);

  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatPromoWindow(promo) {
  const lines = [];
  if (promo?.startDate) lines.push(`Dostępny od: ${formatDate(promo.startDate)}`);
  if (promo?.endDate) lines.push(`Dostępny do: ${formatDate(promo.endDate)}`);
  return lines.join("\n") || "Brak potwierdzonego terminu";
}

function parseUtcDate(value) {
  if (!value || value === "N/A") return null;
  // GamerPower returns UTC timestamps without a timezone suffix.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanGiveawayTitle(title) {
  return String(title || "")
    .replace(/\s*\((?:epic games(?: store)?)\)\s*giveaways?\s*$/i, "")
    .replace(/\s+(?:epic games(?: store)?)\s+giveaways?\s*$/i, "")
    .trim();
}

function isEpicGameGiveaway(item, now) {
  const platforms = String(item?.platforms || "").toLowerCase();
  const type = String(item?.type || "").toLowerCase();
  const end = parseUtcDate(item?.end_date);

  return (
    String(item?.status || "").toLowerCase() === "active" &&
    type === "game" &&
    platforms.includes("epic games store") &&
    Boolean(item?.title) &&
    Boolean(end && end > now)
  );
}

async function fetchGamerPowerGiveaways(signal) {
  const response = await axiosInstance.get(GAMERPOWER_API, { signal });
  if (!Array.isArray(response.data)) {
    throw new Error("GamerPower returned an unexpected response");
  }
  return response.data;
}

async function resolveClaimUrl(item) {
  const candidates = [item?.open_giveaway_url, item?.open_giveaway, item?.claim_url];

  const tryOfficialTarget = async candidate => {
    if (!candidate) return null;
    try {
      const response = await axiosInstance.get(candidate, {
        maxRedirects: 5,
        responseType: "text"
      });
      const finalUrl =
        response.request?.res?.responseUrl ||
        response.request?._redirectable?._currentUrl;
      const hostname = finalUrl ? new URL(finalUrl).hostname.toLowerCase() : "";
      if (
        finalUrl &&
        (hostname === "epicgames.com" || hostname.endsWith(".epicgames.com")) &&
        /\/p\//i.test(new URL(finalUrl).pathname)
      ) {
        return finalUrl;
      }
    } catch {
      // Try the next public claim link.
    }
    return null;
  };

  for (const candidate of candidates) {
    const officialUrl = await tryOfficialTarget(candidate);
    if (officialUrl) return officialUrl;
  }

  // The API's claim URL can be a JavaScript/meta-refresh link. Read the public
  // listing and follow its Claim button to recover the canonical Epic product URL.
  if (item?.gamerpower_url) {
    try {
      const response = await axiosInstance.get(item.gamerpower_url, {
        responseType: "text"
      });
      const $ = cheerio.load(response.data);
      const links = $("a[href]")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter(href => href && /gamerpower\.com\/open\//i.test(href));

      for (const link of links) {
        const officialUrl = await tryOfficialTarget(
          new URL(link, item.gamerpower_url).href
        );
        if (officialUrl) return officialUrl;
      }
    } catch {
      // Fall through to the direct claim redirect below.
    }
  }

  return item?.open_giveaway_url || item?.open_giveaway || item?.claim_url || null;
}

function getSlugFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/p\/([^/?#]+)/i);
    return cleanSlug(match?.[1]);
  } catch {
    return null;
  }
}

function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/40[\s,.-]*000/g, "40k")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCustomAttribute(game, key) {
  return (game.customAttributes || []).find(item => item.key === key)?.value;
}

function cleanSlug(slug) {
  if (!slug || slug === "[]" || slug === "null") return null;
  return String(slug).replace(/\/home$/, "").replace(/^\/+|\/+$/g, "");
}

function getSlug(game) {
  return (
    cleanSlug(game.catalogNs?.mappings?.[0]?.pageSlug) ||
    cleanSlug(game.offerMappings?.[0]?.pageSlug) ||
    cleanSlug(getCustomAttribute(game, "com.epicgames.app.productSlug")) ||
    cleanSlug(game.productSlug) ||
    cleanSlug(game.urlSlug)
  );
}

function getStoreUrl(slug) {
  return slug
    ? `https://store.epicgames.com/pl/p/${slug}`
    : "https://store.epicgames.com/pl/free-games";
}

function getCategoryPaths(game) {
  return (game.categories || [])
    .map(category => String(category.path || "").toLowerCase())
    .filter(Boolean);
}

function hasBlockedCategory(game) {
  return getCategoryPaths(game).some(
    category =>
      category.startsWith("addons") ||
      category.includes("addons") ||
      category.includes("mods") ||
      category.includes("digitalextras")
  );
}

function isToolOrSoftware(game) {
  const offerType = String(game.offerType || "").toUpperCase();
  const categories = getCategoryPaths(game);

  if (
    offerType === "BASE_GAME" &&
    categories.includes("freegames") &&
    categories.some(category => category === "games" || category.startsWith("games/"))
  ) {
    return false;
  }

  const text = [
    game.title,
    game.urlSlug,
    game.productSlug,
    getCategoryPaths(game).join(" "),
    JSON.stringify(game.customAttributes || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /(software|developer tool|creator kit|mod kit|asset pack|template pack)/.test(
    text
  );
}

function isMysteryOrVault(game) {
  const text = [
    game.title,
    game.urlSlug,
    game.productSlug,
    getCustomAttribute(game, "com.epicgames.app.freegames.vault.slug")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("mysterygame") ||
    text.includes("mystery game") ||
    text.includes("vault")
  );
}

function getPromoOffers(game) {
  const promos = game.promotions || {};

  return [
    ...(promos.promotionalOffers || []),
    ...(promos.upcomingPromotionalOffers || [])
  ].flatMap(group => group.promotionalOffers || []);
}

function isPromoActive(promo, now) {
  const start = new Date(promo.startDate);
  const end = new Date(promo.endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return false;
  }

  return now >= start && now < end;
}

function isPromoFree(game, promo) {
  // The catalog price can be zero because of a different offer on the same game.
  // Epic's giveaway feed normally reports 0 for a free-game promotion (the
  // percentage of the original price still payable). Some catalog records use
  // the conventional 100%-off value instead, so accept that only when the
  // game's current catalog price independently confirms a zero payable price.
  const percentage = Number(promo?.discountSetting?.discountPercentage);
  if (percentage === 0) return true;

  const totalPrice = game?.price?.totalPrice;
  const originalPrice = Number(totalPrice?.originalPrice);
  const discountPrice = Number(totalPrice?.discountPrice);

  return (
    percentage === 100 &&
    Number.isFinite(originalPrice) &&
    originalPrice > 0 &&
    discountPrice === 0
  );
}

function getActiveFreePromo(game, now) {
  return getPromoOffers(game)
    .filter(promo => isPromoActive(promo, now) && isPromoFree(game, promo))
    .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))[0] || null;
}

function looksLikeClaimableGame(game) {
  const offerType = String(game.offerType || "").toUpperCase();
  const categories = getCategoryPaths(game);

  return (
    offerType === "BASE_GAME" ||
    offerType === "OTHERS" ||
    categories.some(category => category.startsWith("freegames")) ||
    isMysteryOrVault(game)
  );
}

function getImage(game) {
  return (
    game.keyImages?.find(image => image.type === "OfferImageWide")?.url ||
    game.keyImages?.find(image => image.type === "DieselStoreFrontWide")?.url ||
    game.keyImages?.find(image => image.type === "VaultClosed")?.url ||
    game.keyImages?.find(image => image.type === "DieselGameBoxWide")?.url ||
    game.keyImages?.[0]?.url ||
    null
  );
}

function getAliases(game, slug, promo) {
  const aliases = new Set();
  const title = normalizeTitle(game.title);
  const start = promo?.startDate || "";
  const end = promo?.endDate || "";

  if (title && end) aliases.add(`epic:title:${title}:${end}`);
  if (title && start && end) aliases.add(`epic:title:${title}:${start}:${end}`);
  if (title && start) aliases.add(`epic:window:${title}|${start}`);
  if (slug && end) aliases.add(`epic:slug:${slug}:${end}`);
  if (game.id && end) aliases.add(`epic:id:${game.id}:${end}`);
  if (game.namespace && end) aliases.add(`epic:namespace:${game.namespace}:${end}`);

  if (promo) {
    const legacyBase = game.id || game.urlSlug || slug || game.title;
    aliases.add(`${legacyBase}_${promo.startDate}_${promo.endDate}`);
  }

  return [...aliases].filter(Boolean);
}

function isKnown(aliases, known) {
  if (aliases.some(alias => known.has(alias))) return true;

  // Migrate old title/start/end keys so changing an incorrect end date does not
  // generate a second announcement for the same promotion window.
  for (const alias of aliases) {
    const match = alias.match(/^epic:window:(.*)\|(.*)$/);
    if (!match) continue;
    const legacyPrefix = `epic:title:${match[1]}:${match[2]}:`;
    if ([...known].some(key => key.startsWith(legacyPrefix))) return true;
  }

  return false;
}

function hasKnownOfficialTitle(title, known) {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  const prefix = `epic:title:${normalized}:`;
  return [...known].some(key => String(key).startsWith(prefix));
}

function saveKnown(savedData, known, saveData) {
  savedData.epicGames = [...known].slice(-MAX_SAVED_KEYS);
  saveData();
}

function inspectGame(game, now) {
  const title = game.title || "no title";
  const activePromo = getActiveFreePromo(game, now);

  if (!activePromo) {
    return { skip: true, reason: "no active free promo", title };
  }

  if (!looksLikeClaimableGame(game)) {
    return { skip: true, reason: "not claimable game", title };
  }

  if (hasBlockedCategory(game)) {
    return { skip: true, reason: "addon/mod", title };
  }

  if (isToolOrSoftware(game)) {
    return { skip: true, reason: "tool/software", title };
  }

  return { skip: false, activePromo, title };
}

function makeGamerPowerCandidate(item, slug, claimUrl) {
  const endDate = parseUtcDate(item.end_date).toISOString();
  const title = cleanGiveawayTitle(item.title);
  const game = {
    id: `gamerpower-${item.id}`,
    title,
    offerType: "BASE_GAME",
    productSlug: slug,
    urlSlug: slug,
    keyImages: [
      { type: "OfferImageWide", url: item.image || item.thumbnail }
    ].filter(image => image.url),
    promotions: {},
    claimUrl,
    gamerPowerUrl: item.gamerpower_url,
    description: item.description || ""
  };
  const activePromo = { startDate: null, endDate };
  const aliases = getAliases(game, slug, activePromo);
  if (item.id) aliases.push(`epic:gamerpower:${item.id}:${endDate}`);

  return { game, slug, aliases, activePromo, source: "GamerPower" };
}

async function fetchEpicElements(signal) {
  const results = await Promise.allSettled(
    API_REQUESTS.map(request =>
      axiosInstance.get(buildApiUrl(request), { signal })
    )
  );

  const elements = [];
  let ok = 0;

  for (const result of results) {
    if (result.status === "rejected") {
      console.log(
        "Epic API request failed:",
        result.reason?.response?.status || result.reason?.message
      );
      continue;
    }

    ok++;
    elements.push(
      ...(result.value.data?.data?.Catalog?.searchStore?.elements || [])
    );
  }

  return { elements, ok };
}

function mergeCandidates(candidates) {
  const groups = [];

  for (const candidate of candidates) {
    const slug = cleanSlug(candidate.slug || getSlug(candidate.game)) || "";
    const title = normalizeTitle(candidate.game.title);
    const identity = {
      ...candidate,
      slug: slug || null,
      aliases: [...new Set(candidate.aliases || [])],
      _normalizedTitle: title
    };

    if (!title && !slug && !candidate.game.namespace && !candidate.game.id) {
      continue;
    }

    const matches = groups.filter(group =>
      (title && group._normalizedTitle === title) ||
      (slug && group.slug?.toLowerCase() === slug.toLowerCase()) ||
      (candidate.game.namespace && group.game.namespace === candidate.game.namespace) ||
      (candidate.game.id && group.game.id === candidate.game.id)
    );

    if (!matches.length) {
      groups.push(identity);
      continue;
    }

    const all = [identity, ...matches];
    const official = all.filter(item => !item.source);
    const pool = official.length ? official : all;
    const selected = pool.reduce((best, item) => {
      if (!best) return item;
      // Keep the official Epic feed's date when it is available. For regional
      // copies of that official record, preserve the existing latest-end rule.
      if (official.length) {
        return Date.parse(item.activePromo?.endDate || "") >
          Date.parse(best.activePromo?.endDate || "") ? item : best;
      }
      // For duplicate third-party records, prefer the one that resolved to an
      // Epic product URL and avoid extending the claim window on a conflict.
      if (Boolean(item.slug) !== Boolean(best.slug)) return item.slug ? item : best;
      return Date.parse(item.activePromo?.endDate || "") <
        Date.parse(best.activePromo?.endDate || "") ? item : best;
    }, null);

    selected.aliases = [...new Set(all.flatMap(item => item.aliases || []))];
    selected.slug ||= slug || matches.find(item => item.slug)?.slug || null;
    selected.game.keyImages = selected.game.keyImages?.length
      ? selected.game.keyImages
      : all.find(item => item.game.keyImages?.length)?.game.keyImages || [];

    for (const match of matches) {
      const index = groups.indexOf(match);
      if (index !== -1) groups.splice(index, 1);
    }
    groups.push(selected);
  }

  return groups.map(({ _normalizedTitle, ...candidate }) => candidate);
}

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("Epic: checking official free games...");

    const { elements, ok } = await fetchEpicElements(options.signal);

    savedData.epicGames ??= [];

    const known = new Set(savedData.epicGames.map(String));
    const now = new Date();
    const candidates = [];
    const officialFeedTitles = new Set();
    const skipReasons = {};
    const skippedTitles = {};
    const stats = {
      all: elements.length,
      activeFree: 0,
      known: 0,
      skipped: 0
    };

    for (const game of elements) {
      try {
        const officialTitle = normalizeTitle(game?.title);
        if (officialTitle) officialFeedTitles.add(officialTitle);
        const result = inspectGame(game, now);

        if (result.skip) {
          stats.skipped++;
          skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;

          if (result.reason !== "no active free promo") {
            skippedTitles[result.reason] ??= [];
            skippedTitles[result.reason].push(result.title);
          }

          continue;
        }

        stats.activeFree++;
        const slug = getSlug(game);
        const aliases = getAliases(game, slug, result.activePromo);

        if (isKnown(aliases, known)) {
          stats.known++;
          continue;
        }

        candidates.push({
          game,
          slug,
          aliases,
          activePromo: result.activePromo
        });
      } catch (err) {
        stats.skipped++;
        skipReasons.error = (skipReasons.error || 0) + 1;
        console.log(
          `Epic item skipped: ${game?.title || "no title"} (${err.message})`
        );
      }
    }

    // Only query the supplemental source after the official Epic feed has
    // been fully scanned. Epic remains authoritative when a third party keeps
    // reporting a stale end date for an already announced offer.
    let gamerPowerCount = 0;
    try {
      const giveaways = await fetchGamerPowerGiveaways(options.signal);
      const activeGiveaways = giveaways.filter(item => isEpicGameGiveaway(item, now));
      gamerPowerCount = activeGiveaways.length;

      const supplemental = await Promise.allSettled(
        activeGiveaways.map(async item => {
          const endDate = parseUtcDate(item.end_date).toISOString();
          const sourceKey = item.id
            ? `epic:gamerpower:${item.id}:${endDate}`
            : null;
          if (sourceKey && known.has(sourceKey)) {
            stats.known++;
            return;
          }

          const supplementalTitle = normalizeTitle(cleanGiveawayTitle(item.title));
          if (
            officialFeedTitles.has(supplementalTitle) ||
            hasKnownOfficialTitle(supplementalTitle, known)
          ) {
            stats.known++;
            return;
          }

          const claimUrl = await resolveClaimUrl(item);
          const slug = getSlugFromUrl(claimUrl);
          const candidate = makeGamerPowerCandidate(item, slug, claimUrl);

          // Epic's own promotion feed is authoritative for its dates. A second
          // source can report a later or stale end time for the same product;
          // never let that create another announcement when Epic already lists it.
          if (officialFeedTitles.has(normalizeTitle(candidate.game.title))) {
            stats.known++;
            return;
          }

          if (isKnown(candidate.aliases, known)) {
            stats.known++;
            return;
          }

          candidates.push(candidate);
        })
      );

      for (const result of supplemental) {
        if (result.status === "rejected") {
          console.log("Epic GamerPower item skipped:", result.reason?.message);
        }
      }
    } catch (err) {
      if (err.name === "CanceledError" || err.code === "ERR_CANCELED") throw err;
      console.log("Epic GamerPower source failed:", err.response?.status || err.message);
    }

    const fresh = mergeCandidates(candidates);

    console.log(
      `Epic: officialSources=${ok}/${API_REQUESTS.length} officialAll=${stats.all} officialFree=${stats.activeFree} GamerPower=${gamerPowerCount} known=${stats.known} new=${fresh.length} skipped=${stats.skipped}`
    );

    if (Object.keys(skipReasons).length) {
      console.log("Epic skip reasons:", skipReasons);
    }

    if (Object.keys(skippedTitles).length) {
      console.log("Epic skipped titles:", skippedTitles);
    }

    if (!fresh.length) {
      console.log("Epic: no changes");
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const item of fresh) {
      try {
        const { game, slug, aliases, activePromo } = item;
        const image = getImage(game);
        const url = slug ? getStoreUrl(slug) : game.claimUrl || getStoreUrl(slug);
        const embed = new EmbedBuilder()
          .setTitle(game.title)
          .setURL(url)
          .setColor("#2f3136")
          .setFooter({ text: "Epic Games" })
          .setDescription(`PC\n${formatPromoWindow(activePromo)}`)
          .setTimestamp();

        if (image) embed.setImage(image);

        await channel.send({
          content: `<@&${ROLE_ID}>`,
          embeds: [embed]
        });

        for (const alias of aliases) {
          known.add(alias);
        }

        saveKnown(savedData, known, saveData);

        console.log("Epic sent:", game.title);
      } catch (err) {
        console.log("Epic item error:", err.message);
      }
    }

    global.gc?.();

    console.log("Epic: checked");
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("Epic error:", err.message);
  }
};

module.exports.getActiveFreePromo = getActiveFreePromo;
module.exports.isEpicGameGiveaway = isEpicGameGiveaway;
module.exports.isPromoFree = isPromoFree;
module.exports.getAliases = getAliases;
module.exports.isKnown = isKnown;
module.exports.hasKnownOfficialTitle = hasKnownOfficialTitle;
module.exports.mergeCandidates = mergeCandidates;
module.exports.formatDate = formatDate;
module.exports.formatPromoWindow = formatPromoWindow;
