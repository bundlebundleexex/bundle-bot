const axios = require("axios");
const http = require("http");
const https = require("https");

const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1531289390360428564";
const ROLE_ID = "1371121977628295390";

const GAMERPOWER_URL =
  "https://www.gamerpower.com/api/filter?platform=epic-games-store&type=game";

const EPIC_URL =
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

function parseDate(dateString) {
  if (!dateString || dateString === "N/A") {
    return null;
  }

  const date = new Date(String(dateString).replace(" ", "T"));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function formatDate(dateString) {
  if (!dateString || dateString === "N/A") {
    return "brak daty";
  }

  const raw = String(dateString).trim();
  const simpleDate = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/
  );

  if (simpleDate) {
    const [, year, month, day, hour, minute] = simpleDate;

    return `${day}.${month}.${year} ${hour}:${minute}`;
  }

  const date = parseDate(raw);

  if (!date) {
    return raw;
  }

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
  const date = parseDate(dateString);

  if (!date) {
    return null;
  }

  const diff = date - Date.now();

  return Math.max(0, Math.floor(diff / 3600000));
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/\(Epic Games Store\)/gi, "")
    .replace(/\(Epic Games\)/gi, "")
    .replace(/Giveaway/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getCategoryPaths(game) {
  return (game.categories || [])
    .map(category => String(category.path || "").toLowerCase())
    .filter(Boolean);
}

function hasFreeGamesCategory(game) {
  return getCategoryPaths(game).some(category => category.startsWith("freegames"));
}

function getPromoOffers(game) {
  const promotions = game.promotions || {};

  return [
    ...(promotions.promotionalOffers || []),
    ...(promotions.upcomingPromotionalOffers || [])
  ].flatMap(group => group.promotionalOffers || []);
}

function isMysteryOrVaulted(game) {
  const text = `${game.title || ""} ${game.urlSlug || ""}`.toLowerCase();

  return (
    text.includes("mysterygame") ||
    text.includes("mystery game") ||
    text.includes("vault")
  );
}

function hasActiveFreeEpicPromo(game, now) {
  const price = game.price?.totalPrice;

  if (!hasFreeGamesCategory(game) || !price) {
    return false;
  }

  return getPromoOffers(game).some(promo => {
    const start = new Date(promo.startDate);
    const end = new Date(promo.endDate);
    const discountPercentage = promo.discountSetting?.discountPercentage;

    if (!(now >= start && now < end)) {
      return false;
    }

    return (
      discountPercentage === 0 ||
      price.discountPrice === 0 ||
      isMysteryOrVaulted(game)
    );
  });
}

function getOfficialEpicFreeTitles(epicData) {
  const now = new Date();
  const elements = epicData?.data?.Catalog?.searchStore?.elements || [];

  return new Set(
    elements
      .filter(game => hasActiveFreeEpicPromo(game, now))
      .map(game => normalizeTitle(game.title))
      .filter(Boolean)
  );
}

function isBlockedOffer(game) {
  const title = String(game.title || "").toLowerCase();
  const type = String(game.type || "").toLowerCase();

  if (type && type !== "game") {
    return true;
  }

  const blockedTitlePatterns = [
    /\bdlc\b/,
    /\badd-?on\b/,
    /\bstarter pack\b/,
    /\bstarter bundle\b/,
    /\bfounder'?s? pack\b/,
    /\bcosmetic pack\b/,
    /\bskin pack\b/,
    /\bweapon pack\b/,
    /\bbonus pack\b/,
    /\bbeta access\b/,
    /\bearly access key\b/,
    /\bclosed beta\b/,
    /\bopen beta\b/,
    /\bdemo\b/,
    /\btrial\b/,
    /\bsoundtrack\b/,
    /\bartbook\b/,
    /\bcreator kit\b/,
    /\bmod kit\b/
  ];

  return blockedTitlePatterns.some(pattern => pattern.test(title));
}

function getGiveawayId(game) {
  return String(game.id || `${normalizeTitle(game.title)}_${game.end_date || ""}`);
}

function getDescription(game) {
  const desc = String(game.description || "").trim();

  if (!desc) {
    return "";
  }

  return desc.length > 220 ? `${desc.slice(0, 220)}...` : desc;
}

// ==========================
// MAIN CHECK
// ==========================

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("🟡 EpicDeals: sprawdzam dodatkowe giveawaye...");

    const [gamerPowerResult, epicResult] = await Promise.allSettled([
      axiosInstance.get(GAMERPOWER_URL, {
        signal: options.signal
      }),

      axiosInstance.get(EPIC_URL, {
        signal: options.signal
      })
    ]);

    if (gamerPowerResult.status === "rejected") {
      throw gamerPowerResult.reason;
    }

    if (epicResult.status === "rejected") {
      console.log(
        "⚠️ EpicDeals: nie udało się pobrać oficjalnego Epic API, sprawdzam bez antyduplikacji:",
        epicResult.reason?.response?.status || epicResult.reason?.message
      );
    }

    const rawItems = gamerPowerResult.value.data;
    const items = Array.isArray(rawItems) ? rawItems : [];
    const officialEpicTitles =
      epicResult.status === "fulfilled"
        ? getOfficialEpicFreeTitles(epicResult.value.data)
        : new Set();

    savedData.epicDeals ??= [];

    const known = new Set(savedData.epicDeals);
    const fresh = [];
    const stats = {
      all: items.length,
      active: 0,
      duplicatesOfficial: 0,
      known: 0,
      blocked: 0,
      noTitle: 0,
      new: 0
    };

    for (const game of items) {
      try {
        if (game.status !== "Active") {
          continue;
        }

        stats.active += 1;

        if (isBlockedOffer(game)) {
          stats.blocked += 1;

          continue;
        }

        const cleanTitle = String(game.title || "")
          .replace(/\(Epic Games Store\)/gi, "")
          .replace(/\(Epic Games\)/gi, "")
          .replace(/Giveaway/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        const normalizedTitle = normalizeTitle(cleanTitle);

        if (!normalizedTitle) {
          stats.noTitle += 1;

          continue;
        }

        if (officialEpicTitles.has(normalizedTitle)) {
          stats.duplicatesOfficial += 1;

          continue;
        }

        const giveawayId = getGiveawayId(game);

        if (known.has(giveawayId)) {
          stats.known += 1;

          continue;
        }

        fresh.push({
          ...game,
          cleanTitle,
          giveawayId
        });
      } catch (err) {
        console.log(
          `⚠️ EpicDeals item pominięty: ${game?.title || "bez tytułu"} (${err.message})`
        );
      }
    }

    stats.new = fresh.length;

    console.log(
      `📊 EpicDeals: all=${stats.all} active=${stats.active} officialDupes=${stats.duplicatesOfficial} known=${stats.known} blocked=${stats.blocked} new=${stats.new}`
    );

    if (!fresh.length) {
      console.log("⏸ EpicDeals: bez zmian");

      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of fresh) {
      try {
        const hoursLeft = getHoursLeft(game.end_date);
        const desc = getDescription(game);

        const embed = new EmbedBuilder()
          .setTitle(game.cleanTitle)
          .setURL(game.open_giveaway || game.gamerpower_url)
          .setColor("#2f3136")
          .setFooter({
            text: "Epic Games Deals • GamerPower"
          })
          .setDescription(
            `🖥️ **PC**
🎁 **Wartość:** ${game.worth || "brak danych"}
⌛ **Gratis do:** ${formatDate(game.end_date)}${
  hoursLeft !== null ? `\n⏳ **Zostało:** ${hoursLeft}h` : ""
}${desc ? `\n\n${desc}` : ""}`
          )
          .setTimestamp();

        if (game.image) {
          embed.setImage(game.image);
        }

        await channel.send({
          content: `🔥 **NOWA DARMÓWKA NA EPIC!** <@&${ROLE_ID}>`,
          embeds: [embed]
        });

        console.log("🎮 EpicDeals wysłano:", game.cleanTitle);

        savedData.epicDeals.push(game.giveawayId);
        savedData.epicDeals = [...new Set(savedData.epicDeals)].slice(-500);

        saveData();
      } catch (err) {
        console.log("EpicDeals item error:", err.message);
      }
    }

    global.gc?.();

    console.log("✅ EpicDeals sprawdzony");
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("❌ EpicDeals error:", err.response?.status || err.message);
  }
};