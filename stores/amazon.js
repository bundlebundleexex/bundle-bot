const puppeteer = require("puppeteer");
const { execFileSync } = require("child_process");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = process.env.AMAZON_CHANNEL_ID || "1499461446365352017";
const ROLE_ID = process.env.AMAZON_ROLE_ID || "1499461776604004392";

const AMAZON_URL = "https://gaming.amazon.com/home";
const SEND_INITIAL = process.env.AMAZON_SEND_INITIAL === "1";
const HARD_CLEANUP = process.env.AMAZON_HARD_CLEANUP !== "0";
const MAX_SAVED_KEYS = 1200;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getClaimSlug(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/claims/")[1]?.split("/")[0] || null;
  } catch {
    return String(url).split("/claims/")[1]?.split(/[/?#]/)[0] || null;
  }
}

function getGameKeys(game) {
  const keys = [];
  const titleKey = normalizeTitle(game.title);
  const slug = getClaimSlug(game.url);

  if (titleKey) keys.push(`title:${titleKey}`);
  if (slug) keys.push(`slug:${slug}`);

  return keys;
}

function collectKnownKeys(rawAmazonData) {
  const keys = new Set();

  for (const item of rawAmazonData || []) {
    if (!item) continue;

    if (typeof item === "string") {
      keys.add(item);

      const slug = getClaimSlug(item);
      const isLegacyPlainSlug =
        !item.includes(":") && !item.includes("/") && item.length > 2;

      if (slug) keys.add(`slug:${slug}`);
      else if (isLegacyPlainSlug) keys.add(`slug:${item}`);

      continue;
    }

    if (typeof item === "object") {
      for (const key of getGameKeys(item)) keys.add(key);
      if (item.key) keys.add(String(item.key));
      if (item.slug) keys.add(`slug:${item.slug}`);
    }
  }

  return keys;
}

function isKnownGame(game, knownKeys) {
  const keys = getGameKeys(game);
  return keys.length > 0 && keys.some(key => knownKeys.has(key));
}

function saveKnownKeys(savedData, knownKeys, saveData) {
  savedData.amazon = [...knownKeys].slice(-MAX_SAVED_KEYS);
  saveData();
}

function isBlockedTitle(title) {
  const normalized = normalizeTitle(title);

  if (!normalized) return true;

  const blocked = [
    "conditions of use",
    "privacy notice",
    "privacy policy",
    "terms of use",
    "terms and conditions",
    "interest-based ads",
    "help",
    "support",
    "account",
    "sign in",
    "log in",
    "learn more",
    "prime gaming",
    "included with prime",
    "cookie",
    "cookies",
    "notification"
  ];

  return blocked.some(word => normalized.includes(word));
}

function compactGames(games) {
  const byTitle = new Map();
  const bySlug = new Set();

  for (const game of games) {
    const titleKey = normalizeTitle(game.title);
    const slug = getClaimSlug(game.url);

    if (!titleKey || !slug || bySlug.has(slug) || isBlockedTitle(game.title)) {
      continue;
    }

    if (!byTitle.has(titleKey)) {
      byTitle.set(titleKey, game);
      bySlug.add(slug);
    }
  }

  return [...byTitle.values()];
}

async function setupAbortClose(options, browserRef) {
  const signal = options.signal;

  if (!signal) return () => {};

  const closeBrowser = async () => {
    try {
      await browserRef.current?.close();
    } catch {}
  };

  if (signal.aborted) {
    await closeBrowser();
    return () => {};
  }

  signal.addEventListener("abort", closeBrowser, { once: true });

  return () => {
    signal.removeEventListener("abort", closeBrowser);
  };
}

function hardChromiumCleanup() {
  if (!HARD_CLEANUP || process.platform === "win32") return;

  for (const name of ["chromium", "chrome", "chrome-linux"]) {
    try {
      execFileSync("pkill", ["-9", name], { stdio: "ignore" });
    } catch {}
  }
}

function logMemoryCleanup() {
  try {
    global.gc?.();
    global.gc?.();

    const used = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`🧹 Amazon cleanup (${used} MB)`);
  } catch {}
}

