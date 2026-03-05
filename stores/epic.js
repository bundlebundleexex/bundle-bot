const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1479058453204045955";
const ROLE_ID = "1371121977628295390";

function formatDate(dateString) {
  const date = new Date(dateString);

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

module.exports.check = async (client, savedData, saveData) => {

  console.log("🟣 Epic: sprawdzam darmowe gry...");

  const url =
    "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";

  const res = await axios.get(url);

  const elements =
    res.data.data.Catalog.searchStore.elements;

  const channel = await client.channels.fetch(CHANNEL_ID);

  for (const game of elements) {

    if (!game.promotions) continue;

    const promo =
      game.promotions.promotionalOffers?.[0]?.promotionalOffers?.[0];

    if (!promo) continue;

    const id = game.id;

    if (savedData.epicGames.includes(id)) continue;

    const title = game.title;

    const image =
      game.keyImages?.find(i => i.type === "OfferImageWide")?.url ||
      game.keyImages?.[0]?.url;

    const slug =
      game.catalogNs?.mappings?.[0]?.pageSlug ||
      game.productSlug ||
      game.urlSlug;

    const link = `https://store.epicgames.com/pl/p/${slug}`;

    const endDate = promo.endDate;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setURL(link)
      .setImage(image)
      .setColor("#2f3136")
      .setFooter({ text: "Epic Games" })
      .setDescription(`🎁 **Do odebrania do:** ${formatDate(endDate)}`);

    await channel.send({
      content: `<@&${ROLE_ID}>`,
      embeds: [embed]
    });

    console.log("🎮 Epic wysłano:", title);

    savedData.epicGames.push(id);
    saveData();
  }

  console.log("✅ Epic sprawdzony");
};