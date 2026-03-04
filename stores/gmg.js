const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  try {

    console.log("🔎 GMG: sprawdzam bundles...");

    const { data: html } = await axios.get(
      "https://www.greenmangaming.com/bundles/",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html"
        },
        timeout: 20000
      }
    );

    const $ = cheerio.load(html);

    let links = $("a[href*='greenmangamingbundles.com/bundles']")
      .map((i, el) => $(el).attr("href"))
      .get();

    // 🔥 usuwamy duplikaty
    links = [...new Set(links)];

    console.log("🔗 GMG znalezione:", links.length);

    if (!links.length) {
      console.log("❌ GMG: brak bundle");
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    savedData.gmgBundles ??= [];

    for (let url of links) {

      // 🔧 normalizacja URL (usuwa końcowy /)
      url = url.replace(/\/$/, "");

      if (savedData.gmgBundles.includes(url)) {
        console.log("⏸ GMG już zapisany:", url);
        continue;
      }

      const { data: bundleHtml } = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const $$ = cheerio.load(bundleHtml);

      const bodyText = $$("body").text();

      // 🔥 pomijamy zakończone bundle
      if (
        bodyText.includes("Expired") ||
        bodyText.includes("Offer ended") ||
        bodyText.includes("ENDED")
      ) {
        console.log("⛔ Pominięty expired:", url);
        continue;
      }

      const title =
        $$("meta[property='og:title']").attr("content") ||
        $$("h1").first().text().trim();

      const description =
        $$("meta[property='og:description']").attr("content") ||
        "Sprawdź bundle.";

      const image =
        $$("meta[property='og:image']").attr("content") ||
        null;

      console.log("🔥 GMG aktywny bundle:", title);

      // zapisujemy żeby nie wysłało drugi raz
      savedData.gmgBundles.push(url);
      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🟢 ${title}`)
        .setURL(url)
        .setColor(0x2ECC71)
        .setDescription(description.substring(0, 400))
        .setFooter({ text: "Green Man Gaming Bundle 🎮" })
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `🟢 **NOWY GREEN MAN GAMING BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 GMG wysłany");

    }

  } catch (err) {

    console.log("🔥 GMG error:", err.message);

  }
};