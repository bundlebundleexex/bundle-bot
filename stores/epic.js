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

function getSlug(game) {
  return (
    game.catalogNs
      ?.mappings?.[0]
      ?.pageSlug ||
    game.productSlug?.replace(
      "/home",
      ""
    ) ||
    game.urlSlug ||
    null
  );
}

function hasBlockedCategory(
  game
) {
  const categories =
    (
      game.categories || []
    ).map(c =>
      c.path.toLowerCase()
    );

  return categories.some(
    c =>
      c.startsWith(
        "addons"
      ) ||
      c.includes("mods")
  );
}

function looksLikeTool(
  game
) {
  const text =
    JSON.stringify(
      game.customAttributes ||
        []
    ).toLowerCase();

  return (
    text.includes(
      "creator"
    ) ||
    text.includes("tool") ||
    text.includes(
      "editor"
    ) ||
    text.includes("kit")
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
        "🟣 Epic: sprawdzam darmowe gry..."
      );

      const res =
        await axiosInstance.get(
          "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions"
        );

      const elements =
        res.data?.data
          ?.Catalog
          ?.searchStore
          ?.elements || [];

      savedData.epicGames ??=
        [];

      const known =
        new Set(
          savedData.epicGames
        );

      const fresh = [];

      const now =
        new Date();

      for (const game of elements) {
        try {
          if (
            game.offerType !==
            "BASE_GAME"
          ) {
            continue;
          }

          if (
            hasBlockedCategory(
              game
            )
          ) {
            continue;
          }

          if (
            looksLikeTool(
              game
            )
          ) {
            continue;
          }

          const price =
            game.price
              ?.totalPrice;

          if (!price) {
            continue;
          }

          if (
            price.originalPrice <=
            0
          ) {
            continue;
          }

          if (
            price.discountPrice !==
            0
          ) {
            continue;
          }

          const promos =
            game.promotions
              ?.promotionalOffers
              ?.flatMap(
                p =>
                  p.promotionalOffers ||
                  []
              ) || [];

          const activePromo =
            promos.find(
              p => {
                const start =
                  new Date(
                    p.startDate
                  );

                const end =
                  new Date(
                    p.endDate
                  );

                return (
                  now >=
                    start &&
                  now < end
                );
              }
            );

          if (
            !activePromo
          ) {
            continue;
          }

          const slug =
            getSlug(game);

          if (!slug) {
            continue;
          }

          const promoId =
            `${slug}_${activePromo.startDate}_${activePromo.endDate}`;

          if (
            known.has(
              promoId
            )
          ) {
            continue;
          }

          fresh.push({
            game,

            slug,

            promoId,

            activePromo
          });
        } catch {}
      }

      if (!fresh.length) {
        console.log(
          "⏸ Epic: bez zmian"
        );

        return;
      }

      const channel =
        await client.channels.fetch(
          CHANNEL_ID
        );

      for (const item of fresh) {
        try {
          const {
            game,

            slug,

            promoId,

            activePromo
          } = item;

          const image =
            game.keyImages?.find(
              i =>
                i.type ===
                "OfferImageWide"
            )?.url ||
            game.keyImages?.[0]
              ?.url ||
            null;

          const hoursLeft =
            getHoursLeft(
              activePromo.endDate
            );

          const embed =
            new EmbedBuilder()
              .setTitle(
                game.title
              )

              .setURL(
                `https://store.epicgames.com/pl/p/${slug}`
              )

              .setColor(
                "#2f3136"
              )

              .setFooter({
                text:
                  "Epic Games"
              })

              .setDescription(
                `🖥️ **PC**
⌛ **Gratis do:** ${formatDate(activePromo.endDate)}${
  hoursLeft !== null
    ? `\n⏳ **Zostało:** ${hoursLeft}h`
    : ""
}`
              )

              .setTimestamp();

          if (image) {
            embed.setImage(
              image
            );
          }

          await channel.send({
            content: `<@&${ROLE_ID}>`,

            embeds: [embed]
          });

          console.log(
            "🎮 Epic wysłano:",
            game.title
          );

          savedData.epicGames.push(
            promoId
          );
        } catch (e) {
          console.log(
            "Epic item error:",
            e.message
          );
        }
      }

      savedData.epicGames =
        [
          ...new Set(
            savedData.epicGames
          )
        ].slice(-500);

      saveData();

      global.gc?.();

      console.log(
        "✅ Epic sprawdzony"
      );
    } catch (err) {
      console.log(
        "❌ Epic error:",
        err.message
      );
    }
  };