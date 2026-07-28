const axios = require("axios");

const cheerio = require("cheerio");

const {
  EmbedBuilder
} = require("discord.js");

const CHANNEL_ID =
  process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";

const ROLE_ID =
  "1371122206670852146";

module.exports.check =
  async (
    client,
    savedData,
    saveData
  ) => {
    try {
      console.log(
        "🔎 GMG: sprawdzam bundles..."
      );

      const {
        data: html
      } = await axios.get(
        "https://www.greenmangaming.com/bundles/",

        {
          headers: {
            "User-Agent":
              "Mozilla/5.0",

            Accept:
              "text/html"
          },

          timeout: 20000
        }
      );

      const $ =
        cheerio.load(html);

      let links = $(
        "a[href*='greenmangamingbundles.com/bundles']"
      )
        .map((i, el) =>
          $(el).attr("href")
        )
        .get();

      links = [
        ...new Set(
          links
        )
      ];

      console.log(
        "🔗 GMG znalezione:",
        links.length
      );

      if (!links.length) {
        return;
      }

      const channel =
        await client.channels.fetch(
          CHANNEL_ID
        );

      savedData.gmgBundles ??=
        [];

      for (let url of links) {
        try {
          url =
            url.replace(
              /\/$/,
              ""
            );

          if (
            savedData.gmgBundles.includes(
              url
            )
          ) {
            console.log(
              "⏸ GMG już zapisany:",
              url
            );

            continue;
          }

          const {
            data: bundleHtml
          } =
            await axios.get(
              url,

              {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0"
                },

                timeout: 15000
              }
            );

          const $$ =
            cheerio.load(
              bundleHtml
            );

          const bodyText =
            $$("body")
              .text()
              .replace(
                /\s+/g,
                " "
              )
              .toLowerCase();

          // =========================
          // EXPIRED
          // =========================

          if (
            bodyText.includes(
              "expired"
            ) ||
            bodyText.includes(
              "offer ended"
            ) ||
            bodyText.includes(
              "ended"
            )
          ) {
            console.log(
              "⛔ Expired:",
              url
            );

            continue;
          }

          const title =
            $$(
              "meta[property='og:title']"
            ).attr(
              "content"
            ) ||
            $$("h1")
              .first()
              .text()
              .trim();

          const description =
            $$(
              "meta[property='og:description']"
            ).attr(
              "content"
            ) ||
            "Sprawdź bundle.";

          const image =
            $$(
              "meta[property='og:image']"
            ).attr(
              "content"
            ) || null;

          const fullText =
            (
              title +
              " " +
              description +
              " " +
              bodyText
            ).toLowerCase();

          const titleText =
            title.toLowerCase();

          // =========================
          // BLOCKLISTS
          // =========================

          const HARD_BLOCK =
            [
              // software / tools
              "software bundle",
              "software collection",
              "software pack",
              "software suite",
              "plugin",
              "plugins",
              "instrument bundle",
              "studio bundle",

              // audio
              "royalty-free",
              "sound effects",
              "sound effect",
              "sound pack",
              "sound packs",
              "sfx",
              "audio pack",
              "audio packs",
              "audio engineering",
              "audio creator",
              "audio creators",
              "music production",
              "music producer",
              "music makers",
              "sample pack",
              "sample packs",
              "music pack",
              "audio library",
              "sound library",
              "sound design",

              // assets
              "megapack",
              "mega pack",
              "asset",
              "assets",
              "3d model",
              "3d models",
              "sprites",
              "textures",
              "texture pack",
              "vfx",
              "environment pack",
              "character pack",
              "animation pack",
              "shader",
              "materials",
              "icons",
              "tileset",
              "gui pack"
            ];

          const SOFT_BLOCK =
            [
              "creator",
              "studio",
              "tool",
              "tools",
              "editor",
              "editing",
              "resource"
            ];

          const EDUCATION_BLOCK =
            [
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

          const DEV_KEYWORDS =
            [
              "unity",
              "unreal",
              "blender",
              "godot",
              "game dev",
              "game development"
            ];

          const GAME_HINTS =
            [
              "steam key",
              "steam keys",
              "activate on steam",
              "redeem on steam",
              "pc game",
              "pc games",
              "game bundle",
              "games bundle",
              "dlc pack",
              "game keys"
            ];

          // =========================
          // DETECT
          // =========================

          const hasGame =
            GAME_HINTS.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const hasHard =
            HARD_BLOCK.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const hasSoft =
            SOFT_BLOCK.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const hasEdu =
            EDUCATION_BLOCK.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const hasDev =
            DEV_KEYWORDS.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const looksLikeAsset =
            fullText.includes(
              "3d"
            ) ||
            fullText.includes(
              "2d"
            ) ||
            fullText.includes(
              "asset"
            ) ||
            fullText.includes(
              "environment"
            ) ||
            fullText.includes(
              "textures"
            );

          // =========================
          // FILTERS
          // =========================

          if (
            /(software|audio|sound|music|producer|asset|assets|course|courses|training|unreal engine|unity|cad|3d model|texture|sample pack|plugin)/i.test(
              titleText
            )
          ) {
            console.log(
              "🚫 Non-game GMG bundle:",
              title
            );

            continue;
          }

          if (hasHard) {
            console.log(
              "🚫 Asset bundle:",
              title
            );

            continue;
          }

          if (
            looksLikeAsset &&
            !hasGame
          ) {
            console.log(
              "🚫 Asset bundle:",
              title
            );

            continue;
          }

          if (
            (
              fullText.includes(
                "music"
              ) ||
              fullText.includes(
                "audio"
              ) ||
              fullText.includes(
                "sound"
              )
            ) &&
            !hasGame
          ) {
            console.log(
              "🚫 Audio bundle:",
              title
            );

            continue;
          }

          if (
            hasEdu &&
            !hasGame
          ) {
            console.log(
              "🚫 Education bundle:",
              title
            );

            continue;
          }

          if (
            hasDev &&
            hasEdu
          ) {
            console.log(
              "🚫 GameDev bundle:",
              title
            );

            continue;
          }

          if (
            hasSoft &&
            !hasGame
          ) {
            console.log(
              "🚫 Software bundle:",
              title
            );

            continue;
          }

          // =========================
          // VALID GAME BUNDLE
          // =========================

          console.log(
            "🔥 GMG aktywny bundle:",
            title
          );

          savedData.gmgBundles.push(
            url
          );

          saveData();

          const embed =
            new EmbedBuilder()
              .setTitle(
                `🟢 ${title}`
              )

              .setURL(
                url
              )

              .setColor(
                0x2ecc71
              )

              .setDescription(
                description.substring(
                  0,
                  400
                )
              )

              .setFooter({
                text:
                  "Green Man Gaming Bundle 🎮"
              })

              .setTimestamp();

          if (image) {
            embed.setImage(
              image
            );
          }

          await channel.send({
            content: `🟢 **NOWY GREEN MAN GAMING BUNDLE!** <@&${ROLE_ID}>`,

            embeds: [embed]
          });

          console.log(
            "🚀 GMG wysłany"
          );
        } catch (e) {
          console.log(
            "❌ GMG bundle error:",
            e.message
          );
        }
      }
    } catch (err) {
      console.log(
        "🔥 GMG error:",
        err.message
      );
    }
  };
