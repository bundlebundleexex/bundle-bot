const axios = require("axios");
const http = require("http");
const https = require("https");

const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1479058453204045955";
const ROLE_ID = "1371121977628295390";

const API_URL =
  "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pl-PL&country=PL&allowCountries=PL";

// ==========================
// AXIOS
// ==========================

const axiosInstance = axios.create({
  timeout: 15000,

  httpAgent: new http.Agent({
    keepAlive: false
  }),

  httpsAgent: new https.Agent({
    keepAlive: false
  }),

  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
});

// ==========================
// HELPERS
// ==========================

function formatDate(dateString) {
  if (!dateString) {
    return "brak daty";
  }

  const date = new Date(dateString);

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
  if (!dateString) {
    return null;
  }

  const diff = new Date(dateString) - Date.now();

  return Math.max(0, Math.floor(diff / 3600000));
}

function getCustomAttribute(game, key) {
  return (game.customAttributes || []).find(item => item.key === key)?.value;
}

function cleanSlug(slug) {
  if (!slug || slug === "[]" || slug === "null") {
    return null;
  }

  return String(slug).replace(/\/home$/, "");
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

function getStoreUrl(game, slug) {
  if (slug) {
    return `https://store.epicgames.com/pl/p/${slug}`;
  }

  return "https://store.epicgames.com/pl/free-games";
}

function getCategoryPaths(game) {
  return (game.categories || [])
    .map(category => String(category.path || "").toLowerCase())
    .filter(Boolean);
}

function hasFreeGamesCategory(game) {
  return getCategoryPaths(game).some(category => category.startsWith("freegames"));
}

function hasBlockedCategory(game) {
  return getCategoryPaths(game).some(
    category => category.startsWith("addons") || category.includes("mods")
  );
}

function looksLikeTool(game) {
  const text = JSON.stringify(game.customAttributes || []).toLowerCase();

  return (
    text.includes("creator") ||
    text.includes("editor") ||
    text.includes("software") ||
    text.includes("toolkit")
  );
}

function isMysteryOrVaulted(game) {
  const text = [
    game.title,
    game.urlSlug,
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
  const promotions = game.promotions || {};

  const current = promotions.promotionalOffers || [];
  const upcoming = promotions.upcomingPromotionalOffers || [];

  return [...current, ...upcoming].flatMap(group => group.promotionalOffers || []);
}

function getActiveFreePromo(game, now) {
  const price = game.price?.totalPrice;

  return getPromoOffers(game).find(promo => {
    const start = new Date(promo.startDate);
    const end = new Date(promo.endDate);
    const discountPercentage = promo.discountSetting?.discountPercentage;

    if (!(now >= start && now < end)) {
      return false;
    }

    return discountPercentage === 0 || price?.discountPrice === 0;
  });
}

function getPromoId(game, slug, promo) {
  const baseId = game.id || game.urlSlug || slug || game.title;

  return `${baseId}_${promo.startDate}_${promo.endDate}`;
}

function getImage(game) {
  return (
    game.keyImages?.find(image => image.type === "OfferImageWide")?.url ||
    game.keyImages?.find(image => image.type === "DieselStoreFrontWide")?.url ||
    game.keyImages?.find(image => image.type === "VaultClosed")?.url ||
    game.keyImages?.[0]?.url ||
    null
  );
}

function shouldSkipGame(game, now) {
  const title = game.title || "bez tytułu";
  const price = game.price?.totalPrice;
  const activePromo = getActiveFreePromo(game, now);
  const mysteryOrVaulted = isMysteryOrVaulted(game);

  if (!hasFreeGamesCategory(game)) {
    return { skip: true, reason: "brak kategorii freegames", title };
  }

  if (hasBlockedCategory(game)) {
    return { skip: true, reason: "addon/mod", title };
  }

  if (looksLikeTool(game)) {
    return { skip: true, reason: "tool/editor", title };
  }

  if (!price) {
    return { skip: true, reason: "brak ceny", title };
  }

  if (!activePromo) {
    return { skip: true, reason: "brak aktywnej darmowej promocji", title };
  }

  if (price.discountPrice !== 0 && !mysteryOrVaulted) {
    return { skip: true, reason: "cena nie jest 0", title };
  }

  return {
    skip: false,
    activePromo,
    title
  };
}

// ==========================
// MAIN CHECK
// ==========================

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("🟣 Epic: sprawdzam darmowe gry...");

    const res = await axiosInstance.get(API_URL, {
      signal: options.signal
    });

    const elements = res.data?.data?.Catalog?.searchStore?.elements || [];

    savedData.epicGames ??= [];

    const known = new Set(savedData.epicGames);
    const fresh = [];
    const stats = {
      all: elements.length,
      activeFree: 0,
      known: 0,
      skipped: 0
    };

    const skipReasons = {};
    const now = new Date();

    for (const game of elements) {
      try {
        const result = shouldSkipGame(game, now);

        if (result.skip) {
          stats.skipped += 1;
          skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;

          continue;
        }

        stats.activeFree += 1;

        const slug = getSlug(game);
        const promoId = getPromoId(game, slug, result.activePromo);

        if (known.has(promoId)) {
          stats.known += 1;

          continue;
        }

        fresh.push({
          game,
          slug,
          promoId,
          activePromo: result.activePromo
        });
      } catch (err) {
        stats.skipped += 1;
        skipReasons.error = (skipReasons.error || 0) + 1;

        console.log(
          `⚠️ Epic item pominięty: ${game?.title || "bez tytułu"} (${err.message})`
        );
      }
    }

    console.log(
      `📊 Epic: all=${stats.all} activeFree=${stats.activeFree} known=${stats.known} new=${fresh.length} skipped=${stats.skipped}`
    );

    if (Object.keys(skipReasons).length) {
      console.log("📊 Epic skip reasons:", skipReasons);
    }

    if (!fresh.length) {
      console.log("⏸ Epic: bez zmian");

      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const item of fresh) {
      try {
        const { game, slug, promoId, activePromo } = item;
        const image = getImage(game);
        const hoursLeft = getHoursLeft(activePromo.endDate);
        const url = getStoreUrl(game, slug);

        const embed = new EmbedBuilder()
          .setTitle(game.title)
          .setURL(url)
          .setColor("#2f3136")
          .setFooter({
            text: "Epic Games"
          })
          .setDescription(
            `🖥️ **PC**
⌛ **Gratis do:** ${formatDate(activePromo.endDate)}${
  hoursLeft !== null ? `\n⏳ **Zostało:** ${hoursLeft}h` : ""
}`
          )
          .setTimestamp();

        if (image) {
          embed.setImage(image);
        }

        await channel.send({
          content: `<@&${ROLE_ID}>`,
          embeds: [embed]
        });

        console.log("🎮 Epic wysłano:", game.title);

        savedData.epicGames.push(promoId);
        savedData.epicGames = [...new Set(savedData.epicGames)].slice(-500);

        saveData();
      } catch (err) {
        console.log("Epic item error:", err.message);
      }
    }

    global.gc?.();

    console.log("✅ Epic sprawdzony");
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("❌ Epic error:", err.message);
  }
};