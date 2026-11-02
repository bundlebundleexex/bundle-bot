const axios = require("axios");

const cheerio = require("cheerio");
const { isSignificantExtension } = require("./renewal");

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

function pruneInactiveBundleUrls(
  savedData,
  currentUrls,
  saveData
) {
  if (!currentUrls.length) {
    return;
  }

  savedData.gmgBundles ??=
    [];

  const current =
    new Set(
      currentUrls
    );

  const previous =
    [
      ...new Set(
        savedData.gmgBundles
          .map(normalizeBundleUrl)
          .filter(Boolean)
      )
    ];

  const next =
    previous.filter(
      url =>
        current.has(
          url
        )
    );

  if (
    previous.length !== next.length ||
    previous.some(
      (url, index) =>
        url !== next[index]
    )
  ) {
    savedData.gmgBundles =
      next;

    saveData();

    console.log(
      `🧹 GMG: wyczyszczono nieaktywne bundle=${previous.length - next.length}`
    );
  }
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

function getOfferRemainingMs(bodyText) {
  const match = String(bodyText || "").match(
    /offer ends\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i
  );
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60000 + Number(seconds) * 1000;
}

function formatGMGDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

const CURRENCY_PRICE_PATTERN =
  /(?:[€£$]\s*\d+(?:[.,]\d{1,2})?)|(?:\b(?:USD|EUR|GBP|AUD|CAD|PLN)\b\s*\d+(?:[.,]\d{1,2})?)|(?:\d+(?:[.,]\d{1,2})?\s*\b(?:USD|EUR|GBP|AUD|CAD|PLN)\b)/gi;

function parsePriceCandidate(
  rawPrice
) {
  const text =
    String(rawPrice || "")
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const amountMatch =
    text.match(
      /\d+(?:[.,]\d{1,2})?/
    );

  if (!amountMatch) {
    return null;
  }

  const value =
    Number(
      amountMatch[0].replace(
        ",",
        "."
      )
    );

  if (!Number.isFinite(value)) {
    return null;
  }

  const code =
    text
      .toUpperCase()
      .match(
        /\b(USD|EUR|GBP|AUD|CAD|PLN)\b/
      )?.[1] || "";

  const symbol =
    text.match(
      /[€£$]/
    )?.[0] || "";

  const currency =
    code || symbol;

  const hasDecimals =
    /[.,]\d{1,2}/.test(
      amountMatch[0]
    );

  const amount =
    hasDecimals || !Number.isInteger(value)
      ? value.toFixed(2)
      : String(value);

  const display =
    currency.length === 3
      ? `${currency} ${amount}`
      : `${currency}${amount}`;

  return {
    value,
    display
  };
}

function getLowestPriceFromText(
  text
) {
  const prices =
    [
      ...String(text || "").matchAll(
        CURRENCY_PRICE_PATTERN
      )
    ]
      .map(match =>
        parsePriceCandidate(
          match[0]
        )
      )
      .filter(Boolean);

  if (!prices.length) {
    return null;
  }

  prices.sort(
    (a, b) =>
      a.value - b.value
  );

  return prices[0].display;
}

function getPriceAfterFrom(
  text
) {
  const match =
    String(text || "").match(
      /\bFROM\s+((?:[€£$]\s*\d+(?:[.,]\d{1,2})?)|(?:\b(?:USD|EUR|GBP|AUD|CAD|PLN)\b\s*\d+(?:[.,]\d{1,2})?)|(?:\d+(?:[.,]\d{1,2})?\s*\b(?:USD|EUR|GBP|AUD|CAD|PLN)\b))/i
    );

  return match
    ? parsePriceCandidate(
      match[1]
    )?.display || null
    : null;
}

function getListingPrices(
  $
) {
  const prices =
    new Map();

  $(".product-card").each(
    (_, card) => {
      const cardText =
        $(card)
          .text()
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      const price =
        getPriceAfterFrom(
          cardText
        );

      if (!price) {
        return;
      }

      $(card)
        .find(
          "a[href*='greenmangamingbundles.com/bundles']"
        )
        .each(
          (_, link) => {
            const url =
              normalizeBundleUrl(
                $(link).attr(
                  "href"
                )
              );

            if (url) {
              prices.set(
                url,
                price
              );
            }
          }
        );
    }
  );

  return prices;
}

function getBundlePrice(
  $,
  fallbackPrice
) {
  const bodyText =
    $("body")
      .text()
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const checkoutIndex =
    bodyText.indexOf(
      "CHECKOUT"
    );

  if (checkoutIndex !== -1) {
    const startIndex =
      Math.max(
        bodyText.lastIndexOf(
          "Pay what you want",
          checkoutIndex
        ),
        bodyText.lastIndexOf(
          "Suggested",
          checkoutIndex
        )
      );

    if (startIndex !== -1) {
      const tierText =
        bodyText.slice(
          startIndex,
          checkoutIndex
        );

      const tierPrice =
        getLowestPriceFromText(
          tierText
        );

      if (tierPrice) {
        return tierPrice;
      }
    }
  }

  return fallbackPrice || null;
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

      const listingPrices =
        getListingPrices(
          $
        );

      console.log(
        "🔗 GMG znalezione:",
        links.length
      );

      if (!links.length) {
        return;
      }

      pruneInactiveBundleUrls(
        savedData,
        links,
        saveData
      );

      const channel =
        await client.channels.fetch(
          CHANNEL_ID
        );

      const known =
        getKnownBundleUrls(
          savedData,
          saveData
        );
      savedData.gmgBundleExpiries ??= {};
      const newUrls = links.filter(url => !known.has(url));
      const knownUrls = links.filter(url => known.has(url));
      const renewalLimit = Math.max(1, Number(process.env.GMG_RENEWAL_CHECK_LIMIT || 5));
      const renewalCursor = Number(savedData.gmgBundleRenewalCursor || 0) % Math.max(knownUrls.length, 1);
      const checkedKnown = knownUrls.length
        ? Array.from({ length: Math.min(renewalLimit, knownUrls.length) }, (_, index) => knownUrls[(renewalCursor + index) % knownUrls.length])
        : [];
      savedData.gmgBundleRenewalCursor = knownUrls.length
        ? (renewalCursor + checkedKnown.length) % knownUrls.length
        : 0;
      const urlsToCheck = [...newUrls, ...checkedKnown];

      for (const url of urlsToCheck) {
        try {
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
          const remainingMs = getOfferRemainingMs(bodyText);
          const observedEndAt = remainingMs === null
            ? null
            : new Date(Date.now() + remainingMs).toISOString();

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

          const price =
            getBundlePrice(
              $$,
              listingPrices.get(
                url
              )
            );

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

          const wasAnnounced = known.has(url);
          const previousEndAt = savedData.gmgBundleExpiries[url]?.endAt || null;
          const extension = isSignificantExtension(previousEndAt, observedEndAt);

          if (wasAnnounced && !previousEndAt) {
            if (observedEndAt) {
              savedData.gmgBundleExpiries[url] = { endAt: observedEndAt, updatedAt: new Date().toISOString() };
            }
            saveData();
            continue;
          }

          if (previousEndAt && !extension) {
            if (!wasAnnounced) {
              if (observedEndAt) {
                savedData.gmgBundleExpiries[url] = { endAt: observedEndAt, updatedAt: new Date().toISOString() };
              }
              savedData.gmgBundles.push(url);
              savedData.gmgBundles = [...new Set(savedData.gmgBundles)].slice(-500);
              known.add(url);
            }
            saveData();
            continue;
          }

          const embed =
            new EmbedBuilder()
              .setTitle(
                `🟢 ${title}`
              )

              .setURL(
                url
              )

              .setColor(
                extension ? 0x2ecc71 : 0x3498db
              )

              .setDescription(
                (
                  price
                    ? `💰 Cena od: **${price}**\n\n`
                    : ""
                ) +
                (extension
                  ? "Termin dostępności tej oferty został przedłużony.\n\n"
                  : "") +
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

          if (extension) {
            embed.addFields(
              { name: "Poprzednio do", value: formatGMGDate(previousEndAt), inline: true },
              { name: "Nowy termin", value: formatGMGDate(observedEndAt), inline: true }
            );
          } else if (observedEndAt) {
            embed.addFields({ name: "⏳ Dostępne do", value: formatGMGDate(observedEndAt), inline: false });
          }

          if (image) {
            embed.setImage(
              image
            );
          }

          await channel.send({
            content: extension
              ? "🔁 **PAKIET PRZEDŁUŻONY — GREEN MAN GAMING**"
              : `🟢 **NOWY GREEN MAN GAMING BUNDLE!** <@&${ROLE_ID}>`,
            allowedMentions: extension ? { parse: [] } : { parse: [], roles: [ROLE_ID] },
            embeds: [embed]
          });

          if (!wasAnnounced) savedData.gmgBundles.push(url);
          savedData.gmgBundles = [...new Set(savedData.gmgBundles.map(normalizeBundleUrl).filter(Boolean))].slice(-500);
          known.add(url);
          if (observedEndAt) {
            savedData.gmgBundleExpiries[url] = { endAt: observedEndAt, updatedAt: new Date().toISOString() };
          }
          saveData();

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
module.exports.getOfferRemainingMs = getOfferRemainingMs;
module.exports.formatGMGDate = formatGMGDate;
