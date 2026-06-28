const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer");

const AMAZON_URL = "https://gaming.amazon.com/home";
const HARD_CLEANUP = process.env.AMAZON_HARD_CLEANUP !== "0";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getClaimSlug(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/claims/")[1]?.split("/")[0] || null;
  } catch {
    return String(url).split("/claims/")[1]?.split(/[/?#]/)[0] || null;
  }
}

function isBlockedTitle(title) {
  const normalized = normalizeTitle(title);

  if (!normalized) {
    return true;
  }

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

function hardChromiumCleanup() {
  if (!HARD_CLEANUP || process.platform === "win32") {
    return;
  }

  for (const name of [
    "chromium",
    "chromium-browser",
    "chrome",
    "chrome-linux",
    "google-chrome",
    "chrome_crashpad"
  ]) {
    try {
      execFileSync("pkill", ["-9", name], { stdio: "ignore" });
    } catch {}
  }

  for (const pattern of ["chrome", "chromium", "chrome_crashpad_handler"]) {
    try {
      execFileSync("pkill", ["-9", "-f", pattern], { stdio: "ignore" });
    } catch {}
  }
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

    if (height === previousHeight) {
      break;
    }

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
      "dowiedz sie",
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

        if (line.length < 3 || line.length > 90) {
          return false;
        }

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

        if (text.length <= 500) {
          candidates.push(text);
        }

        current = current.parentElement;
      }

      for (const candidate of candidates) {
        const title = pickTitle(candidate);

        if (title) {
          return title;
        }
      }

      return null;
    }

    const links = [...document.querySelectorAll("a[href*='/claims/']")];

    for (const link of links) {
      try {
        const href = link.href;
        const slug = href.split("/claims/")[1]?.split(/[/?#]/)[0];

        if (!href || !slug || seen.has(slug)) {
          continue;
        }

        const title = getTextAroundLink(link);

        if (!title) {
          continue;
        }

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

async function main() {
  let browser = null;
  let page = null;
  let result = {
    ok: false,
    error: "Amazon worker stopped before result"
  };

  try {
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

    result = {
      ok: true,
      games
    };
  } catch (err) {
    result = {
      ok: false,
      error: err.message
    };
  } finally {
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
            proc.kill("SIGKILL");
          } catch {}
        }
      } catch {}
    }

    hardChromiumCleanup();

    process.send?.(result);

    setTimeout(() => process.exit(result.ok ? 0 : 1), 100);
  }
}

main();
