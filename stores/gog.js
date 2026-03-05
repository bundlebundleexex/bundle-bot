const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1479078345382559804";

module.exports.check = async (client, savedData, saveData) => {

  console.log("🟢 GOG: sprawdzam darmowe gry...");

  const url = "https://catalog.gog.com/v1/catalog?limit=100&price=between:0,0";

  const res = await axios.get(url);

  const products = res.data.products;

  const channel = await client.channels.fetch(CHANNEL_ID);

  for (const game of products) {

    if (game.isDlc) continue;
    if (game.isDemo) continue;
    if (game.type !== "GAME") continue;

    const basePrice = game.price?.baseAmount;

    if (!basePrice || basePrice === 0) continue;

    const id = game.id;

    if (savedData.gogGames.includes(id)) continue;

    const title = game.title;

    const image =
      game._links?.image?.href ||
      game._links?.boxArtImage?.href;

    const link = `https://www.gog.com/en/game/${game.slug}`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setURL(link)
      .setColor("#86328A")
      .setImage(image)
      .setDescription("🎁 **Darmowa gra na GOG**")
      .setFooter({ text: "GOG" });

    await channel.send({
      embeds: [embed]
    });

    console.log("🎮 GOG wysłano:", title);

    savedData.gogGames.push(id);
    saveData();
  }

  console.log("✅ GOG sprawdzony");
};