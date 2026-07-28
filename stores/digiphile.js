const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

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

function isKnown(savedData, url) {
  return (
    savedData.digiphileCollections.includes(url) ||
    savedData.digiphileEndedCollections.includes(url) ||
    savedData.digiphileInvalidCollections.includes(url)
  );
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

function getPrice(html) {
  const prices = [...html.matchAll(/\$(\d+(?:\.\d{1,2})?)/g)]
    .map(match => Number(match[1]))
    .filter(number => number >= 1);

  return prices.length ? `$${Math.min(...prices)}` : null;
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
    const freshLinks = uniqueLinks
      .filter(url => !isKnown(savedData, url))
      .slice(0, MAX_COLLECTIONS_PER_RUN);

    console.log(
      `🔗 Digiphile: znaleziono=${uniqueLinks.length} do_sprawdzenia=${freshLinks.length}`
    );

    if (!freshLinks.length) {
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

    for (const url of freshLinks) {
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

        if (isEndedCollection($, pageHtml)) {
          console.log("⛔ Pominięta zakończona:", url);
          savedData.digiphileEndedCollections.push(url);
          stats.ended += 1;
          trimData(savedData);
          saveData();

          continue;
        }

        const price = getPrice(pageHtml);
        const image = getImage($);

        const embed = new EmbedBuilder()
          .setTitle(`🎮 ${title}`)
          .setURL(url)
          .setColor(0x3498db)
          .setFooter({
            text: "Digiphile Steam Collection 🎮"
          })
          .setTimestamp();

        if (price) {
          embed.setDescription(`💰 Cena od: **${price}**`);
        }

        if (image) {
          embed.setImage(image);
        }

        await channel.send({
          content: `🔥 **NOWA KOLEKCJA DIGIPHILE!** <@&${ROLE_ID}>`,
          embeds: [embed]
        });

        savedData.digiphileCollections.push(url);
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
