const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function trim(text, max = 600) {
  if (!text) return "";
  return text.length > max ? text.substring(0, max) + "..." : text;
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

      if (href && title.length > 3) {
        bundles.push({
          title,
          link: href.startsWith("http")
            ? href
            : `https://www.indiegala.com${href}`
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

    if (!savedData.indiegalaBundles)
      savedData.indiegalaBundles = [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const bundle of uniqueBundles) {
      if (savedData.indiegalaBundles.includes(bundle.link))
        continue;

      console.log("🔥 Nowy IndieGala bundle:", bundle.title);

      // Pobierz stronę konkretnego bundle
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

      // Próba wykrycia ceny
      const bodyText = $$.text();
      const priceMatch = bodyText.match(/\$\d+(\.\d+)?/);
      const price = priceMatch ? priceMatch[0] : "Check page";

      // Zapisz jako wysłany
      savedData.indiegalaBundles.push(bundle.link);
      savedData.indiegalaBundles = [
        ...new Set(savedData.indiegalaBundles)
      ].slice(-100);

      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🎁 ${bundle.title}`)
        .setURL(bundle.link)
        .setColor(0x9b59b6)
        .setDescription(
          `💰 Cena: **${price}**\n\n${trim(description)}`
        )
        .setFooter({ text: "IndieGala Bundle 🎮" })
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `🎉 **NOWY INDIEGALA BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 IndieGala wysłany:", bundle.title);
    }

  } catch (err) {
    console.log("🔥 IndieGala error:", err.message);
  }
};