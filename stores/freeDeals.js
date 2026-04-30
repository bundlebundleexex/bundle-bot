const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = "1499461446365352017";
const ROLE_ID = "1499461776604004392";

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
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60)));
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
    "closed beta",
    "open beta",
    "early access",
    "demo",
    "trial",
    "soundtrack",
    "artbook",
    "creator kit",
    "mod kit",
    "test server",
    "pts",
    "public test"
  ];

  return blocked.some(word => text.includes(word));
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🎁 FreeDeals: sprawdzam GOG freebies...");

    const res = await axios.get(
      "https://www.gamerpower.com/api/giveaways",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        timeout: 20000
      }
    );

    const items = res.data || [];

    savedData.freeDeals ??= [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of items) {
      if (game.status !== "Active") continue;
      if (game.type !== "Game") continue;

      const platforms = (game.platforms || "").toLowerCase();

      // tylko GOG
      if (!platforms.includes("gog")) continue;

      // filtr śmieci
      if (isBlockedOffer(game)) {
        console.log("⛔ Pomijam:", game.title);
        continue;
      }

      const giveawayId = String(game.id);

      // dedupe
      if (savedData.freeDeals.includes(giveawayId)) {
        continue;
      }

      const cleanTitle = game.title
        .replace(/\(.*?\)/g, "")
        .replace(/giveaway/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      const hoursLeft = getHoursLeft(game.end_date);

      const embed = new EmbedBuilder()
        .setTitle(cleanTitle)
        .setURL(game.open_giveaway || game.gamerpower_url)
        .setColor(0x86328A)
        .setFooter({
          text: "GOG • GamerPower"
        })
        .setDescription(
          `🟣 **GOG**\n` +
          `🎁 **Wartość:** ${game.worth}\n` +
          `⌛ **Gratis do:** ${formatDate(game.end_date)}` +
          (hoursLeft !== null
            ? `\n⏳ **Zostało:** ${hoursLeft}h`
            : "") +
          `\n\n${(game.description || "Brak opisu")
            .slice(0, 220)
            .trim()}...`
        )
        .setTimestamp();

      if (game.image) {
        embed.setImage(game.image);
      }

      await channel.send({
        content: `🎁 **NOWA DARMÓWKA NA GOG!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log(`✅ FreeDeals wysłano: ${cleanTitle}`);

      savedData.freeDeals.push(giveawayId);
      saveData();
    }

    console.log("✅ FreeDeals sprawdzony");

  } catch (err) {
    console.log(
      "❌ FreeDeals error:",
      err.response?.status || err.message
    );
  }
};