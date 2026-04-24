const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1479058453204045955";
const ROLE_ID = "1371121977628295390";

function formatDate(dateString) {
  if (!dateString) return "brak daty";

  const date = new Date(dateString);

  return `${String(date.getDate()).padStart(2, "0")}.${String(
    date.getMonth() + 1
  ).padStart(2, "0")}.${date.getFullYear()} ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getHoursLeft(dateString) {
  if (!dateString) return null;

  const end = new Date(dateString);
  const now = new Date();

  const hours = Math.floor((end - now) / (1000 * 60 * 60));
  return hours > 0 ? hours : 0;
}

module.exports.check = async (client, savedData, saveData) => {

  console.log("🟣 Epic: sprawdzam darmowe gry (PC)...");

  try {
    const res = await axios.get(
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions"
    );

    const elements =
      res.data.data.Catalog.searchStore.elements;

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of elements) {

      // tylko pełne gry
      if (game.offerType !== "BASE_GAME") continue;

      const price = game.price?.totalPrice;
      if (!price) continue;

      // pomiń F2P
      if (price.originalPrice === 0) continue;

      // tylko darmowe
      if (price.discountPrice !== 0) continue;

      const slug =
        game.catalogNs?.mappings?.[0]?.pageSlug ||
        game.productSlug ||
        game.urlSlug;

      if (!slug) {
        console.log("⛔ brak sluga:", game.title);
        continue;
      }

      // deduplikacja po slug
      if (savedData.epicGames.includes(slug)) continue;

      const title = game.title;

      const image =
        game.keyImages?.find(i => i.type === "OfferImageWide")?.url ||
        game.keyImages?.[0]?.url;

      const link = `https://store.epicgames.com/pl/p/${slug}`;

      const promo =
        game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];

      const endDate = promo?.endDate;
      const hoursLeft = getHoursLeft(endDate);

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setURL(link)
        .setImage(image)
        .setColor("#2f3136")
        .setFooter({ text: "Epic Games" })
        .setDescription(
          `🖥️ **PC**\n🎁 Do odebrania: ${formatDate(endDate)}${
            hoursLeft !== null ? `\n⏳ Zostało: ${hoursLeft}h` : ""
          }`
        );

      await channel.send({
        content: `<@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🎮 Epic wysłano:", title);

      savedData.epicGames.push(slug);
      saveData();
    }

    console.log("✅ Epic sprawdzony");

  } catch (err) {
    console.log("❌ Epic error:", err.message);
  }
};