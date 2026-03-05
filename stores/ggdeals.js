const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1479091184948482118";

module.exports.check = async (client, savedData, saveData) => {

  console.log("🟡 GG.DEALS: sprawdzam historical lows...");

  const url = "https://isthereanydeal.com/rss/deals/";

  const res = await axios.get(url);

  const $ = cheerio.load(res.data, { xmlMode: true });

  const channel = await client.channels.fetch(CHANNEL_ID);

  $("item").each(async (i, el) => {

    const title = $(el).find("title").text();
    const link = $(el).find("link").text();
    const description = $(el).find("description").text();

    if (savedData.ggdeals.includes(link)) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setURL(link)
      .setColor("#ff6600")
      .setDescription(description)
      .setFooter({ text: "GG.DEALS" });

    await channel.send({
      embeds: [embed]
    });

    console.log("📉 GG.DEALS:", title);

    savedData.ggdeals.push(link);
    saveData();

  });

  console.log("✅ GG.DEALS sprawdzony");

};