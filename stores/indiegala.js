const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");
const { isSignificantExtension } = require("./renewal");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
// ROLE_ID już niepotrzebne, bo nie pingujemy
const BASE_URL = "https://www.indiegala.com";

function trim(text, max = 600) {
  if (!text) return "";
  return text.length > max ? text.substring(0, max) + "..." : text;
}

function getCountdownRemainingMs(text) {
  const source = String(text || "").toLowerCase();
  let days = 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  const units = /\b(?:(\d+)\s*(days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b|(days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\s*(\d+)\b)/gi;
  for (const match of source.matchAll(units)) {
    const value = Number(match[1] || match[4]);
    const unit = String(match[2] || match[3]).toLowerCase();
    if (/^(?:days?|d)$/.test(unit)) days = value;
    else if (/^(?:hours?|h)$/.test(unit)) hours = value;
    else if (/^(?:minutes?|mins?|m)$/.test(unit)) minutes = value;
    else seconds = value;
  }
  if (!days && !hours && !minutes && !seconds) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function normalizeBundleUrl(href) {
  try {
    const url = new URL(href, BASE_URL);

    url.search = "";
    url.hash = "";

    if (!url.pathname.startsWith("/bundle/")) {
      return null;
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function pruneInactiveIndiegalaBundles(savedData, currentLinks, saveData) {
  if (!currentLinks.length) return;

  const current = new Set(currentLinks);
  const previous = savedData.indiegalaBundles || [];
  const next = [
    ...new Set(
      previous
        .map(normalizeBundleUrl)
        .filter(link => link && current.has(link))
    )
  ];

  if (
    previous.length !== next.length ||
    previous.some((link, index) => link !== next[index])
  ) {
    savedData.indiegalaBundles = next;
    saveData();

    console.log(
      `🧹 IndieGala: wyczyszczono nieaktywne bundle=${previous.length - next.length}`
    );
  }
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 IndieGala: sprawdzam HTML...");

    const { data: html } = await axios.get(
      "https://www.indiegala.com/bundles",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      }
    );

    const $ = cheerio.load(html);

    const bundles = [];

    $("a[href*='/bundle/']").each((_, el) => {
      const href = $(el).attr("href");
      const title = $(el).text().trim();
      const link = normalizeBundleUrl(href);

      if (link && title.length > 3) {
        bundles.push({
          title,
          link
        });
      }
    });

    const uniqueBundles = [
      ...new Map(bundles.map(b => [b.link, b])).values()
    ];

    if (!uniqueBundles.length) {
      console.log("❌ IndieGala: brak bundle w HTML");
      return;
    }

    console.log(`✨ IndieGala: znaleziono ${uniqueBundles.length} bundle`);

    savedData.indiegalaBundles ??= [];
    savedData.indiegalaBundleExpiries ??= {};
    pruneInactiveIndiegalaBundles(
      savedData,
      uniqueBundles.map(bundle => bundle.link),
      saveData
    );

    const knownLinks = new Set(savedData.indiegalaBundles);
    const newBundles = uniqueBundles.filter(bundle => !knownLinks.has(bundle.link));
    const knownBundles = uniqueBundles.filter(bundle => knownLinks.has(bundle.link));
    const renewalLimit = Math.max(1, Number(process.env.INDIEGALA_RENEWAL_CHECK_LIMIT || 5));
    const cursor = Number(savedData.indiegalaRenewalCursor || 0) % Math.max(knownBundles.length, 1);
    const sampledKnown = knownBundles.length
      ? Array.from({ length: Math.min(renewalLimit, knownBundles.length) }, (_, index) => knownBundles[(cursor + index) % knownBundles.length])
      : [];
    savedData.indiegalaRenewalCursor = knownBundles.length
      ? (cursor + sampledKnown.length) % knownBundles.length
      : 0;
    const bundlesToCheck = [...newBundles, ...sampledKnown];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const bundle of bundlesToCheck) {
      const wasAnnounced = savedData.indiegalaBundles.includes(bundle.link);

      const { data: bundleHtml } = await axios.get(bundle.link, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      });

      const $$ = cheerio.load(bundleHtml);

      const description =
        $$("meta[property='og:description']").attr("content") ||
        "Sprawdź stronę bundle.";

      const image =
        $$("meta[property='og:image']").attr("content") ||
        null;

      const bodyText = $$.text().replace(/\s+/g, " ");
      const remainingMs = getCountdownRemainingMs(bodyText);
      const observedEndAt = remainingMs === null
        ? null
        : new Date(Date.now() + remainingMs).toISOString();
      const previousEndAt = savedData.indiegalaBundleExpiries[bundle.link]?.endAt || null;
      const extension = isSignificantExtension(previousEndAt, observedEndAt);

      if (wasAnnounced && !previousEndAt) {
        if (observedEndAt) {
          savedData.indiegalaBundleExpiries[bundle.link] = { endAt: observedEndAt };
        }
        saveData();
        continue;
      }
      if (previousEndAt && !extension) {
        if (!wasAnnounced) {
          if (observedEndAt) savedData.indiegalaBundleExpiries[bundle.link] = { endAt: observedEndAt };
          savedData.indiegalaBundles.push(bundle.link);
          saveData();
        }
        continue;
      }
      if (wasAnnounced && !extension) continue;

      console.log(extension ? "🔁 Przedłużony IndieGala bundle:" : "🔥 Nowy IndieGala bundle:", bundle.title);

      const priceMatch = bodyText.match(/\$\d+(\.\d+)?/);
      const price = priceMatch ? priceMatch[0] : "Check page";

      const embed = new EmbedBuilder()
        .setTitle(`🎁 ${bundle.title}`)
        .setURL(bundle.link)
        .setColor(extension ? 0x2ecc71 : 0x9b59b6)
        .setDescription(`${extension ? "Termin dostępności tej oferty został przedłużony.\n\n" : ""}💰 Cena: **${price}**\n\n${trim(description)}`)
        .setFooter({ text: "IndieGala Bundle 🎮" })
        .setTimestamp();

      if (extension) {
        embed.addFields(
          { name: "Poprzednio do", value: formatDate(previousEndAt), inline: true },
          { name: "Nowy termin", value: formatDate(observedEndAt), inline: true }
        );
      } else if (observedEndAt) {
        embed.addFields({ name: "⏳ Dostępne do", value: formatDate(observedEndAt), inline: false });
      }

      if (image) embed.setImage(image);

      await channel.send({
        content: extension
          ? "🔁 **PAKIET PRZEDŁUŻONY — INDIEGALA**"
          : "🎉 **NOWY INDIEGALA BUNDLE!**",
        allowedMentions: { parse: [] },
        embeds: [embed]
      });

      if (!wasAnnounced) savedData.indiegalaBundles.push(bundle.link);
      savedData.indiegalaBundles = [...new Set(savedData.indiegalaBundles)].slice(-100);
      if (observedEndAt) savedData.indiegalaBundleExpiries[bundle.link] = { endAt: observedEndAt };
      saveData();

      console.log("🚀 IndieGala wysłany:", bundle.title);
    }

  } catch (err) {
    console.log("🔥 IndieGala error:", err.message);
  }
};

module.exports.getCountdownRemainingMs = getCountdownRemainingMs;
