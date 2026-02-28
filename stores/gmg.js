const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 GMG: sprawdzam HTML...");

    const { data: html } = await axios.get(
      "https://www.greenmangamingbundles.com/",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 20000
      }
    );

    const $ = cheerio.load(html);
    const bodyText = $("body").text();

    // 🔥 Jeśli Coming Soon → brak bundle
    if (bodyText.includes("COMING SOON")) {
      console.log("⏸ GMG: Coming Soon – brak aktywnego bundle");
      return;
    }

    const title =
      $("h1").first().text().trim() ||
      $("h2").first().text().trim() ||
      null;

    if (!title) {
      console.log("❌ GMG: brak tytułu bundle");
      return;
    }

    // 🔥 Sprawdzamy czy już wysłany
    if (savedData.gmg === title) {
      console.log("⏸ GMG: bez zmian");
      return;
    }

    const description =
      $("meta[property='og:description']").attr("content") ||
      "Sprawdź stronę bundle.";

    const image =
      $("meta[property='og:image']").attr("content") ||
      null;

    console.log("🔥 Nowy GMG bundle:", title);

    savedData.gmg = title;
    saveData();

    const channel = await client.channels.fetch(CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setTitle(`🟢 ${title}`)
      .setURL("https://www.greenmangamingbundles.com/")
      .setColor(0x2ECC71)
      .setDescription(description.substring(0, 400))
      .setFooter({ text: "Green Man Gaming Bundle 🎮" })
      .setTimestamp();

    if (image) embed.setImage(image);

    await channel.send({
      content: `🟢 **NOWY GMG BUNDLE!** <@&${ROLE_ID}>`,
      embeds: [embed]
    });

    console.log("🚀 GMG wysłany");

  } catch (err) {
    console.log("🔥 GMG error:", err.message);
  }
};