const axios = require("axios");
const cheerio = require("cheerio");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = "1479078345382559804";
const ROLE_ID = "1371121790046437448";

module.exports.check = async (client, savedData, saveData) => {

  try {

    console.log("🟦 Steam: sprawdzam darmowe gry...");

    const { data: html } = await axios.get(
      "https://store.steampowered.com/search/?specials=1&maxprice=free&hidef2p=1",
      {
        headers: { "User-Agent": "Mozilla/5.0" }
      }
    );

    const $ = cheerio.load(html);

    if (!savedData.steamGames)
      savedData.steamGames = [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    const games = [];

    $(".search_result_row").each((_, el) => {

      const discount = $(el)
        .find(".discount_pct")
        .text()
        .trim();

      if (discount !== "-100%")
        return;

      const appid = $(el).attr("data-ds-appid");
      const title = $(el).find(".title").text().trim();

      if (!appid)
        return;

      games.push({ appid, title });

    });

    console.log("🎮 Darmowe gry Steam:", games.length);

    for (const game of games) {

      if (savedData.steamGames.includes(game.appid))
        continue;

      const { data } = await axios.get(
        `https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=us&l=en`,
        {
          headers: { "User-Agent": "Mozilla/5.0" }
        }
      );

      const info = data[game.appid]?.data;

      if (!info?.price_overview)
        continue;

      const url = `https://store.steampowered.com/app/${game.appid}`;

      const embed = new EmbedBuilder()
        .setColor(0x1b2838)
        .setTitle(info.name)
        .setURL(url)
        .setDescription(
          "🎮 **DARMOWA GRA DO ODEBRANIA!!**"
        )
        .setImage(info.header_image)
        .setFooter({
          text: "Steam Free Game 🎮"
        })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(

        new ButtonBuilder()
          .setLabel("Open in browser")
          .setStyle(ButtonStyle.Link)
          .setURL(url),

        new ButtonBuilder()
          .setLabel("Open in Steam client")
          .setStyle(ButtonStyle.Link)
          .setURL(url)

      );

      await channel.send({
        content: ` **🎮NOWA DARMOWA GRA NA STEAM!** <@&${ROLE_ID}>`,
        embeds: [embed],
        components: [row]
      });

      console.log("✔ Wysłano:", info.name);

      savedData.steamGames.push(game.appid);

      savedData.steamGames =
        [...new Set(savedData.steamGames)].slice(-200);

      saveData();

    }

  }

  catch (err) {

    console.log("❌ Steam error:", err.message);

  }

};