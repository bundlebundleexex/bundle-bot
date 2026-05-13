const axios = require("axios");

const http = require("http");

const https = require("https");

const {
  EmbedBuilder
} = require("discord.js");

const CHANNEL_ID =
  "1479058453204045955";

const ROLE_ID =
  "1371121977628295390";

// ==========================
// AXIOS
// ==========================

const axiosInstance =
  axios.create({
    timeout: 15000,

    httpAgent:
      new http.Agent({
        keepAlive: false
      }),

    httpsAgent:
      new https.Agent({
        keepAlive: false
      }),

    headers: {
      "User-Agent":
        "Mozilla/5.0"
    }
  });

// ==========================
// HELPERS
// ==========================

function formatDate(
  dateString
) {
  if (!dateString) {
    return "brak daty";
  }

  const date =
    new Date(dateString);

  return `${String(
    date.getDate()
  ).padStart(2, "0")}.${String(
    date.getMonth() + 1
  ).padStart(
    2,
    "0"
  )}.${date.getFullYear()} ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function getHoursLeft(
  dateString
) {
  if (!dateString) {
    return null;
  }

  const diff =
    new Date(dateString) -
    Date.now();

  return Math.max(
    0,
    Math.floor(
      diff / 3600000
    )
  );
}

function isBlockedOffer(
  game
) {
  const text =
    `${game.title || ""} ${game.description || ""}`.toLowerCase();

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

  return blocked.some(
    word =>
      text.includes(word)
  );
}

// ==========================
// MAIN CHECK
// ==========================

module.exports.check =
  async (
    client,
    savedData,
    saveData
  ) => {
    try {
      console.log(
        "🟡 EpicDeals: sprawdzam dodatkowe giveawaye..."
      );

      const [
        gamerPowerRes,

        epicRes
      ] = await Promise.all([
        axiosInstance.get(
          "https://www.gamerpower.com/api/filter?platform=epic-games-store"
        ),

        axiosInstance.get(
          "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions"
        )
      ]);

      const items =
        gamerPowerRes.data ||
        [];

      const weeklyTitles =
        new Set(
          (
            epicRes.data?.data
              ?.Catalog
              ?.searchStore
              ?.elements || []
          )
            .map(g =>
              g.title
                ?.toLowerCase()
                .trim()
            )
            .filter(Boolean)
        );

      savedData.epicDeals ??=
        [];

      const known =
        new Set(
          savedData.epicDeals
        );

      const fresh = [];

      for (const game of items) {
        try {
          if (
            game.status !==
            "Active"
          ) {
            continue;
          }

          if (
            game.type !==
            "Game"
          ) {
            continue;
          }

          if (
            isBlockedOffer(
              game
            )
          ) {
            continue;
          }

          const cleanTitle =
            (
              game.title ||
              ""
            )
              .replace(
                /\(Epic Games\)/gi,
                ""
              )

              .replace(
                /Giveaway/gi,
                ""
              )

              .trim();

          if (!cleanTitle) {
            continue;
          }

          if (
            weeklyTitles.has(
              cleanTitle.toLowerCase()
            )
          ) {
            continue;
          }

          const giveawayId =
            String(
              game.id
            );

          if (
            known.has(
              giveawayId
            )
          ) {
            continue;
          }

          fresh.push({
            ...game,

            cleanTitle,

            giveawayId
          });
        } catch {}
      }

      if (!fresh.length) {
        console.log(
          "⏸ EpicDeals: bez zmian"
        );

        return;
      }

      const channel =
        await client.channels.fetch(
          CHANNEL_ID
        );

      for (const game of fresh) {
        try {
          const hoursLeft =
            getHoursLeft(
              game.end_date
            );

          const desc = (
            game.description ||
            ""
          ).slice(0, 220);

          const embed =
            new EmbedBuilder()
              .setTitle(
                game.cleanTitle
              )

              .setURL(
                game.open_giveaway ||
                  game.gamerpower_url
              )

              .setColor(
                "#2f3136"
              )

              .setFooter({
                text:
                  "Epic Games Deals"
              })

              .setDescription(
                `🖥️ **PC**
🎁 **Wartość:** ${game.worth}
⌛ **Gratis do:** ${formatDate(game.end_date)}${
  hoursLeft !== null
    ? `\n⏳ **Zostało:** ${hoursLeft}h`
    : ""
}

${desc}${
  game.description
    ?.length > 220
    ? "..."
    : ""
}`
              )

              .setTimestamp();

          if (game.image) {
            embed.setImage(
              game.image
            );
          }

          await channel.send({
            content: `🔥 **NOWA DARMÓWKA NA EPIC!** <@&${ROLE_ID}>`,

            embeds: [embed]
          });

          console.log(
            "🎮 EpicDeals wysłano:",
            game.cleanTitle
          );

          savedData.epicDeals.push(
            game.giveawayId
          );
        } catch (e) {
          console.log(
            "EpicDeals item error:",
            e.message
          );
        }
      }

      savedData.epicDeals =
        [
          ...new Set(
            savedData.epicDeals
          )
        ].slice(-500);

      saveData();

      global.gc?.();

      console.log(
        "✅ EpicDeals sprawdzony"
      );
    } catch (err) {
      console.log(
        "❌ EpicDeals error:",
        err.response
          ?.status ||
          err.message
      );
    }
  };