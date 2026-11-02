const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");
const { isSignificantExtension } = require("./renewal");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
const ROLE_ID = "1371122206670852146";

const BASE_URL = "https://www.digiphile.co";
const COLLECTIONS_URL = `${BASE_URL}/collections`;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_COLLECTIONS_PER_RUN = Number(process.env.DIGIPHILE_MAX_PER_RUN || 12);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const axiosInstance = axios.create({
  timeout: 20000,
  maxContentLength: MAX_HTML_BYTES,
  maxBodyLength: MAX_HTML_BYTES,
  decompress: true,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
});

async function fetchWithRetry(url, tries = 3, signal) {
  let lastErr;

  for (let i = 1; i <= tries; i++) {
    try {
      const res = await axiosInstance.get(url, {
        responseType: "text",
        transformResponse: [data => data],
        signal
      });

      return String(res.data || "");
    } catch (err) {
      lastErr = err;

      if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
        throw err;
      }

      console.log(`⚠️ Digiphile retry ${i}/${tries}: ${url}`);
      await sleep(1000);
    }
  }

  throw lastErr;
}

function normalizeUrl(href) {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, BASE_URL);

    url.hash = "";
    url.search = "";

    if (!url.pathname.startsWith("/collections/")) {
      return null;
    }

    if (url.pathname === "/collections") {
      return null;
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function ensureData(savedData) {
  savedData.digiphileCollections ??= [];
  savedData.digiphileEndedCollections ??= [];
  savedData.digiphileInvalidCollections ??= [];
  savedData.digiphileCollectionExpiries ??= {};
}

function trimData(savedData) {
  savedData.digiphileCollections = [
    ...new Set(savedData.digiphileCollections)
  ].slice(-500);

  savedData.digiphileEndedCollections = [
    ...new Set(savedData.digiphileEndedCollections)
  ].slice(-500);

  savedData.digiphileInvalidCollections = [
    ...new Set(savedData.digiphileInvalidCollections)
  ].slice(-200);
}

function keepVisibleUrls(urls, currentUrlSet) {
  return [
    ...new Set(
      (urls || [])
        .map(normalizeUrl)
        .filter(url => url && currentUrlSet.has(url))
    )
  ];
}

function pruneMissingCollections(savedData, currentUrls) {
  if (!currentUrls.length) {
    return {
      changed: false,
      removed: 0
    };
  }

  const currentUrlSet = new Set(currentUrls);
  let removed = 0;
  let changed = false;

  for (const key of [
    "digiphileCollections",
    "digiphileEndedCollections",
    "digiphileInvalidCollections"
  ]) {
    const previous = savedData[key] || [];
    const next = keepVisibleUrls(previous, currentUrlSet);

    removed += previous.length - next.length;

    if (
      previous.length !== next.length ||
      previous.some((url, index) => url !== next[index])
    ) {
      savedData[key] = next;
      changed = true;
    }
  }

  return {
    changed,
    removed
  };
}

function isKnown(savedData, url) {
  return savedData.digiphileCollections.includes(url);
}

function extractCollectionLinks(html) {
  const $ = cheerio.load(html, null, false);

  try {
    return [
      ...new Set(
        $("a[href]")
          .map((_, el) => normalizeUrl($(el).attr("href")))
          .get()
          .filter(Boolean)
      )
    ];
  } finally {
    $.root().empty();
  }
}

function getTitle($) {
  return $("h1").first().text().trim() || $("title").text().trim();
}

function isErrorTitle(title) {
  const lowerTitle = String(title || "").toLowerCase();

  return (
    lowerTitle.includes("something went wrong") ||
    lowerTitle.includes("404") ||
    lowerTitle.includes("error")
  );
}

function isEndedCollection($, html) {
  const bodyText = $("body").text();

  return (
    bodyText.includes("This collection ended on") ||
    html.includes("This collection ended on")
  );
}

function getCollectionEndDate($, html) {
  const text = `${$("body").text()} ${String(html || "")}`.replace(/\s+/g, " ");
  const match = text.match(/This collection (?:ends|ended) on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!match) return null;
  const timestamp = Date.parse(match[1].replace(/\s+at\s+/i, " "));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isExtendedEndDate(previousEndDate, currentEndDate) {
  return isSignificantExtension(previousEndDate, currentEndDate);
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Brak danych";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function parseDollarAmount(text) {
  const match = String(text || "").match(/\$(\d+(?:\.\d{1,2})?)/);

  return match ? Number(match[1]) : null;
}

function getPrice($) {
  const tierHeader = $("h4")
    .filter((_, el) => $(el).text().includes("Select Collection Tier"))
    .first();

  if (tierHeader.length) {
    const tierPrices = tierHeader
      .parent()
      .find("button")
      .map((_, el) => parseDollarAmount($(el).text()))
      .get()
      .filter(number => Number.isFinite(number) && number > 0);

    if (tierPrices.length) {
      return formatPrice(Math.min(...tierPrices));
    }
  }

  const startingAtMatch = $("body")
    .text()
    .replace(/\s+/g, " ")
    .match(/Starting at\s+\$(\d+(?:\.\d{1,2})?)/i);

  return startingAtMatch ? formatPrice(Number(startingAtMatch[1])) : null;
}

function getImage($) {
  return (
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    null
  );
}

// ==========================
// MAIN CHECK
// ==========================

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("🔎 Digiphile: sprawdzam kolekcje...");

    ensureData(savedData);

    const html = await fetchWithRetry(COLLECTIONS_URL, 3, options.signal);
    const uniqueLinks = extractCollectionLinks(html);
    const cleanup = pruneMissingCollections(savedData, uniqueLinks);

    if (cleanup.changed) {
      trimData(savedData);
      saveData();

      console.log(
        `🧹 Digiphile: wyczyszczono nieaktywne kolekcje=${cleanup.removed}`
      );
    }

    const newLinks = uniqueLinks.filter(url => !isKnown(savedData, url));
    const knownLinks = uniqueLinks.filter(url => isKnown(savedData, url));
    const newBatch = newLinks.slice(0, MAX_COLLECTIONS_PER_RUN);
    const knownCapacity = Math.max(0, MAX_COLLECTIONS_PER_RUN - newBatch.length);
    const cursor = Number(savedData.digiphileRenewalCursor || 0) % Math.max(knownLinks.length, 1);
    const knownBatch = knownLinks.length && knownCapacity
      ? Array.from({ length: Math.min(knownCapacity, knownLinks.length) }, (_, index) => knownLinks[(cursor + index) % knownLinks.length])
      : [];
    savedData.digiphileRenewalCursor = knownLinks.length
      ? (cursor + knownBatch.length) % knownLinks.length
      : 0;
    const linksToCheck = [...newBatch, ...knownBatch];

    console.log(
      `🔗 Digiphile: znaleziono=${uniqueLinks.length} do_sprawdzenia=${linksToCheck.length}`
    );

    if (!linksToCheck.length) {
      console.log("⏸ Digiphile: bez zmian");

      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    const stats = {
      sent: 0,
      ended: 0,
      invalid: 0,
      failed: 0
    };

    for (const url of linksToCheck) {
      let pageHtml = "";
      let $ = null;

      try {
        pageHtml = await fetchWithRetry(url, 2, options.signal);
        $ = cheerio.load(pageHtml, null, false);

        const title = getTitle($);

        if (!title || isErrorTitle(title)) {
          console.log("⛔ Digiphile error page:", url);
          savedData.digiphileInvalidCollections.push(url);
          stats.invalid += 1;
          trimData(savedData);
          saveData();

          continue;
        }

        const endDate = getCollectionEndDate($, pageHtml);
        const wasAnnounced = isKnown(savedData, url);
        const previousEndDate = savedData.digiphileCollectionExpiries[url]?.endAt || null;
        const extension = isExtendedEndDate(previousEndDate, endDate);

        if (isEndedCollection($, pageHtml)) {
          console.log("⛔ Pominięta zakończona:", url);
          if (endDate) savedData.digiphileCollectionExpiries[url] = { endAt: endDate };
          savedData.digiphileEndedCollections.push(url);
          stats.ended += 1;
          trimData(savedData);
          saveData();

          continue;
        }

        if (wasAnnounced && !previousEndDate) {
          if (endDate) savedData.digiphileCollectionExpiries[url] = { endAt: endDate };
          saveData();
          continue;
        }
        if (previousEndDate && !extension) {
          if (!wasAnnounced) {
            if (endDate) savedData.digiphileCollectionExpiries[url] = { endAt: endDate };
            savedData.digiphileCollections.push(url);
            trimData(savedData);
            saveData();
          }
          continue;
        }
        if (wasAnnounced && !extension) continue;

        const price = getPrice($);
        const image = getImage($);

        const embed = new EmbedBuilder()
          .setTitle(`🎮 ${title}`)
          .setURL(url)
          .setColor(extension ? 0x2ecc71 : 0x3498db)
          .setFooter({
            text: "Digiphile Steam Collection 🎮"
          })
          .setTimestamp();

        if (price) {
          embed.setDescription(`💰 Cena od: **${price}**`);
        }

        if (extension) {
          embed.setDescription("Termin dostępności tej kolekcji został przedłużony.");
          embed.addFields(
            { name: "Poprzednio do", value: formatDate(previousEndDate), inline: true },
            { name: "Nowy termin", value: formatDate(endDate), inline: true }
          );
        } else if (endDate) {
          embed.addFields({ name: "⏳ Dostępne do", value: formatDate(endDate), inline: false });
        }

        if (image) {
          embed.setImage(image);
        }

        await channel.send({
          content: extension
            ? "🔁 **KOLEKCJA PRZEDŁUŻONA — DIGIPHILE**"
            : `🔥 **NOWA KOLEKCJA DIGIPHILE!** <@&${ROLE_ID}>`,
          allowedMentions: extension ? { parse: [] } : { parse: [], roles: [ROLE_ID] },
          embeds: [embed]
        });

        savedData.digiphileCollections.push(url);
        if (endDate) savedData.digiphileCollectionExpiries[url] = { endAt: endDate };
        stats.sent += 1;
        trimData(savedData);
        saveData();

        console.log("🚀 Digiphile wysłano:", title);

        await sleep(1000);
      } catch (err) {
        if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
          throw err;
        }

        stats.failed += 1;
        console.log("⛔ Digiphile failed:", url, err.message);
      } finally {
        if ($) {
          $.root().empty();
        }

        pageHtml = "";
      }
    }

    trimData(savedData);
    saveData();

    global.gc?.();

    console.log(
      `✅ Digiphile: sent=${stats.sent} ended=${stats.ended} invalid=${stats.invalid} failed=${stats.failed}`
    );
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("🔥 Digiphile error:", err.message);
  }
};

module.exports.getCollectionEndDate = getCollectionEndDate;
module.exports.isExtendedEndDate = isExtendedEndDate;
