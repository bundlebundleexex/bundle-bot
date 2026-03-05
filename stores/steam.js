const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.DEALS_CHANNEL_ID;
const ROLE_ID = "1371121790046437448";

module.exports.check = async (client, savedData, saveData) => {

  console.log("🟦 Steam: sprawdzam gry -100%...");

  const url = "https://store.steampowered.com/search/results/?query&specials=1&json=1";

  const res = await axios.get(url);

  const games = res.data.items;

  const channel = await client.channels.fetch(CHANNEL_ID);

  for (const game of games) {

    if (game.discount !== 100) continue;

    const id = game.id;

    if (savedData.steamGames.includes(id)) continue;

    const title = game.name;

    const image = game.tiny_image;

    const link = `https://store.steampowered.com/app/${id}`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setURL(link)
      .setColor("#1b2838")
      .setImage(image)
      .setDescription("🎁 **Gra przeceniona na -100% na Steam**")
      .setFooter({ text: "Steam" });

    await channel.send({
      content: `<@&${ROLE_ID}>`,
      embeds: [embed]
    });

    console.log("🎮 Steam wysłano:", title);

    savedData.steamGames.push(id);
    saveData();
  }

  console.log("✅ Steam sprawdzony");
};