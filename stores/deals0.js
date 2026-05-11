const puppeteer = require("puppeteer");

async function check(client, savedData, saveData) {
  console.log("🧪 deals0: scanning freebies...");

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
      ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    await page.setRequestInterception(true);

    page.on("request", req => {
      const type = req.resourceType();

      if (
        type === "image" ||
        type === "media" ||
        type === "font"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto("https://gg.deals/deals/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector(".game-item", {
      timeout: 15000
    });

    const deals = await page.$$eval(".game-item", cards =>
      cards
        .map(card => {
          const html = card.innerHTML;

          const text = (card.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

          let store = null;

          if (html.includes("svg-drm-ea")) {
            store = "EA App";
          } else if (
            html.includes("svg-drm-microsoft-store")
          ) {
            store = "Microsoft / Xbox";
          } else if (
            html.includes("svg-drm-ubisoft-connect")
          ) {
            store = "Ubisoft Connect";
          } else if (html.includes("svg-drm-amazon")) {
            store = "Amazon Games";
          }

          if (!store) return null;

          const isFree =
            text.includes("-100%") &&
            text.includes("free");

          if (!isFree) return null;

          const title = card
            .querySelector(".game-info-title.title")
            ?.textContent?.trim();

          if (!title) return null;

          return {
            store,
            title
          };
        })
        .filter(Boolean)
    );

    const seen = new Set();

    const unique = deals.filter(item => {
      const key = `${item.store}|${item.title}`;

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    });

    console.log("========== DEALS0 ==========");
    console.log(unique);
    console.log("============================");

    savedData.deals0 = unique;

    saveData();

    console.log(`✅ deals0: ${unique.length}`);
  } catch (err) {
    console.log("❌ deals0:", err.message);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    global.gc?.();
  }
}

module.exports = { check };