async function scrapePrimeGames(page) {
  await page.goto(AMAZON_URL, {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });

  await sleep(3000);

  let previousHeight = 0;

  for (let i = 0; i < 6; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);

    await page.evaluate(() => {
      window.scrollBy(0, 2500);
    });

    await sleep(900);

    if (height === previousHeight) break;

    previousHeight = height;
  }

  const games = await page.evaluate(() => {
    const found = [];
    const seen = new Set();

    const blacklist = [
      "claim",
      "odbierz",
      "pobierz",
      "play",
      "graj",
      "included with prime",
      "prime gaming",
      "cookie",
      "cookies",
      "plikach cookie",
      "powiadomienie",
      "notification",
      "learn more",
      "dowiedz sie",
      "dowiedz się",
      "conditions of use",
      "privacy notice",
      "privacy policy",
      "terms of use",
      "terms and conditions",
      "interest-based ads",
      "help",
      "support",
      "account",
      "sign in",
      "log in"
    ];

    function pickTitle(text) {
      const lines = String(text || "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

      return lines.find(line => {
        const lower = line.toLowerCase();

        if (line.length < 3 || line.length > 90) return false;

        return !blacklist.some(word => lower.includes(word));
      });
    }

    function getTextAroundLink(link) {
      const candidates = [
        link.getAttribute("aria-label"),
        link.getAttribute("title"),
        link.innerText
      ];

      let current = link.parentElement;

      for (let i = 0; i < 3 && current; i++) {
        const text = current.innerText || "";

        if (text.length <= 500) candidates.push(text);

        current = current.parentElement;
      }

      for (const candidate of candidates) {
        const title = pickTitle(candidate);
        if (title) return title;
      }

      return null;
    }

    const links = [...document.querySelectorAll("a[href*='/claims/']")];

    for (const link of links) {
      try {
        const href = link.href;
        const slug = href.split("/claims/")[1]?.split(/[/?#]/)[0];

        if (!href || !slug || seen.has(slug)) continue;

        const title = getTextAroundLink(link);

        if (!title) continue;

        seen.add(slug);

        found.push({
          title,
          url: href
        });
      } catch {}
    }

    return found;
  });

  return compactGames(games);
}

async function check(client, savedData, saveData, options = {}) {
  console.log("🟠 Amazon: sprawdzam Prime freebies...");

  savedData.amazon ??= [];

  let browser = null;
  let page = null;
  const browserRef = { current: null };
  let removeAbortListener = () => {};

  try {
    removeAbortListener = await setupAbortClose(options, browserRef);

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--mute-audio",
        "--blink-settings=imagesEnabled=false"
      ]
    });

    browserRef.current = browser;

    page = await browser.newPage();

    page.setDefaultNavigationTimeout(20000);
    page.setDefaultTimeout(15000);

    await page.setCacheEnabled(false);

    await page.setViewport({
      width: 1366,
      height: 900
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    const games = await scrapePrimeGames(page);

    const knownKeys = collectKnownKeys(savedData.amazon);
    const currentKeys = new Set(games.flatMap(getGameKeys));
    const fresh = games.filter(game => !isKnownGame(game, knownKeys));

    console.log(
      `📊 Amazon: found=${games.length} knownKeys=${knownKeys.size} fresh=${fresh.length}`
    );

    if (!games.length) {
      console.log("⚠️ Amazon: nie znaleziono gier, nie ruszam cache");
      return;
    }

    if (!knownKeys.size && !SEND_INITIAL) {
      saveKnownKeys(savedData, currentKeys, saveData);

      console.log(
        `🌱 Amazon: pierwszy run, zapisuję ${games.length} gier bez wysyłania`
      );
      console.log("ℹ️ Aby wysłać wszystko przy pustym cache: AMAZON_SEND_INITIAL=1");

      return;
    }

    if (!fresh.length) {
      for (const key of currentKeys) knownKeys.add(key);

      saveKnownKeys(savedData, knownKeys, saveData);

      console.log("⏸ Amazon: bez zmian");
      console.log(`✅ Amazon: ${games.length}`);

      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of fresh) {
      try {
        const embed = new EmbedBuilder()
          .setColor("#FF9900")
          .setAuthor({ name: "Amazon Prime Gaming" })
          .setTitle(`🎮 ${game.title}`)
          .setURL(game.url)
          .setDescription("🔥 **Nowa darmowa gra do odebrania**")
          .setFooter({ text: "Amazon Prime Freebie" })
          .setTimestamp();

        const button = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("🎁 Odbierz grę")
            .setStyle(ButtonStyle.Link)
            .setURL(game.url)
        );

        await channel.send({
          content: `<@&${ROLE_ID}>`,
          embeds: [embed],
          components: [button]
        });

        for (const key of getGameKeys(game)) knownKeys.add(key);

        saveKnownKeys(savedData, knownKeys, saveData);

        console.log("📨 Wysłano:", game.title);
      } catch (err) {
        console.log("Amazon item error:", err.message);
      }
    }

    for (const game of games) {
      if (isKnownGame(game, knownKeys)) {
        for (const key of getGameKeys(game)) knownKeys.add(key);
      }
    }

    saveKnownKeys(savedData, knownKeys, saveData);

    console.log(`✅ Amazon: ${games.length}`);
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("❌ Amazon:", err.message);
  } finally {
    removeAbortListener();

    if (page) {
      try {
        await page.close();
      } catch {}
    }

    if (browser) {
      try {
        const proc = browser.process();

        try {
          await browser.close();
        } catch {}

        if (proc && !proc.killed) {
          try {
            proc.kill();
          } catch {}
        }
      } catch {}
    }

    hardChromiumCleanup();
    logMemoryCleanup();
  }
}

module.exports = {
  check
};