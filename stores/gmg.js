const axios = require("axios");
const cheerio = require("cheerio");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  try {

    console.log("🔎 GMG: sprawdzam bundles...");

    const { data: html } = await axios.get(
      "https://www.greenmangaming.com/bundles/",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html"
        },
        timeout: 20000
      }
    );

    const $ = cheerio.load(html);

    let links = $("a[href*='greenmangamingbundles.com/bundles']")
      .map((i, el) => $(el).attr("href"))
      .get();

    links = [...new Set(links)];

    console.log("🔗 GMG znalezione:", links.length);

    if (!links.length) return;

    const channel = await client.channels.fetch(CHANNEL_ID);

    savedData.gmgBundles ??= [];

    for (let url of links) {

      url = url.replace(/\/$/, "");

      if (savedData.gmgBundles.includes(url)) {
        console.log("⏸ GMG już zapisany:", url);
        continue;
      }

      const { data: bundleHtml } = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const $$ = cheerio.load(bundleHtml);

      const bodyText = $$("body").text();

      // ❌ expired
      if (
        bodyText.includes("Expired") ||
        bodyText.includes("Offer ended") ||
        bodyText.includes("ENDED")
      ) {
        console.log("⛔ Expired:", url);
        continue;
      }

      const title =
        $$("meta[property='og:title']").attr("content") ||
        $$("h1").first().text().trim();

      const description =
        $$("meta[property='og:description']").attr("content") ||
        "Sprawdź bundle.";

      const image =
        $$("meta[property='og:image']").attr("content") ||
        null;

      // =========================
      // 🔥 FILTR FINALNY
      // =========================

      const fullText = (title + " " + description + " " + bodyText).toLowerCase();

      // 🎧 AUDIO / ASSETY
      const HARD_BLOCK = [
        "royalty-free",
        "sound effects",
        "sfx",
        "audio pack",
        "music pack",
        "audio library",
        "sound library"
      ];

      // 🧰 SOFTWARE / TOOLS
      const SOFT_BLOCK = [
        "creator",
        "studio",
        "tool",
        "tools",
        "editor",
        "editing",
        "resource"
      ];

      // 🎓 EDUKACJA / KURSY
      const EDUCATION_BLOCK = [
        "course",
        "courses",
        "learn",
        "learning",
        "training",
        "tutorial",
        "academy",
        "masterclass",
        "lessons"
      ];

      // 🧠 GAME DEV (Unity itd.)
      const DEV_KEYWORDS = [
        "unity",
        "unreal",
        "blender",
        "godot",
        "game dev",
        "game development"
      ];

      // 🎮 SYGNAŁY GIER
      const GAME_HINTS = [
        "steam",
        "game",
        "games",
        "dlc",
        "pc",
        "key",
        "keys"
      ];

      const hasGame = GAME_HINTS.some(w => fullText.includes(w));
      const hasHard = HARD_BLOCK.some(w => fullText.includes(w));
      const hasSoft = SOFT_BLOCK.some(w => fullText.includes(w));
      const hasEdu = EDUCATION_BLOCK.some(w => fullText.includes(w));
      const hasDev = DEV_KEYWORDS.some(w => fullText.includes(w));

      // ❌ AUDIO / ASSET
      if (hasHard) {
        console.log("🚫 Asset bundle:", title);
        continue;
      }

      // ❌ AUDIO fallback
      if (
        (fullText.includes("music") ||
         fullText.includes("audio") ||
         fullText.includes("sound")) &&
        !hasGame
      ) {
        console.log("🚫 Audio bundle:", title);
        continue;
      }

      // ❌ EDUKACJA
      if (hasEdu && !hasGame) {
        console.log("🚫 Education bundle:", title);
        continue;
      }

      // ❌ GAMEDEV (kursy + unity itd.)
      if (hasDev && hasEdu) {
        console.log("🚫 GameDev bundle:", title);
        continue;
      }

      // ❌ SOFTWARE (tylko jeśli brak gier)
      if (hasSoft && !hasGame) {
        console.log("🚫 Software bundle:", title);
        continue;
      }

      // =========================
      // ✅ PRZECHODZI (GRY)
      // =========================

      console.log("🔥 GMG aktywny bundle:", title);

      savedData.gmgBundles.push(url);
      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🟢 ${title}`)
        .setURL(url)
        .setColor(0x2ECC71)
        .setDescription(description.substring(0, 400))
        .setFooter({ text: "Green Man Gaming Bundle 🎮" })
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `🟢 **NOWY GREEN MAN GAMING BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 GMG wysłany");
    }

  } catch (err) {
    console.log("🔥 GMG error:", err.message);
  }
};