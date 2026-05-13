const puppeteer = require("puppeteer");

let browser = null;
let launching = false;

async function getBrowser() {
  if (browser) {
    try {
      await browser.version();
      return browser;
    } catch {
      browser = null;
    }
  }

  if (launching) {
    while (launching) {
      await new Promise(r => setTimeout(r, 500));
    }

    return browser;
  }

  launching = true;

  try {
    browser = await puppeteer.launch({
      headless: "new",

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",

        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--disable-sync",
        "--mute-audio",
        "--no-first-run",
        "--disable-features=site-per-process"
      ]
    });

    browser.on("disconnected", () => {
      console.log("⚠ Browser disconnected");
      browser = null;
    });

    console.log("🌐 Shared browser launched");

    return browser;
  } finally {
    launching = false;
  }
}

async function restartBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch {}

    browser = null;

    console.log("🔄 Browser restarted");
  }
}

module.exports = {
  getBrowser,
  restartBrowser
};