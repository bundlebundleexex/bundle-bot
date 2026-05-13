const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const axios = require("axios");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID =
  "1479078345382559804";

const ROLE_ID =
  "1371121790046437448";

const PERMA_F2P = new Set([
  "730",
  "570",
  "440",
  "578080",
  "1172470"
]);

// ==========================
// FETCH FREE GAMES
// ==========================

async function fetchSteamDBFree() {
  let browser = null;

  let page = null;

  try {
    browser =
      await puppeteer.launch({
        headless: "new",

        args: [
          "--no-sandbox",

          "--disable-setuid-sandbox",

          "--disable-dev-shm-usage",

          "--disable-gpu",

          "--no-zygote",

          "--single-process",

          "--disable-extensions",

          "--disable-background-networking",

          "--disable-background-timer-throttling",

          "--disable-renderer-backgrounding",

          "--disable-sync",

          "--mute-audio"
        ]
      });

    page =
      await browser.newPage();

    page.setDefaultNavigationTimeout(
      15000
    );

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    await page.setRequestInterception(
      true
    );

    page.on(
      "request",

      req => {
        const type =
          req.resourceType();

        if (
          type === "image" ||
          type === "media" ||
          type === "font" ||
          type ===
            "stylesheet"
        ) {
          req.abort();
        } else {
          req.continue();
        }
      }
    );

    await page.goto(
      "https://steamdb.info/upcoming/free/",

      {
        waitUntil:
          "domcontentloaded",

        timeout: 15000
      }
    );

    // mały wait zamiast ciężkich selectorów
    await new Promise(r =>
      setTimeout(r, 2500)
    );

    const html =
      await page.content();

    if (
      !html ||
      html.length < 1000
    ) {
      throw new Error(
        "SteamDB empty HTML"
      );
    }

    const $ =
      cheerio.load(html);

    const games = [];

    const seen = new Set();

    $("a[href*='/app/']").each(
      (_, el) => {
        try {
          const href =
            $(el).attr(
              "href"
            ) || "";

          const match =
            href.match(
              /\/app\/(\d+)\//
            );

          if (!match) {
            return;
          }

          const appid =
            match[1];

          if (
            seen.has(appid)
          ) {
            return;
          }

          if (
            PERMA_F2P.has(
              appid
            )
          ) {
            return;
          }

          const name = $(el)
            .text()
            .trim();

          if (
            !name ||
            name.length < 2
          ) {
            return;
          }

          const areaText =
            $(el)
              .closest("tr")
              .text() ||
            $(el)
              .parent()
              .parent()
              .text() ||
            $(el)
              .parent()
              .text() ||
            "";

          if (
            !/Free to Keep/i.test(
              areaText
            )
          ) {
            return;
          }

          seen.add(appid);

          games.push({
            appid,

            name,

            url: `https://store.steampowered.com/app/${appid}/`
          });
        } catch {}
      }
    );

    return games;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }

    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    global.gc?.();
  }
}

// ==========================
// FETCH DETAILS
// ==========================

async function fetchSteamDetails(
  appid
) {
  try {
    const { data } =
      await axios.get(
        "https://store.steampowered.com/api/appdetails",

        {
          params: {
            appids: appid,

            cc: "us",

            l: "en"
          },

          timeout: 10000,

          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        }
      );

    return (
      data?.[appid] ||
      null
    );
  } catch {
    return null;
  }
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
        "🟦 SteamDB: checking..."
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

      const list =
        await Promise.race([
          fetchSteamDBFree(),

          new Promise(
            (_, reject) =>
              setTimeout(() => {
                reject(
                  new Error(
                    "SteamDB hard timeout"
                  )
                );
              }, 25000)
          )
        ]);

      console.log(
        `📦 found: ${list.length}`
      );

      let sent = 0;

      for (const item of list) {
        try {
          if (
            known.has(
              item.appid
            )
          ) {
            continue;
          }

          const app =
            await fetchSteamDetails(
              item.appid
            );

          if (
            !app?.success ||
            !app.data
          ) {
            continue;
          }

          const game =
            app.data;

          const embed =
            new EmbedBuilder()
              .setColor(
                0x00c853
              )

              .setTitle(
                `🎮 ${game.name}`
              )

              .setURL(
                item.url
              )

              .setDescription(
                "🔥 **NOWA DARMÓWKA NA STEAM!**\n\n✅ **Free to Keep**\n📌 **Dodaj do konta — zostaje na zawsze**"
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
                  "BundleBot • Steam Giveaway"
              })

              .setTimestamp();

          const row =
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(
                  "🎮 Odbierz na Steam"
                )

                .setStyle(
                  ButtonStyle.Link
                )

                .setURL(
                  item.url
                )
            );

          await channel.send({
            content: `🚨 **NOWA DARMOWA GRA NA STEAM!** <@&${ROLE_ID}>`,

            embeds: [embed],

            components: [row]
          });

          savedData.steamGames.push(
            item.appid
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
        } catch (e) {
          console.log(
            "Steam item error:",
            e.message
          );
        }
      }

      if (!sent) {
        console.log(
          "⏸ nic nowego"
        );
      } else {
        console.log(
          `✅ wysłano ${sent}`
        );
      }
    } catch (err) {
      console.log(
        "❌ Steam error:",
        err.message
      );
    }
  };