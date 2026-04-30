const { chromium } = require("playwright");

async function check(client, savedData, saveData) {
  console.log("🧪 deals0: scanning freebies...");

  let browser;

  try {
    browser = await chromium.launch({
      headless: true
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147 Safari/537.36"
    });

    await page.goto("https://gg.deals/deals/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const deals = await page.$$eval(".game-item", cards =>
      cards
        .map(card => {
          const html = card.innerHTML;
          const text = (card.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          let store = null;

          // tylko sklepy których szukamy
          if (html.includes("svg-drm-ea")) {
            store = "EA App";
          } else if (html.includes("svg-drm-microsoft-store")) {
            store = "Microsoft / Xbox";
          } else if (html.includes("svg-drm-ubisoft-connect")) {
            store = "Ubisoft Connect";
          } else if (html.includes("svg-drm-amazon")) {
            store = "Amazon Games";
          } else {
            return null;
          }

          // tylko 100% free
          const isFree =
            text.includes("-100%") &&
            text.toLowerCase().includes("free");

          if (!isFree) return null;

          const title =
            card.querySelector(".game-info-title.title")
              ?.textContent
              ?.trim() || null;

          if (!title) return null;

          return {
            store,
            title
          };
        })
        .filter(Boolean)
    );

    // dedupe
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
      await browser.close();
    }
  }
}

module.exports = { check };