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

  const diff = new Date(dateString) - new Date();
  const hours = Math.floor(diff / (1000 * 60 * 60));

  return Math.max(0, hours);
}

function getSlug(game) {
  return (
    game.catalogNs?.mappings?.[0]?.pageSlug ||
    game.productSlug?.replace("/home", "") ||
    game.urlSlug ||
    null
  );
}

function hasBlockedCategory(game) {
  const categories = (game.categories || []).map(c => c.path.toLowerCase());

  // dodatki / mody / inne śmieci
  if (categories.some(c => c.startsWith("addons"))) return true;
  if (categories.some(c => c.includes("mods"))) return true;

  return false;
}

function looksLikeTool(game) {
  const text = JSON.stringify(game.customAttributes || []).toLowerCase();

  return (
    text.includes("creator") ||
    text.includes("tool") ||
    text.includes("editor") ||
    text.includes("kit")
  );
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🟣 Epic: sprawdzam darmowe gry...");

    const res = await axios.get(
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 30000
      }
    );

    const elements =
      res.data?.data?.Catalog?.searchStore?.elements || [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    savedData.epicGames ??= [];

    for (const game of elements) {
      // tylko pełne gry
      if (game.offerType !== "BASE_GAME") continue;

      // wytnij dodatki / mody
      if (hasBlockedCategory(game)) continue;

      // creator kit / tools
      if (looksLikeTool(game)) continue;

      const price = game.price?.totalPrice;
      if (!price) continue;

      // permanent free → skip
      if (price.originalPrice <= 0) continue;

      // nie darmowe → skip
      if (price.discountPrice !== 0) continue;

      // aktywne promo
      const promos =
        game.promotions?.promotionalOffers?.flatMap(
          p => p.promotionalOffers || []
        ) || [];

      if (!promos.length) continue;

      const now = new Date();

      const activePromo = promos.find(p => {
        const start = new Date(p.startDate);
        const end = new Date(p.endDate);

        return now >= start && now < end;
      });

      if (!activePromo) continue;

      const slug = getSlug(game);
      if (!slug) continue;

      // unikalny giveaway
      const promoId =
        `${slug}_${activePromo.startDate}_${activePromo.endDate}`;

      if (savedData.epicGames.includes(promoId)) {
        continue;
      }

      const image =
        game.keyImages?.find(i => i.type === "OfferImageWide")?.url ||
        game.keyImages?.[0]?.url ||
        null;

      const endDate = activePromo.endDate;
      const hoursLeft = getHoursLeft(endDate);

      const embed = new EmbedBuilder()
        .setTitle(game.title)
        .setURL(`https://store.epicgames.com/pl/p/${slug}`)
        .setColor("#2f3136")
        .setFooter({ text: "Epic Games" })
        .setDescription(
          `🖥️ **PC**\n⌛ **Gratis do:** ${formatDate(endDate)}${
            hoursLeft !== null ? `\n⏳ **Zostało:** ${hoursLeft}h` : ""
          }`
        )
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `<@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🎮 Epic wysłano:", game.title);

      savedData.epicGames.push(promoId);
      saveData();
    }

    console.log("✅ Epic sprawdzony");

  } catch (err) {
    console.log("❌ Epic error:", err.message);
  }
};