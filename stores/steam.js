const axios = require("axios");

const http = require("http");

const https = require("https");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

// ==========================
// CONFIG
// ==========================

const CHANNEL_ID =
  "1479078345382559804";

const ROLE_ID =
  "1371121790046437448";

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
        "Mozilla/5.0",

      "Accept-Language":
        "en-US,en;q=0.9",

      Cookie:
        [
          "birthtime=568022401",
          "lastagecheckage=1-January-1988",
          "wants_mature_content=1",
          "mature_content=1"
        ].join("; ")
    }
  });

// ==========================
// DELAY
// ==========================

function sleep(ms) {
  return new Promise(
    r => setTimeout(r, ms)
  );
}

// ==========================
// FETCH FREE + SPECIALS
// ==========================

async function fetchSearchPage() {

  try {

    const { data } =
      await axiosInstance.get(
        "https://store.steampowered.com/search/results/",
        {
          params: {
            maxprice: "free",
            specials: 1,
            supportedlang: "english",
            category1: 998,
            hidef2p: 1,
            ignore_preferences: 1,
            cc: "us",
            l: "english",
            ndl: 1,
            json: 1,
            start: 0,
            count: 100
          }
        }
      );

    if (typeof data === "string") {
      return data;
    }

    return String(
      data?.results_html ||
      ""
    );

  } catch (err) {

    console.log(
      "❌ fetchSearchPage:",
      err.message
    );

    return null;
  }
}

// ==========================
// EXTRACT APPIDS
// ==========================

function extractAppIds(
  html
) {

  try {

    const regex =
      /data-ds-appid="(\d+)"/g;

    const matches =
      [
        ...html.matchAll(regex)
      ];

    const ids =
      matches.map(
        x => x[1]
      );

    return [
      ...new Set(ids)
    ];

  } catch {

    return [];
  }
}

// ==========================
// FETCH DETAILS
// ==========================

async function fetchDetails(
  appid
) {

  try {

    const { data } =
      await axiosInstance.get(
        "https://store.steampowered.com/api/appdetails",
        {
          params: {
            appids: appid,
            cc: "us",
            l: "english"
          }
        }
      );

    return (
      data?.[appid] ||
      null
    );

  } catch (err) {

    console.log(
      `❌ API ${appid}:`,
      err.message
    );

    return null;
  }
}

// ==========================
// FETCH STORE PAGE
// ==========================

async function fetchStorePage(
  appid
) {

  try {

    const { data } =
      await axiosInstance.get(
        `https://store.steampowered.com/app/${appid}/`,
        {
          params: {
            cc: "us",
            l: "english",
            ageDay: "1",
            ageMonth: "January",
            ageYear: "1988",
            ndl: 1
          }
        }
      );

    return String(data)
      .toLowerCase();

  } catch (err) {

    console.log(
      `❌ HTML ${appid}:`,
      err.message
    );

    return null;
  }
}

// ==========================
// VALIDATE GIVEAWAY
// ==========================

async function validateGiveaway(
  game,
  appid
) {

  try {

    const po =
      game.price_overview;

    if (!po) {
      return false;
    }

    // ==========================
    // API CHECK
    // ==========================

    const initial =
      Number(po.initial || 0);

    const final =
      Number(po.final || 0);

    const apiValid =
      po.discount_percent === 100 &&
      final === 0 &&
      initial > 0;

    if (!apiValid) {
      return false;
    }

    // ==========================
    // HTML CHECK
    // ==========================

    const html =
      await fetchStorePage(
        appid
      );

    if (!html) {
      return false;
    }

    const checks = {

      minus100:
        html.includes("-100%"),

      discountPct:
        html.includes("discount_pct") ||
        html.includes("discount_block"),

      discountFinal:
        html.includes("discount_final_price") ||
        html.includes("free to keep"),

      addToAccount:
        html.includes("add to account") ||
        html.includes("add to your account") ||
        html.includes("add to library"),

      freeToKeep:
        html.includes("free to keep") ||
        html.includes("100%")
    };

    // ==========================
    // REAL F2P CHECK
    // ==========================

    const isRealF2P =
      html.includes(
        'discount_final_price">free to play'
      );

    console.log(
      `🔍 ${appid}`,
      {
        ...checks,
        isRealF2P,
        initial,
        final,
        discount: po.discount_percent
      }
    );

    return (
      checks.minus100 &&
      (
        checks.discountPct ||
        checks.discountFinal ||
        checks.addToAccount ||
        checks.freeToKeep
      ) &&
      !isRealF2P
    );

  } catch (err) {

    console.log(
      `❌ VALIDATE ${appid}:`,
      err.message
    );

    return false;
  }
}

