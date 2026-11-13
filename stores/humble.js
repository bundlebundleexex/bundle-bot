const axios = require("axios");
const { EmbedBuilder } = require("discord.js");
const cheerio = require("cheerio");
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

function findChoiceImage(data, html) {
  const candidates = [];
  const walk = (value, path = "", depth = 0) => {
    if (depth > 14 || value == null) return;
    if (typeof value === "string") {
      const url = value.replace(/&amp;/g, "&").replace(/\\\//g, "/");
      if (/^(https?:)?\/\//i.test(url) && /(?:imgix|humblebundle|\.png(?:\?|$)|\.jpe?g(?:\?|$)|\.webp(?:\?|$))/i.test(url)) {
        const keyPath = path.toLowerCase();
        if (!/(logo|avatar|profile|badge|icon)/i.test(keyPath)) {
          let score = 0;
          if (/high.?res|hero|header|cover|featured/i.test(keyPath)) score += 60;
          if (/tile|image|artwork|background/i.test(keyPath)) score += 30;
          if (/hb\.imgix\.net|humblebundle/i.test(url)) score += 20;
          if (/\/offers\/|\/item\/|\/game\//i.test(path)) score += 5;
          candidates.push({ url: url.startsWith("//") ? `https:${url}` : url, score });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, path, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  walk(data);
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]?.url) return candidates[0].url;

  const $ = cheerio.load(html || "");
  const metaImage = $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content");
  return metaImage?.replace(/&amp;/g, "&") || null;
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

  for (const tier of product.tiers || []) {
    const amount = Number(tier?.price?.amount);
    const currency = String(tier?.price?.currencyCode || "");
    if (Number.isFinite(amount) && currency) {
      prices.push({ raw: `${currency === "EUR" ? "€" : currency === "USD" ? "$" : currency === "GBP" ? "£" : `${currency} `}${amount}`, currency, value: amount });
    }
  }

  if (!prices.length) return "Brak danych";

  // Humble can include several regional prices in the same tile. Choose the
  // euro amount for our Polish audience instead of comparing unlike currencies.
  const euroPrices = prices.filter(price => price.currency === "€" || price.currency === "EUR");
  const relevantPrices = euroPrices.length ? euroPrices : prices;
  relevantPrices.sort((a, b) => a.value - b.value);
  return relevantPrices[0].raw;
}

function getGameBundleLink(product) {
  const rawUrl = product?.product_url || product?.url || product?.human_url ||
    (product?.slug && String(product.bundleType || "").toLowerCase() === "games"
      ? `/games/${product.slug}`
      : null);
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, "https://www.humblebundle.com");
    if (!/(^|\.)humblebundle\.com$/i.test(url.hostname) || !url.pathname.startsWith("/games/")) return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getProductTitle(product) {
  return product?.tile_name || product?.human_name || product?.name || product?.title || null;
}

function getJsonScripts(html) {
  const $ = cheerio.load(html || "");
  const scripts = [];
  $("script").each((_, element) => {
    const node = $(element);
    const type = String(node.attr("type") || "").toLowerCase();
    const id = String(node.attr("id") || "").toLowerCase();
    const content = node.html()?.trim();
    if (!content) return;
    if (type.includes("json") || /landingpage-json-data|webpack-bundle-page-data/.test(id) || /^[{[]/.test(content)) {
      scripts.push(content);
    }
  });
  return [...new Set(scripts)];
}

function parseJsonScripts(html) {
  const payloads = [];
  for (const script of getJsonScripts(html)) {
    try { payloads.push(JSON.parse(script)); } catch {}
  }
  payloads.push(...extractNextFlightBundlePages(html));
  return payloads;
}

function parseBalancedJsonAt(text, start) {
  let index = start;
  while (/\s/.test(text[index] || "")) index++;
  if (text[index] !== "{" && text[index] !== "[") return null;
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let cursor = index; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((open === "{" && char !== "}") || (open === "[" && char !== "]")) return null;
      if (!stack.length) {
        try { return JSON.parse(text.slice(index, cursor + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function extractNextFlightBundlePages(html) {
  const $ = cheerio.load(html || "");
  const bundles = [];
  const prefix = "self.__next_f.push(";
  $("script").each((_, element) => {
    const script = $(element).html() || "";
    if (!script.startsWith(prefix)) return;
    let chunks;
    try { chunks = JSON.parse(script.slice(prefix.length, script.lastIndexOf(")"))); } catch { return; }
    const flight = typeof chunks?.[1] === "string" ? chunks[1] : "";
    let position = 0;
    while ((position = flight.indexOf('"bundlePage":', position)) !== -1) {
      const bundle = parseBalancedJsonAt(flight, position + '"bundlePage":'.length);
      if (bundle && typeof bundle === "object" && !Array.isArray(bundle) && bundle.slug && bundle.bundleType) {
        bundles.push(bundle);
      }
      position += '"bundlePage":'.length;
    }
  });
  return bundles;
}

function extractGameBundles(html) {
  const bundles = new Map();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 24) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    const link = getGameBundleLink(value);
    if (link) {
      const title = getProductTitle(value);
      if (title) bundles.set(normalizeBundleLink(link), { ...value, tile_name: title, product_url: link });
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const payload of parseJsonScripts(html)) visit(payload);

  // The redesigned landing page may render the listing as regular links
  // before it exposes bundle metadata in its embedded JSON.
  const $ = cheerio.load(html || "");
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const link = getGameBundleLink({ product_url: anchor.attr("href") });
    if (!link || bundles.has(normalizeBundleLink(link))) return;
    const slug = new URL(link).pathname.split("/").filter(Boolean).pop() || "Humble Bundle";
    const card = anchor.closest('[data-testid="product-card"]');
    const title = card.find('[data-testid="product-card-footer"] [data-testid="product-link"]').first().text().replace(/\s+/g, " ").trim() ||
      anchor.attr("title") || anchor.attr("aria-label") || anchor.text().replace(/\s+/g, " ").trim() ||
      slug.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    const hoverDescription = card.find('[data-testid="bundle-hover-titles"]').first().text().replace(/\s+/g, " ").trim();
    const image = card.find('[data-testid="product-thumbnail"] img').first().attr("src") ||
      card.find("img").first().attr("data-src") || null;
    bundles.set(normalizeBundleLink(link), {
      category: "bundle",
      product_url: link,
      tile_name: title,
      short_marketing_blurb: hoverDescription,
      tile_image: image
    });
  });
  return [...bundles.values()];
}

function findNestedValue(payloads, predicate) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 24 || seen.has(value)) return null;
    seen.add(value);
    if (!Array.isArray(value) && predicate(value)) return value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const match = visit(child, depth + 1);
      if (match) return match;
    }
    return null;
  };
  for (const payload of payloads) {
    const match = visit(payload);
    if (match) return match;
  }
  return null;
}

function getChoicePageInfo(html) {
  const $ = cheerio.load(html || "");
  const description = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
  const pageText = `${description} ${$("body").text().replace(/\s+/g, " ")}`;
  const match = pageText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\s+Humble Choice\b/i);
  if (!match) return null;
  const month = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  const year = match[2];
  const priceMatch = pageText.match(/for only\s*([€$£])\s*(\d+(?:[.,]\d+)?)/i);
  const price = priceMatch
    ? { amount: Number(priceMatch[2].replace(",", ".")), currency: priceMatch[1] === "€" ? "EUR" : priceMatch[1] === "$" ? "USD" : "GBP" }
    : null;
  return {
    machineName: `${month.toLowerCase()}_${year}_choice`,
    humanName: `${month} ${year} Humble Choice`,
    price,
    endDate: null
  };
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

async function getBundleDetailsFromPage(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const $ = cheerio.load(html || "");
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop();
    const bundlePage = parseJsonScripts(html).find(value =>
      value?.slug === slug && String(value?.bundleType || "").toLowerCase() === "games"
    );
    const pageTitle = $("meta[property='og:title']").attr("content")?.replace(/\s*\|\s*Humble Bundle\s*$/i, "") || $("h1").first().text().trim();
    const image = $("meta[property='og:image']").attr("content") || null;
    return bundlePage
      ? {
          ...bundlePage,
          tile_name: bundlePage.title || pageTitle,
          product_url: url,
          short_marketing_blurb: bundlePage.headline || $("meta[property='og:description']").attr("content") || "",
          tile_image: bundlePage.thumbnailImageUrl || image,
          end_date: bundlePage.endDate,
          start_date: bundlePage.startDate
        }
      : pageTitle
        ? { tile_name: pageTitle, product_url: url, tile_image: image }
        : null;
  } catch (error) {
    console.log("Humble: nie udało się pobrać szczegółów bundle:", error.message);
    return null;
  }
}

async function getBundleEndDateFromPage(url) {
  const details = await getBundleDetailsFromPage(url);
  return getBundleEndDate(details);
}

function normalizeHumbleImage(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://www.humblebundle.com");
    if (url.pathname === "/_next/image") {
      const original = url.searchParams.get("url");
      if (original) return original;
    }
    return url.toString();
  } catch {
    return value;
  }
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

    const gameBundles = extractGameBundles(gamesHtml);
    if (gameBundles.length) {
      const currentLinks = gameBundles.map(getGameBundleLink).filter(Boolean);

      pruneInactiveHumbleBundles(savedData, currentLinks, saveData);

      for (const product of gameBundles) {
          const link = getGameBundleLink(product);

          const title = getProductTitle(product);
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
          let pageDetails = null;
          if (!endDate) {
            pageDetails = await getBundleDetailsFromPage(link);
            endDate = getBundleEndDate(pageDetails);
          }
          const extension = isBundleExtension(renewalRecord?.expiresAt, endDate);
          if ((wasActive || previousRecord) && !extension) continue;

          const description =
            pageDetails?.short_marketing_blurb ||
            product.short_marketing_blurb ||
            product.marketing_blurb ||
            "";

          const image =
            product.high_res_tile_image ||
            product.tile_image ||
            pageDetails?.tile_image ||
            null;

          const price = extractLowestPrice(pageDetails ? { ...product, ...pageDetails } : product);

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

          if (image) embed.setImage(normalizeHumbleImage(image));

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
    } else {
      console.log("❌ Humble Games: nie znaleziono bundle w danych strony ani w linkach HTML");
    }

    /* =========================
       🎮 HUMBLE CHOICE
    ========================= */

    const { data: membershipHtml } = await axios.get(
      "https://www.humblebundle.com/membership",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const membershipJson = findNestedValue(parseJsonScripts(membershipHtml), value =>
      Boolean(value.activeContentMachineName || value.navbarOptions?.productHumanName)
    );
    const choicePageInfo = getChoicePageInfo(membershipHtml);
    if (!membershipJson && !choicePageInfo) {
      console.log("❌ Humble Choice: nie znaleziono nazwy edycji w danych strony");
      return;
    }

    const machineName = membershipJson?.activeContentMachineName || choicePageInfo.machineName;
    const humanName = membershipJson?.navbarOptions?.productHumanName || choicePageInfo.humanName;
    const endDateRaw =
      membershipJson?.navbarOptions?.["activeContentEndDate|datetime"] || choicePageInfo?.endDate;
    const priceObj = membershipJson?.["baseSubscriptionPrice|money"] || choicePageInfo?.price;
    const choiceImage = findChoiceImage(membershipJson || {}, membershipHtml);

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

    if (choiceImage) embed.setImage(choiceImage);

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
module.exports.formatDate = formatDate;
module.exports.getGameBundleLink = getGameBundleLink;
module.exports.getJsonScripts = getJsonScripts;
module.exports.parseJsonScripts = parseJsonScripts;
module.exports.extractGameBundles = extractGameBundles;
module.exports.extractNextFlightBundlePages = extractNextFlightBundlePages;
module.exports.getBundleDetailsFromPage = getBundleDetailsFromPage;
module.exports.getBundleEndDateFromPage = getBundleEndDateFromPage;
module.exports.getChoicePageInfo = getChoicePageInfo;
module.exports.getBundleEndDateFromPage = getBundleEndDateFromPage;
