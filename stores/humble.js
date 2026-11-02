const axios = require("axios");
const { EmbedBuilder } = require("discord.js");
const { isSignificantExtension } = require("./renewal");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
const ROLE_ID = "1371122206670852146";

function trim(text, max = 220) {
  if (!text) return "Brak opisu.";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

function formatDate(dateString) {
  if (!dateString) return "Brak danych";

  const date = new Date(dateString);

  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function extractLowestPrice(product) {
  const prices = [];

  const highlights = [
    ...(product.hero_highlights || []),
    ...(product.hover_highlights || [])
  ];

  for (const h of highlights) {
    if (!h.heading) continue;

    for (const match of h.heading.matchAll(/([$€£])\s?(\d+(?:[.,]\d+)?)/g)) {
      const numeric = Number(match[2].replace(",", "."));
      if (!Number.isFinite(numeric)) continue;
      prices.push({ raw: `${match[1]}${match[2]}`, currency: match[1], value: numeric });
    }
  }

  if (!prices.length) return "Brak danych";

  // Humble can include several regional prices in the same tile. Choose the
  // euro amount for our Polish audience instead of comparing unlike currencies.
  const euroPrices = prices.filter(price => price.currency === "€");
  const relevantPrices = euroPrices.length ? euroPrices : prices;
  relevantPrices.sort((a, b) => a.value - b.value);
  return relevantPrices[0].raw;
}

function getGameBundleLink(product) {
  if (product.category !== "bundle") return null;
  if (!product.product_url?.startsWith("/games/")) return null;

  return `https://www.humblebundle.com${product.product_url}`;
}

function normalizeBundleName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(bundle|collection|edition|games?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function findSimilarBundle(history, title) {
  const normalized = normalizeBundleName(title);
  if (!normalized) return null;

  const words = new Set(normalized.split(" ").filter(word => word.length > 2));
  let best = null;
  let bestScore = 0;

  for (const entry of history) {
    const previous = normalizeBundleName(entry.title);
    if (!previous) continue;
    if (previous === normalized) return entry;

    const previousWords = new Set(previous.split(" ").filter(word => word.length > 2));
    const intersection = [...words].filter(word => previousWords.has(word)).length;
    const score = intersection / Math.max(words.size, previousWords.size, 1);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return bestScore >= 0.7 ? best : null;
}

function normalizeBundleLink(link) {
  try {
    const url = new URL(link);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(link || "").replace(/\/$/, "");
  }
}

function getBundleEndDate(product) {
  const knownKeys = [
    "end_date", "enddate", "end_date|datetime", "expiration_date",
    "expirationdate", "expires_at", "expiresat", "sale_end_date",
    "saleenddate", "available_valid_to", "available_valid_until",
    "valid_to", "valid_until", "ends_at", "expiry_date"
  ];
  const normalizedKnownKeys = new Set(knownKeys.map(key => key.toLowerCase().replace(/[^a-z]/g, "")));
  const candidates = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, "");
      if (normalizedKnownKeys.has(normalizedKey) && child != null && child !== "") {
        candidates.push(child);
      }
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(product);

  const value = candidates[0] ||
    product.end_date ||
    product.endDate ||
    product.expiration_date ||
    product.expires_at ||
    product.sale_end_date ||
    product.saleEndDate ||
    null;
  if (!value) return null;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 100000000000 ? numeric * 1000 : numeric)
    : Date.parse(value);
  const date = new Date(timestamp);
  return Number.isFinite(timestamp) && !Number.isNaN(date.getTime()) && date.getUTCFullYear() <= 2100
    ? date.toISOString()
    : null;
}

async function getBundleEndDateFromPage(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, content] of scripts) {
      const source = content.trim();
      if (!source.startsWith("{") && !source.startsWith("[")) continue;
      try {
        const endDate = getBundleEndDate(JSON.parse(source));
        if (endDate) return endDate;
      } catch {
        // Ignore non-JSON script blocks and continue through the page data.
      }
    }
  } catch (error) {
    console.log("Humble: nie udało się odczytać terminu ze strony bundle:", error.message);
  }
  return null;
}

