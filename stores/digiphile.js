const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, tries = 3) {
  let lastErr;

  for (let i = 1; i <= tries; i++) {
    try {
      const res = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      });

      return res.data;
    } catch (err) {
      lastErr = err;
      console.log(`⚠️ Retry ${i}/${tries}: ${url}`);
      await sleep(1000);
    }
  }

  throw lastErr;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Digiphile: sprawdzam kolekcje...");

    const html = await fetchWithRetry(
      "https://www.digiphile.co/collections"
    );

    const $ = cheerio.load(html);

    const links = $("a[href]")
      .map((_, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .filter(href => href.includes("/collections/"))
      .map(href =>
        href.startsWith("http")
          ? href
          : `https://www.digiphile.co${href}`
      );

    const uniqueLinks = [...new Set(links)];

    console.log(`🔗 Znaleziono ${uniqueLinks.length} linków`);

    savedData.digiphileCollections ??= [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const url of uniqueLinks) {
      if (savedData.digiphileCollections.includes(url)) continue;

      let pageHtml;

      try {
        pageHtml = await fetchWithRetry(url);
      } catch {
        console.log("⛔ Failed:", url);
        continue;
      }

      const $$ = cheerio.load(pageHtml);

      const title =
        $$("h1").first().text().trim() ||
        $$("title").text().trim();

      if (!title) continue;

      const lowerTitle = title.toLowerCase();

      if (
        lowerTitle.includes("something went wrong") ||
        lowerTitle.includes("404") ||
        lowerTitle.includes("error")
      ) {
        console.log("⛔ Error page:", url);
        continue;
      }

      const visibleText = $$
        .text()
        .replace(/\s+/g, " ")
        .trim();

      if (visibleText.includes("This collection ended on")) {
        console.log("⛔ Pominięta zakończona:", url);
        continue;
      }

      const prices = [...pageHtml.matchAll(/\$(\d+)/g)]
        .map(m => Number(m[1]))
        .filter(n => n >= 1);

      const price = prices.length
        ? `$${Math.min(...prices)}`
        : null;

      const image =
        $$("meta[property='og:image']").attr("content") || null;

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
      saveData();

      console.log("🚀 Wysłano:", title);

      await sleep(1000);
    }
  } catch (err) {
    console.log("🔥 Digiphile error:", err.message);
  }
};