const axios = require("axios");

const cheerio = require("cheerio");

const {
  EmbedBuilder
} = require("discord.js");

const CHANNEL_ID =
  process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";

const ROLE_ID =
  "1371122206670852146";

const BUNDLE_BASE_URL =
  "https://www.greenmangamingbundles.com";

function normalizeBundleUrl(rawUrl) {
  try {
    const url =
      new URL(
        rawUrl,
        BUNDLE_BASE_URL
      );

    url.search =
      "";

    url.hash =
      "";

    url.pathname =
      url.pathname.replace(
        /\/+$/,
        ""
      );

    return url
      .toString()
      .replace(
        /\/$/,
        ""
      );
  } catch {
    return String(rawUrl || "")
      .split("#")[0]
      .split("?")[0]
      .replace(
        /\/+$/,
        ""
      );
  }
}

function getKnownBundleUrls(
  savedData,
  saveData
) {
  savedData.gmgBundles ??=
    [];

  const normalized =
    [
      ...new Set(
        savedData.gmgBundles
          .map(normalizeBundleUrl)
          .filter(Boolean)
      )
    ].slice(-500);

  const changed =
    normalized.length !== savedData.gmgBundles.length ||
    normalized.some(
      (url, index) =>
        url !== savedData.gmgBundles[index]
    );

  if (changed) {
    savedData.gmgBundles =
      normalized;

    saveData();
  }

  return new Set(
    normalized
  );
}

const NON_GAME_TITLE_PATTERN =
  /\b(software|audio|sound|music|producer|assets?|books?|e-?books?|epub|pdf|packt|career|data\s*(?:&|and)\s*ai|course|courses|training|certification|machine learning|artificial intelligence|python|unreal engine|unity|cad|3d model|texture|sample packs?|plugins?)\b/i;

const NON_GAME_PATTERNS =
  [
    /\bsoftware (bundle|collection|pack|suite)\b/,
    /\bplugins?\b/,
    /\binstrument bundle\b/,
    /\bstudio bundle\b/,
    /\bbook (bundle|collection|pack)\b/,
    /\be-?books?\b/,
    /\bepub\b/,
    /\bpdf formats?\b/,
    /\bpackt\b/,
    /\bcareer accelerator\b/,
    /\bdata\s*(?:&|and)\s*ai\b/,
    /\bdata science\b/,
    /\bmachine learning\b/,
    /\bartificial intelligence\b/,
    /\broyalty-free\b/,
    /\bsound effects?\b/,
    /\bsound packs?\b/,
    /\bsound lab\b/,
    /\bsfx\b/,
    /\baudio (pack|packs|engineering|creator|creators|library)\b/,
    /\bmusic (production|producer|makers|pack|bundle)\b/,
    /\bsample packs?\b/,
    /\bsound (library|design)\b/,
    /\bmega ?pack\b/,
    /\bassets?\b/,
    /\b3d models?\b/,
    /\b2d assets?\b/,
    /\bsprites?\b/,
    /\btextures?\b/,
    /\btexture pack\b/,
    /\bvfx\b/,
    /\benvironment pack\b/,
    /\bcharacter pack\b/,
    /\banimation pack\b/,
    /\bshaders?\b/,
    /\bmaterials?\b/,
    /\bicons?\b/,
    /\btilesets?\b/,
    /\bgui pack\b/
  ];

const EDUCATION_PATTERNS =
  [
    /\bcourses?\b/,
    /\blearn(?:ing)?\b/,
    /\btraining\b/,
    /\btutorials?\b/,
    /\bacademy\b/,
    /\bmasterclass\b/,
    /\blessons?\b/,
    /\bcertification\b/,
    /\bcareer\b/,
    /\bpython\b/
  ];

const DEV_PATTERNS =
  [
    /\bunreal engine\b/,
    /\bunity\b/,
    /\bblender\b/,
    /\bgodot\b/,
    /\bgame dev(?:elopment)?\b/
  ];

const GAME_SIGNAL_PATTERNS =
  [
    /\bgame bundle\b/,
    /\bgames bundle\b/,
    /\bsteam keys?\b/,
    /\bactivate on steam\b/,
    /\bredeem on steam\b/,
    /\bpc games?\b/,
    /\bvideo games?\b/,
    /\bgame keys?\b/
  ];

function matchesAny(
  text,
  patterns
) {
  return patterns.some(
    pattern =>
      pattern.test(text)
  );
}

function buildClassificationText(
  title,
  description,
  bodyText
) {
  const heroText =
    bodyText
      .split("offer ends")[0]
      .slice(0, 2000);

  return (
    title +
    " " +
    description +
    " " +
    heroText
  ).toLowerCase();
}

function getNonGameReason(
  titleText,
  classificationText
) {
  if (NON_GAME_TITLE_PATTERN.test(titleText)) {
    return "title";
  }

  if (matchesAny(classificationText, NON_GAME_PATTERNS)) {
    return "non-game keywords";
  }

  if (
    matchesAny(classificationText, DEV_PATTERNS) &&
    matchesAny(classificationText, EDUCATION_PATTERNS)
  ) {
    return "game-dev learning";
  }

  if (matchesAny(classificationText, EDUCATION_PATTERNS)) {
    return "education";
  }

  return null;
}

function hasGameSignal(
  classificationText
) {
  return matchesAny(
    classificationText,
    GAME_SIGNAL_PATTERNS
  );
}

function isExpiredBundle(
  bodyText
) {
  return /\b(bundle expired|offer ended|offer has ended|deal expired|this bundle has expired)\b/.test(
    bodyText
  );
}

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
            .map(normalizeBundleUrl)
            .filter(Boolean)
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

      const known =
        getKnownBundleUrls(
          savedData,
          saveData
        );

      for (const url of links) {
        try {
          if (
            known.has(
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

          if (isExpiredBundle(bodyText)) {
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

          const classificationText =
            buildClassificationText(
              title,
              description,
              bodyText
            );

          const fullText =
            classificationText;

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

              // books / learning
              "book bundle",
              "book collection",
              "book pack",
              "ebook",
              "ebooks",
              "epub",
              "pdf format",
              "pdf formats",
              "packt",
              "career accelerator",
              "data & ai",
              "data and ai",
              "data science",
              "machine learning",
              "artificial intelligence",

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
              "lessons",
              "book",
              "books",
              "ebook",
              "ebooks",
              "certification",
              "career",
              "data science",
              "machine learning",
              "artificial intelligence",
              "python"
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
            hasGameSignal(
              classificationText
            );

          const hasHard =
            matchesAny(
              classificationText,
              NON_GAME_PATTERNS
            );

          const hasSoft =
            SOFT_BLOCK.some(
              w =>
                fullText.includes(
                  w
                )
            );

          const hasEdu =
            matchesAny(
              classificationText,
              EDUCATION_PATTERNS
            );

          const hasDev =
            matchesAny(
              classificationText,
              DEV_PATTERNS
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

          const nonGameReason =
            getNonGameReason(
              titleText,
              classificationText
            );

          if (nonGameReason) {
            console.log(
              `GMG non-game bundle (${nonGameReason}):`,
              title
            );

            continue;
          }

          if (!hasGameSignal(classificationText)) {
            console.log(
              "GMG no clear game signal:",
              title
            );

            continue;
          }

          if (
            NON_GAME_TITLE_PATTERN.test(
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

          if (!hasGame) {
            console.log(
              "🚫 No clear game signal:",
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

          savedData.gmgBundles =
            [
              ...new Set(
                savedData.gmgBundles
                  .map(normalizeBundleUrl)
                  .filter(Boolean)
              )
            ].slice(-500);

          known.add(
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
