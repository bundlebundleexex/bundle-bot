const puppeteer = require("puppeteer");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function trim(text, max = 350) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

module.exports.check = async (client, savedData, saveData) => {
  let browser;

  try {
    console.log("🔎 Fanatical: pełne skanowanie (unikat)");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto("https://www.fanatical.com/en/bundle/games", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));

    const slugs = await page.$$eval(
      "a[href*='/bundle/']",
      links => {
        return [...new Set(
          links
            .map(el => el.href.split("/bundle/")[1])
            .filter(Boolean)
        )];
      }
    );

    console.log("Fanatical: znaleziono unikatowych slugów:", slugs.length);

    const validSlugs = slugs.filter(slug => {
      slug = slug.toLowerCase();
      if (slug.includes("/")) return false;
      if (["games","books","software"].includes(slug)) return false;
      if (slug.includes("mystery")) return false;
      if (slug.includes("dlc")) return false;
      return true;
    });

    if (!savedData.fanaticalBundles) {
      savedData.fanaticalBundles = [];
    }

    const newSlugs = validSlugs.filter(
      slug => !savedData.fanaticalBundles.includes(slug)
    );

    if (!newSlugs.length) {
      console.log("⏸ Fanatical: brak nowych bundle");
      await browser.close();
      return;
    }

    console.log("🔥 Nowych bundle:", newSlugs.length);

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const slug of newSlugs) {

      const url = `https://www.fanatical.com/en/bundle/${slug}`;

      await page.goto(url, {
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

      savedData.fanaticalBundles.push(slug);
      savedData.fanaticalBundles =
        [...new Set(savedData.fanaticalBundles)].slice(-100);

      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🔥 ${details.title}`)
        .setURL(url)
        .setColor(0x3498db)
        .setFooter({ text: "Fanatical Bundle 🎮" })
        .setTimestamp()
        .setDescription(
          `💰 Cena od: **${details.price || "Brak danych"}**\n\n${trim(details.description)}`
        );

      if (details.image) embed.setImage(details.image);

      await channel.send({
        content: `🔥 **NOWY FANATICAL BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed],
      });

      console.log("✔ Wysłano:", slug);
    }

    await browser.close();

  } catch (err) {
    console.log("🔥 Fanatical error:", err.message);
    if (browser) await browser.close();
  }
};