function isBundleExtension(previousEndDate, currentEndDate) {
  return isSignificantExtension(previousEndDate, currentEndDate);
}

function pruneInactiveHumbleBundles(savedData, currentLinks, saveData) {
  if (!currentLinks.length) return;

  const current = new Set(currentLinks);
  const previous = savedData.humbleBundles || [];
  const next = [...new Set(previous)].filter(link => current.has(link));

  if (
    previous.length !== next.length ||
    previous.some((link, index) => link !== next[index])
  ) {
    savedData.humbleBundles = next;
    saveData();

    console.log(
      `🧹 Humble: wyczyszczono nieaktywne bundle=${previous.length - next.length}`
    );
  }
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Humble: start sprawdzania");

    const channel = await client.channels.fetch(CHANNEL_ID);

    /* =========================
       🎮 HUMBLE GAMES
    ========================= */

    if (!savedData.humbleBundles) savedData.humbleBundles = [];
    if (!Array.isArray(savedData.humbleBundleHistory)) savedData.humbleBundleHistory = [];

    const { data: gamesHtml } = await axios.get(
      "https://www.humblebundle.com/games",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const scripts = [
      ...gamesHtml.matchAll(
        /<script[^>]*application\/json[^>]*>(.*?)<\/script>/gs
      )
    ];

    if (scripts[1]) {
      const json = JSON.parse(scripts[1][1]);
      const mosaic = json?.data?.games?.mosaic || [];
      const currentLinks = [];

      for (const section of mosaic) {
        if (!section.products) continue;

        for (const product of section.products) {
          const link = getGameBundleLink(product);

          if (link) currentLinks.push(link);
        }
      }

      pruneInactiveHumbleBundles(savedData, currentLinks, saveData);

      for (const section of mosaic) {
        if (!section.products) continue;

        for (const product of section.products) {
          const link = getGameBundleLink(product);

          if (!link) continue;

          const title = product.tile_name;
          const normalizedLink = normalizeBundleLink(link);
          const wasActive = savedData.humbleBundles.some(
            existing => normalizeBundleLink(existing) === normalizedLink
          );
          const similarBundle = findSimilarBundle(savedData.humbleBundleHistory, title);
          const previousRecord = [...savedData.humbleBundleHistory]
            .reverse()
            .find(entry => normalizeBundleLink(entry.url) === normalizedLink);
          // A renewal must be the same listing; a similar title can be a new bundle.
          const renewalRecord = previousRecord;
          let endDate = getBundleEndDate(product);
          if (!endDate) endDate = await getBundleEndDateFromPage(link);
          const extension = isBundleExtension(renewalRecord?.expiresAt, endDate);
          if ((wasActive || previousRecord) && !extension) continue;

          const description =
            product.short_marketing_blurb ||
            product.marketing_blurb ||
            "";

          const image =
            product.high_res_tile_image ||
            product.tile_image ||
            null;

          const price = extractLowestPrice(product);

          const embed = new EmbedBuilder()
            .setTitle(`🔥 ${title}`)
            .setURL(link)
            .setColor(extension ? 0x2ecc71 : 0xE67E22)
            .setDescription(
              `────────────────\n${trim(description)}${similarBundle ? `\n\nPodobny bundle był już wcześniej: **${similarBundle.title}** (${formatDate(similarBundle.firstSeenAt)}).` : ""}\n────────────────`
            )
            .addFields({
              name: "💰 Cena minimalna",
              value: price,
              inline: false
            })
            .setFooter({ text: "Humble Game Bundle 🎮" })
            .setTimestamp();

          if (extension) {
            embed.addFields(
              { name: "Poprzednio do", value: formatDate(renewalRecord.expiresAt), inline: true },
              { name: "Nowy termin", value: formatDate(endDate), inline: true }
            );
          } else {
            embed.addFields({
              name: "⏳ Dostępne do",
              value: endDate ? formatDate(endDate) : "Sklep nie podał daty końca",
              inline: false
            });
          }

          if (image) embed.setImage(image);

          await channel.send({
            content: extension
              ? "🔁 **HUMBLE GAME BUNDLE PRZEDŁUŻONY**"
              : `🔥 **NOWY HUMBLE GAME BUNDLE!** <@&${ROLE_ID}>`,
            allowedMentions: extension ? { parse: [] } : { parse: [], roles: [ROLE_ID] },
            embeds: [embed]
          });

          if (!wasActive) savedData.humbleBundles.push(link);
          savedData.humbleBundles =
            [...new Set(savedData.humbleBundles)].slice(-100);

          const seenAt = new Date().toISOString();
          if (previousRecord) {
            previousRecord.lastSeenAt = seenAt;
            if (endDate) previousRecord.expiresAt = endDate;
          } else {
            savedData.humbleBundleHistory.push({
              title,
              url: link,
              firstSeenAt: seenAt,
              lastSeenAt: seenAt,
              expiresAt: endDate
            });
          }
          savedData.humbleBundleHistory = savedData.humbleBundleHistory.slice(-500);
          saveData();

          console.log("🚀 Humble GAME wysłany:", title);
        }
      }
    } else {
      console.log("❌ Humble Games: brak JSON");
    }

    /* =========================
       🎮 HUMBLE CHOICE
    ========================= */

    const { data: membershipHtml } = await axios.get(
      "https://www.humblebundle.com/membership",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const membershipScripts = [
      ...membershipHtml.matchAll(
        /<script[^>]*application\/json[^>]*>(.*?)<\/script>/gs
      )
    ];

    if (!membershipScripts[1]) {
      console.log("❌ Humble Choice: brak JSON");
      return;
    }

    const membershipJson = JSON.parse(membershipScripts[1][1]);

    const machineName = membershipJson.activeContentMachineName;
    const humanName = membershipJson.navbarOptions?.productHumanName;
    const endDateRaw =
      membershipJson.navbarOptions?.["activeContentEndDate|datetime"];
    const priceObj = membershipJson["baseSubscriptionPrice|money"];

    if (!machineName) {
      console.log("❌ Humble Choice: brak machineName");
      return;
    }

    if (savedData.humbleChoice === machineName) {
      console.log("⏸ Humble Choice: bez zmian");
      return;
    }

    savedData.humbleChoice = machineName;
    saveData();

    const price = priceObj
      ? `${priceObj.amount} ${priceObj.currency}`
      : "Brak danych";

    const endDate = formatDate(endDateRaw);

    const embed = new EmbedBuilder()
      .setTitle(`🔥 ${humanName}`)
      .setURL("https://www.humblebundle.com/membership")
      .setColor(0xF1C40F)
      .setDescription(
        `────────────────\nNowa edycja Humble Choice jest już dostępna!\n────────────────`
      )
      .addFields(
        { name: "💰 Cena", value: price, inline: true },
        { name: "⏳ Dostępne do", value: endDate, inline: true }
      )
      .setFooter({ text: "Humble Choice 🎮" })
      .setTimestamp();

    await channel.send({
      content: `🔥 **NOWY HUMBLE CHOICE!** <@&${ROLE_ID}>`,
      embeds: [embed]
    });

    console.log("🚀 Humble Choice wysłany:", humanName);

  } catch (err) {
    console.log("🔥 Humble error:", err.message);
  }
};

module.exports.isBundleExtension = isBundleExtension;
module.exports.extractLowestPrice = extractLowestPrice;
module.exports.getBundleEndDate = getBundleEndDate;
module.exports.getBundleEndDateFromPage = getBundleEndDateFromPage;
