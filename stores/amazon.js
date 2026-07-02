const axios = require("axios");
const cheerio = require("cheerio");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = process.env.AMAZON_CHANNEL_ID || "1499461446365352017";
const ROLE_ID = process.env.AMAZON_ROLE_ID || "1499461776604004392";

const AMAZON_CLAIM_URL =
  process.env.AMAZON_CLAIM_URL || "https://luna.amazon.pl/claims/home";

const SEND_INITIAL = process.env.AMAZON_SEND_INITIAL === "1";
const MAX_SAVED_KEYS = 1200;
const MAX_ARTICLES = Number(process.env.AMAZON_ARTICLE_LIMIT || 5);

const SOURCE_PAGES = [
  "https://www.thesun.co.uk/tech/",
  "https://www.thesun.ie/tech/"
];

const FALLBACK_ARTICLES = [
  "https://www.thesun.co.uk/tech/39374553/amazon-prime-subscribers-new-freebies/",
  "https://www.thesun.ie/tech/17089796/amazon-prime-subscribers-new-freebies/"
];

const axiosInstance = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Accept-Language": "en-GB,en;q=0.9,pl;q=0.8"
  }
});

// ==========================
// HELPERS
// ==========================

function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/\s+[–-]\s+.*$/, "")
    .replace(/^[*:•\-\s]+/, "")
    .replace(/[.;:,]+$/, "")
    .trim();
}

function isBlockedTitle(title) {
  const normalized = normalizeTitle(title);

  if (!normalized || normalized.length < 3 || normalized.length > 90) {
    return true;
  }

  const blocked = [
    "amazon",
    "amazon prime",
    "prime gaming",
    "amazon luna",
    "free games",
    "free games with prime",
    "luna controller",
    "the luna website",
    "the giveaways",
    "in addition",
    "prime members",
    "available throughout the month",
    "already released",
    "launching",
    "typically priced",
    "playstation",
    "xbox",
    "nintendo switch",
    "steam and epic",
    "pc titles",
    "advertisement",
    "recommended stories"
  ];

  return blocked.some(word => normalized.includes(word));
}

function getArticleKey(articleUrl, title) {
  return `source:thesun:title:${normalizeTitle(title)}:${articleUrl}`;
}

function parseDateFromText(text, publishedDate) {
  const source = String(text || "");
  const year = publishedDate?.getFullYear?.() || new Date().getFullYear();
  const monthNames = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11
  };

  const untilMatch = source.match(
    /\b(?:until|before|by|through)\s+([A-Z][a-z]+)\s+(\d{1,2})\b/
  );

  if (untilMatch) {
    const month = monthNames[untilMatch[1].toLowerCase()];
    const day = Number(untilMatch[2]);

    if (month !== undefined && day > 0) {
      const date = new Date(Date.UTC(year, month, day, 23, 59, 59));

      return {
        exact: true,
        text: formatDate(date)
      };
    }
  }

  if (/available throughout the month/i.test(source)) {
    return {
      exact: false,
      text: "do końca miesiąca wg artykułu"
    };
  }

  return {
    exact: false,
    text: "brak dokładnej daty w źródle"
  };
}

