const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Digiphile: sprawdzam kolekcje (deep check)...");

    const { data: html } = await axios.get(
      "https://www.digiphile.co/collections",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      }
    );

    const $ = cheerio.load(html);

    const links = [];

    // 🔥 zbieramy tylko Steam Game Collection
    $("a[href^='/collections/']").each((_, el) => {
      const link = $(el).attr("href");
      const text = $(el).text();

      if (!link?.startsWith("/collections/")) return;
      if (!text.includes("Steam Game Collection")) return;

      links.push(`https://www.digiphile.co${link}`);
    });

    const uniqueLinks = [...new Set(links)];

    console.log(`🔗 Znaleziono ${uniqueLinks.length} linków do sprawdzenia`);

    if (!savedData.digiphileCollections)
      savedData.digiphileCollections = [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const url of uniqueLinks) {

      // 🔥 sprawdzamy stronę konkretnej kolekcji
      const { data: pageHtml } = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      });

      const pageText = pageHtml;

      // ❌ jeśli zakończona → pomijamy
      if (
        pageText.includes("Collection Ended") ||
        pageText.includes("This collection has ended")
      ) {
        console.log("⛔ Pominięta zakończona:", url);
        continue;
      }

      if (savedData.digiphileCollections.includes(url))
        continue;

      const $$ = cheerio.load(pageHtml);

      const title =
        $$("h1").first().text().trim() || "Nowa kolekcja";

      // 🔥 POPRAWNE WYCIĄGANIE CENY
      let price = null;

      const startingMatch = pageText.match(/Starting at\s*\$(\d+)/i);
      if (startingMatch) {
        price = `$${startingMatch[1]}`;
      } else {
        const allPrices = [...pageText.matchAll(/\$(\d+)/g)]
          .map(m => parseInt(m[1]))
          .filter(n => n > 1);

        if (allPrices.length) {
          price = `$${Math.min(...allPrices)}`;
        }
      }

      const image =
        $$("meta[property='og:image']").attr("content") || null;

      console.log("🔥 Nowa AKTYWNA kolekcja:", title);

      savedData.digiphileCollections.push(url);
      savedData.digiphileCollections =
        [...new Set(savedData.digiphileCollections)].slice(-100);

      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${title}`)
        .setURL(url)
        .setColor(0x3498DB)
        .setFooter({ text: "Digiphile Steam Collection 🎮" })
        .setTimestamp();

      if (price)
        embed.setDescription(`💰 Cena od: **${price}**`);

      if (image)
        embed.setImage(image);

      await channel.send({
        content: `🔥 **NOWA KOLEKCJA DIGIPHILE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 Wysłano:", title);
    }

  } catch (err) {
    console.log("🔥 Digiphile error:", err.message);
  }
};