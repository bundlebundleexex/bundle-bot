const puppeteer = require("puppeteer");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  let browser;

  try {
    console.log("🔎 Fanatical: sprawdzam nowe bundle");

    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    await page.goto("https://www.fanatical.com/en/bundle/games", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await page.waitForSelector("a[href*='/bundle/'] img", {
      timeout: 20000
    });

    const bundleLinks = await page.$$eval(
      "a[href*='/bundle/']",
      links =>
        links
          .filter(el => el.querySelector("img"))
          .map(el => el.href)
    );

    const validBundles = bundleLinks.filter(link => {
      const parts = link.split("/bundle/");
      if (!parts[1]) return false;

      const slug = parts[1].toLowerCase();

      if (slug.includes("/")) return false;
      if (["", "games", "books", "software"].includes(slug)) return false;
      if (slug.includes("mystery")) return false;
      if (slug.includes("dlc")) return false;

      return true;
    });

    if (!validBundles.length) {
      await browser.close();
      return;
    }

    if (!savedData.fanaticalBundles) {
      savedData.fanaticalBundles = [];
    }

    let newBundleLink = null;
    let newSlug = null;

    for (const link of validBundles) {
      const slug = link.split("/bundle/")[1];
      if (!savedData.fanaticalBundles.includes(slug)) {
        newBundleLink = link;
        newSlug = slug;
        break;
      }
    }

    if (!newBundleLink) {
      console.log("⏸ Fanatical: brak nowych bundle");
      await browser.close();
      return;
    }

    console.log("🔥 Nowy Fanatical bundle:", newBundleLink);

    await page.goto(newBundleLink, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    const details = await page.evaluate(() => {
      const title =
        document.querySelector("h1")?.innerText.trim() ||
        "Fanatical Bundle";

      const price =
        document.querySelector("[data-testid='price']")?.innerText.trim() ||
        document.querySelector(".price")?.innerText.trim() ||
        null;

      const image =
        document.querySelector("meta[property='og:image']")?.content ||
        null;

      const description =
        document.querySelector("meta[property='og:description']")?.content ||
        "";

      return { title, price, image, description };
    });

    savedData.fanaticalBundles.push(newSlug);
    savedData.fanaticalBundles =
      [...new Set(savedData.fanaticalBundles)].slice(-50);

    saveData();

    await browser.close();

    const channel = await client.channels.fetch(CHANNEL_ID);

    const embed = new EmbedBuilder()
      .setTitle(`🔥 ${details.title}`)
      .setURL(newBundleLink)
      .setColor(0x3498db)
      .setFooter({ text: "Fanatical Bundle 🎮" })
      .setTimestamp();

    let desc = "";

    if (details.price) {
      desc += `💰 Cena od: **${details.price}**\n\n`;
    }

    desc += details.description.substring(0, 400);

    embed.setDescription(desc);

    if (details.image) {
      embed.setImage(details.image);
    }

    await channel.send({
      content: `🔥 **NOWY FANATICAL BUNDLE!** <@&${ROLE_ID}>`,
      embeds: [embed],
    });

  } catch (err) {
    console.log("🔥 Fanatical error:", err.message);
    if (browser) await browser.close();
  }
};