function parseReleaseText(text) {
  const source = String(text || "");
  const launchMatch = source.match(/\blaunching\s+([A-Z][a-z]+\s+\d{1,2})/i);

  if (launchMatch) {
    return `od ${launchMatch[1]}`;
  }

  if (/already released/i.test(source)) {
    return "już dostępne";
  }

  if (/available (?:to play |on pc |for free |now)/i.test(source)) {
    return "już dostępne";
  }

  return null;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function getMeta($, name) {
  return (
    $(`meta[property='${name}']`).attr("content") ||
    $(`meta[name='${name}']`).attr("content") ||
    null
  );
}

function getPublishedDate($) {
  const raw =
    getMeta($, "article:published_time") ||
    $("time[datetime]").first().attr("datetime") ||
    null;

  if (!raw) {
    return null;
  }

  const date = new Date(raw);

  return Number.isNaN(date.getTime()) ? null : date;
}

function extractTitleFromLine(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();

  if (!text) {
    return null;
  }

  const bulletMatch = text.match(
    /^([A-Z0-9][A-Za-z0-9'’:.!&+®™\-\s]+?)\s+[–-]\s+(?:already released|launching|available|until)\b/i
  );

  if (bulletMatch) {
    return cleanTitle(bulletMatch[1]);
  }

  const patterns = [
    /\b(?:Leading the way is|is award-winning action game)\s+([A-Z0-9][A-Za-z0-9'’:.!&+®™\-\s]+?)(?:,| which|\.|$)/i,
    /\b([A-Z0-9][A-Za-z0-9'’:.!&+®™\-\s]+?)\s+is available (?:to play |on PC |for free |now)/i,
    /\b(?:Launching on PC today, is|available to Prime members for free from today\.?|is)\s+([A-Z0-9][A-Za-z0-9'’:.!&+®™\-\s]+?)(?:\.|,| which| available|$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return cleanTitle(match[1]);
    }
  }

  if (/Mega Man is back/i.test(text)) {
    return "Mega Man 11";
  }

  if (/G\.?I\.?\s*Joe/i.test(text) && /Wrath of Cobra/i.test(text)) {
    return "G.I. Joe: Wrath of Cobra";
  }

  return null;
}

function dedupeGames(games) {
  const map = new Map();

  for (const game of games) {
    const title = cleanTitle(game.title);
    const key = normalizeTitle(title);

    if (!title || !key || isBlockedTitle(title)) {
      continue;
    }

    if (!map.has(key)) {
      map.set(key, {
        ...game,
        title
      });
    }
  }

  return [...map.values()];
}

// ==========================
// SOURCE SCAN
// ==========================

async function findAmazonArticles() {
  const found = new Map();

  for (const url of SOURCE_PAGES) {
    try {
      const { data } = await axiosInstance.get(url);
      const $ = cheerio.load(data);

      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().replace(/\s+/g, " ").trim();
        const haystack = `${href || ""} ${text}`.toLowerCase();

        if (
          href &&
          haystack.includes("amazon") &&
          haystack.includes("prime") &&
          /(freebies|free games|games|luna)/i.test(haystack)
        ) {
          const absolute = href.startsWith("http")
            ? href
            : new URL(href, url).toString();

          found.set(absolute.split("#")[0], text || absolute);
        }
      });
    } catch (err) {
      console.log("Amazon source page error:", err.message);
    }
  }

  for (const url of FALLBACK_ARTICLES) {
    found.set(url, url);
  }

  return [...found.keys()].slice(0, MAX_ARTICLES);
}

async function parseArticle(url) {
  const { data } = await axiosInstance.get(url);
  const $ = cheerio.load(data);

  const articleTitle =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    getMeta($, "og:title") ||
    url;

  const image = getMeta($, "og:image");
  const publishedDate = getPublishedDate($);
  const gameLines = [];

  $("article li, main li, article p, main p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();

    if (
      text &&
      /(prime|amazon|luna|available|launching|released|free|game)/i.test(text)
    ) {
      gameLines.push(text);
    }
  });

  const games = [];

  for (const line of gameLines) {
    const title = extractTitleFromLine(line);

    if (!title) {
      continue;
    }

    const until = parseDateFromText(line, publishedDate);
    const release = parseReleaseText(line);

    games.push({
      title,
      url: AMAZON_CLAIM_URL,
      sourceUrl: url,
      sourceTitle: articleTitle,
      sourceImage: image,
      untilText: until.text,
      hasExactUntil: until.exact,
      releaseText: release
    });
  }

  return {
    url,
    title: articleTitle,
    image,
    games: dedupeGames(games)
  };
}

async function getSteamImage(title) {
  try {
    const { data } = await axiosInstance.get(
      "https://store.steampowered.com/api/storesearch/",
      {
        params: {
          term: title,
          cc: "us",
          l: "en"
        },
        timeout: 10000
      }
    );

    const items = Array.isArray(data?.items) ? data.items : [];
    const titleKey = normalizeTitle(title);
    const best =
      items.find(item => normalizeTitle(item.name) === titleKey) ||
      items.find(item => {
        const itemKey = normalizeTitle(item.name);

        return itemKey.includes(titleKey) || titleKey.includes(itemKey);
      }) ||
      items[0];

    if (!best?.id) {
      return best?.tiny_image || null;
    }

    try {
      const details = await axiosInstance.get(
        "https://store.steampowered.com/api/appdetails",
        {
          params: {
            appids: best.id,
            filters: "basic",
            cc: "us",
            l: "en"
          },
          timeout: 10000
        }
      );

      return (
        details.data?.[best.id]?.data?.header_image ||
        best.tiny_image ||
        null
      );
    } catch {
      return best.tiny_image || null;
    }
  } catch {
    return null;
  }
}

async function enrichImages(games) {
  for (const game of games) {
    game.image = (await getSteamImage(game.title)) || game.sourceImage || null;
  }

  return games;
}

function collectKnownKeys(rawAmazonData) {
  const keys = new Set();

  for (const item of rawAmazonData || []) {
    if (!item) {
      continue;
    }

    if (typeof item === "string") {
      keys.add(item);
      continue;
    }

    if (typeof item === "object") {
      if (item.key) {
        keys.add(String(item.key));
      }

      if (item.title) {
        keys.add(`title:${normalizeTitle(item.title)}`);
      }
    }
  }

  return keys;
}

function saveKnownKeys(savedData, knownKeys, saveData) {
  savedData.amazon = [...knownKeys].slice(-MAX_SAVED_KEYS);
  saveData();
}

// ==========================
// MAIN
// ==========================

async function check(client, savedData, saveData) {
  console.log("Amazon: scanning Prime/Luna freebies via news sources...");

  savedData.amazon ??= [];

  try {
    const articles = await findAmazonArticles();
    const allGames = [];

    for (const articleUrl of articles) {
      try {
        const article = await parseArticle(articleUrl);

        console.log(
          `Amazon source: ${article.games.length} games from ${article.url}`
        );

        allGames.push(...article.games);
      } catch (err) {
        console.log("Amazon article error:", err.message);
      }
    }

    const games = dedupeGames(allGames);
    const knownKeys = collectKnownKeys(savedData.amazon);
    const hasNewsCache = [...knownKeys].some(key =>
      String(key).startsWith("source:thesun:")
    );
    const fresh = games.filter(
      game => !knownKeys.has(getArticleKey(game.sourceUrl, game.title))
    );

    console.log(
      `Amazon: articles=${articles.length} games=${games.length} known=${knownKeys.size} fresh=${fresh.length}`
    );

    if (!games.length) {
      console.log("Amazon: no games found, keeping cache unchanged");

      return;
    }

    if (!hasNewsCache && !SEND_INITIAL) {
      for (const game of games) {
        knownKeys.add(getArticleKey(game.sourceUrl, game.title));
      }

      saveKnownKeys(savedData, knownKeys, saveData);

      console.log(
        "Amazon: first news-source run, saved current games without sending. Set AMAZON_SEND_INITIAL=1 to send initial batch."
      );

      return;
    }

    if (!fresh.length) {
      console.log("Amazon: no changes");

      return;
    }

    await enrichImages(fresh);

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of fresh) {
      try {
        const lines = [
          "**Nowa gra/oferta Amazon Prime/Luna**",
          `**Do kiedy:** ${game.untilText}`
        ];

        if (game.releaseText) {
          lines.push(`**Status:** ${game.releaseText}`);
        }

        lines.push(`[Źródło](${game.sourceUrl})`);

        const embed = new EmbedBuilder()
          .setColor("#FF9900")
          .setAuthor({
            name: "Amazon Prime / Luna"
          })
          .setTitle(game.title)
          .setURL(AMAZON_CLAIM_URL)
          .setDescription(lines.join("\n"))
          .setFooter({
            text: "Amazon source scan"
          })
          .setTimestamp();

        if (game.image) {
          embed.setImage(game.image);
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Otwórz Amazon/Luna")
            .setStyle(ButtonStyle.Link)
            .setURL(AMAZON_CLAIM_URL),
          new ButtonBuilder()
            .setLabel("Źródło")
            .setStyle(ButtonStyle.Link)
            .setURL(game.sourceUrl)
        );

        await channel.send({
          content: `<@&${ROLE_ID}>`,
          embeds: [embed],
          components: [row]
        });

        knownKeys.add(getArticleKey(game.sourceUrl, game.title));
        saveKnownKeys(savedData, knownKeys, saveData);

        console.log("Amazon sent:", game.title);
      } catch (err) {
        console.log("Amazon item error:", err.message);
      }
    }
  } catch (err) {
    console.log("Amazon error:", err.response?.status || err.message);
  } finally {
    global.gc?.();
  }
}

module.exports = {
  check
};