// ==========================
// MAIN CHECK
// ==========================

async function check(
  client,
  savedData,
  saveData
) {

  try {

    console.log(
      "🟦 Steam Giveaway Scan..."
    );

    savedData.steamGames ??=
      [];

    const known =
      new Set(
        savedData.steamGames
      );

    const channel =
      await client.channels.fetch(
        CHANNEL_ID
      );

    // ==========================
    // FETCH PAGE
    // ==========================

    const html =
      await fetchSearchPage();

    if (!html) {

      console.log(
        "❌ No HTML"
      );

      return;
    }

    // ==========================
    // EXTRACT APPIDS
    // ==========================

    const appids =
      extractAppIds(
        html
      );

    console.log(
      `🎮 AppIDs: ${appids.length}`
    );

    if (!appids.length) {

      console.log(
        "⏸ No appids"
      );

      return;
    }

    // ==========================
    // PROCESS
    // ==========================

    let sent = 0;

    for (const appid of appids) {

      try {

        if (
          known.has(appid)
        ) {
          continue;
        }

        await sleep(1200);

        const app =
          await fetchDetails(
            appid
          );

        if (
          !app?.success ||
          !app.data
        ) {
          continue;
        }

        const game =
          app.data;

        const valid =
          await validateGiveaway(
            game,
            appid
          );

        if (!valid) {

          console.log(
            `❌ Not giveaway: ${appid}`
          );

          continue;
        }

        console.log(
          `🎁 GIVEAWAY: ${game.name}`
        );

        const url =
          `https://store.steampowered.com/app/${appid}/`;

        // ==========================
        // EMBED
        // ==========================

        const embed =
          new EmbedBuilder()

            .setColor(
              0x00c853
            )

            .setTitle(
              `🎮 ${game.name}`
            )

            .setURL(
              url
            )

            .setDescription(
              "🔥 **NOWA DARMOWA GRA NA STEAM!**\n\n✅ Promocja -100%\n✅ Free to Keep\n📌 Dodaj do konta — zostaje na zawsze"
            )

            .setThumbnail(
              game.capsule_image ||
              null
            )

            .setImage(
              game.header_image ||
              null
            )

            .setFooter({
              text:
                "BundleBot • Steam Giveaway Tracker"
            })

            .setTimestamp();

        const row =
          new ActionRowBuilder()
            .addComponents(

              new ButtonBuilder()

                .setLabel(
                  "🎮 Odbierz na Steam"
                )

                .setStyle(
                  ButtonStyle.Link
                )

                .setURL(
                  url
                )
            );

        // ==========================
        // SEND
        // ==========================

        await channel.send({

          content:
            `🚨 **NOWA DARMOWA GRA NA STEAM!** <@&${ROLE_ID}>`,

          embeds: [embed],

          components: [row]
        });

        // ==========================
        // SAVE
        // ==========================

        savedData.steamGames.push(
          appid
        );

        savedData.steamGames =
          [
            ...new Set(
              savedData.steamGames
            )
          ].slice(-1000);

        saveData();

        sent++;

        console.log(
          `✔ Sent: ${game.name}`
        );

      } catch (err) {

        console.log(
          `❌ PROCESS ${appid}:`,
          err.message
        );
      }
    }

    // ==========================
    // FINAL
    // ==========================

    if (!sent) {

      console.log(
        "⏸ No new giveaways"
      );

    } else {

      console.log(
        `✅ Sent ${sent}`
      );
    }

    // ==========================
    // RAM
    // ==========================

    global.gc?.();

    try {

      const used =
        Math.round(
          process.memoryUsage()
            .rss /
          1024 /
          1024
        );

      console.log(
        `🧹 RAM ${used} MB`
      );

    } catch {}

  } catch (err) {

    console.log(
      "❌ Steam error:",
      err.message
    );
  }
}

module.exports = {
  check
};