const { chromium } = require("playwright");
const cheerio = require("cheerio");
const axios = require("axios");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = "1479078345382559804";
const ROLE_ID = "1371121790046437448";

const PERMA_F2P = new Set([
  "730",      // CS2
  "570",      // Dota 2
  "440",      // TF2
  "578080",   // PUBG
  "1172470"   // Apex
]);

async function fetchSteamDBFree() {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote"
      ]
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    });

    await page.route("**/*", route => {
      const type = route.request().resourceType();

      if (
        type === "image" ||
        type === "media" ||
        type === "font" ||
        type === "stylesheet"
      ) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto("https://steamdb.info/upcoming/free/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector("body");

    const html = await page.content();
    const $ = cheerio.load(html);

    const games = [];
    const seen = new Set();

    $("a[href*='/app/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/\/app\/(\d+)\//);
      if (!match) return;

      const appid = match[1];
      if (seen.has(appid)) return;
      if (PERMA_F2P.has(appid)) return;

      const name = $(el).text().trim();
      if (!name || name.length < 2) return;

      const areaText =
        $(el).closest("tr").text() ||
        $(el).parent().parent().text() ||
        $(el).parent().text() ||
        "";

      if (!/Free to Keep/i.test(areaText)) return;

      seen.add(appid);

      games.push({
        appid,
        name,
        url: `https://store.steampowered.com/app/${appid}/`
      });
    });

    return games;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    global.gc?.();
  }
}

async function fetchSteamDetails(appid) {
  const { data } = await axios.get(
    "https://store.steampowered.com/api/appdetails",
    {
      params: {
        appids: appid,
        cc: "us",
        l: "en"
      },
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }
  );

  return data?.[appid];
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🟦 SteamDB (Playwright): checking...");
    savedData.steamGames ??= [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    const list = await fetchSteamDBFree();
    console.log(`📦 found: ${list.length}`);

    let sent = 0;

    for (const item of list) {
      try {
        if (savedData.steamGames.includes(item.appid)) continue;

        const app = await fetchSteamDetails(item.appid);
        if (!app?.success || !app.data) continue;

        const game = app.data;

        const embed = new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle(`🎮 ${game.name}`)
          .setURL(item.url)
          .setDescription(
            "🔥 **NOWA DARMÓWKA NA STEAM!**\n\n✅ **Free to Keep**\n📌 **Dodaj do konta — zostaje na zawsze**"
          )
          .setThumbnail(game.capsule_image || null)
          .setImage(game.header_image || null)
          .setFooter({ text: "BundleBot • Steam Giveaway" })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("🎮 Odbierz na Steam")
            .setStyle(ButtonStyle.Link)
            .setURL(item.url)
        );

        await channel.send({
          content: `🚨 **NOWA DARMOWA GRA NA STEAM!** <@&${ROLE_ID}>`,
          embeds: [embed],
          components: [row]
        });

        savedData.steamGames.push(item.appid);
        savedData.steamGames =
          [...new Set(savedData.steamGames)].slice(-1000);

        saveData();
        sent++;

        console.log(`✔ Sent: ${game.name}`);
      } catch (e) {
        console.log("Steam item error:", e.message);
      }
    }

    if (!sent) console.log("⏸ nic nowego");
    else console.log(`✅ wysłano ${sent}`);
  } catch (err) {
    console.log("❌ Steam error:", err.message);
  }
};