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

function isBlockedOffer(game) {
  const text = `${game.title} ${game.description || ""}`.toLowerCase();

  const blocked = [
    "dlc",
    "starter pack",
    "starter bundle",
    "founder pack",
    "founder's pack",
    "cosmetic pack",
    "skin pack",
    "weapon pack",
    "bonus pack",
    "beta access",
    "early access key",
    "closed beta",
    "open beta",
    "demo",
    "trial",
    "soundtrack",
    "artbook",
    "creator kit",
    "mod kit"
  ];

  return blocked.some(word => text.includes(word));
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🟡 EpicDeals: sprawdzam dodatkowe giveawaye...");

    // GamerPower
    const gamerPowerRes = await axios.get(
      "https://www.gamerpower.com/api/filter?platform=epic-games-store",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 20000
      }
    );

    const items = gamerPowerRes.data || [];

    // Oficjalne weekly freebies
    const epicRes = await axios.get(
      "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 20000
      }
    );

    const weeklyTitles = new Set(
      (epicRes.data?.data?.Catalog?.searchStore?.elements || [])
        .map(g => g.title?.toLowerCase().trim())
        .filter(Boolean)
    );

    savedData.epicDeals ??= [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of items) {
      // tylko aktywne
      if (game.status !== "Active") continue;

      // tylko gry
      if (game.type !== "Game") continue;

      // odfiltruj DLC / packi / beta / dodatki
      if (isBlockedOffer(game)) {
        console.log("⛔ Pomijam non-game:", game.title);
        continue;
      }

      // oczyść tytuł
      const cleanTitle = game.title
        .replace(/\(Epic Games\)/gi, "")
        .replace(/Giveaway/gi, "")
        .trim();

      // pomijamy weekly freebies
      if (weeklyTitles.has(cleanTitle.toLowerCase())) {
        console.log("⏭ Pomijam weekly:", cleanTitle);
        continue;
      }

      // dedupe
      const giveawayId = String(game.id);

      if (savedData.epicDeals.includes(giveawayId)) {
        continue;
      }

      const hoursLeft = getHoursLeft(game.end_date);

      const embed = new EmbedBuilder()
        .setTitle(cleanTitle)
        .setURL(game.open_giveaway || game.gamerpower_url)
        .setColor("#2f3136")
        .setFooter({ text: "Epic Games Deals" })
        .setDescription(
          `🖥️ **PC**\n🎁 **Wartość:** ${game.worth}\n⌛ **Gratis do:** ${formatDate(
            game.end_date
          )}${
            hoursLeft !== null
              ? `\n⏳ **Zostało:** ${hoursLeft}h`
              : ""
          }\n\n${game.description.slice(0, 220)}...`
        )
        .setTimestamp();

      if (game.image) {
        embed.setImage(game.image);
      }

      await channel.send({
        content: `🔥 **NOWA DARMÓWKA NA EPIC!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🎮 EpicDeals wysłano:", cleanTitle);

      savedData.epicDeals.push(giveawayId);
      saveData();
    }

    console.log("✅ EpicDeals sprawdzony");

  } catch (err) {
    console.log(
      "❌ EpicDeals error:",
      err.response?.status || err.message
    );
  }
};