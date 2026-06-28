const axios = require("axios");
const http = require("http");
const https = require("https");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.EPIC_CHANNEL_ID || "1479058453204045955";
const ROLE_ID = process.env.EPIC_ROLE_ID || "1371121977628295390";

const API_BASE =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";

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

function getHoursLeft(dateString) {
  if (!dateString) return null;

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;

  return Math.max(0, Math.floor((date - Date.now()) / 3600000));
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
  const price = game.price?.totalPrice;
  const discountPercentage = promo.discountSetting?.discountPercentage;

  return (
    discountPercentage === 0 ||
    price?.discountPrice === 0 ||
    isMysteryOrVault(game)
  );
}

function getActiveFreePromo(game, now) {
  return getPromoOffers(game).find(
    promo => isPromoActive(promo, now) && isPromoFree(game, promo)
  );
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
  return aliases.some(alias => known.has(alias));
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
  const byKey = new Map();

  for (const candidate of candidates) {
    const title = normalizeTitle(candidate.game.title);
    const end = candidate.activePromo.endDate || "";
    const slug = candidate.slug || "";
    const key = title && end ? `${title}:${end}` : `${slug}:${end}`;

    if (!key) continue;

    if (!byKey.has(key)) {
      byKey.set(key, candidate);
      continue;
    }

    const current = byKey.get(key);

    if (!current.slug && candidate.slug) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("Epic: checking official free games...");

    const { elements, ok } = await fetchEpicElements(options.signal);

    savedData.epicGames ??= [];

    const known = new Set(savedData.epicGames.map(String));
    const now = new Date();
    const candidates = [];
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

    const fresh = mergeCandidates(candidates);

    console.log(
      `Epic: sources=${ok}/${API_REQUESTS.length} all=${stats.all} activeFree=${stats.activeFree} known=${stats.known} new=${fresh.length} skipped=${stats.skipped}`
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
        const hoursLeft = getHoursLeft(activePromo.endDate);
        const url = getStoreUrl(slug);

        const embed = new EmbedBuilder()
          .setTitle(game.title)
          .setURL(url)
          .setColor("#2f3136")
          .setFooter({ text: "Epic Games" })
          .setDescription(
            `PC
Gratis do: ${formatDate(activePromo.endDate)}${
  hoursLeft !== null ? `\nZostalo: ${hoursLeft}h` : ""
}`
          )
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
