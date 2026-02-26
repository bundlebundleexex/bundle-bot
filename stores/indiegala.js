const puppeteer = require("puppeteer");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  let browser;

  try {
    console.log("🔎 IndieGala: sprawdzam listę bundle...");

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

    await page.goto("https://www.indiegala.com/bundles", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // ⬇️ Poczekaj aż załadują się linki
    await page.waitForSelector("a[href*='/bundle/']", { timeout: 20000 });

    // 🔥 Pobieramy wszystkie linki do bundle
    const bundleLinks = await page.$$eval(
      "a[href*='/bundle/']",
      els =>
        els
          .map(el => ({
            link: el.href,
            title: el.innerText.trim()
          }))
          // filtrujemy tylko unikalne i realne produkty
          .filter(b => b.title && b.title.length > 3 && b.link.includes("/bundle/"))
    );

    if (!bundleLinks.length) {
      console.log("❌ IndieGala: brak bundle w DOM");
      await browser.close();
      return;
    }

    console.log(`✨ IndieGala: znaleziono ${bundleLinks.length} linków`);

    if (!savedData.indiegalaBundles) savedData.indiegalaBundles = [];

    for (const b of bundleLinks) {
      if (savedData.indiegalaBundles.includes(b.link)) continue;

      console.log("🔥 Nowy IndieGala bundle:", b.title);

      // Wejdź w stronę konkretnego bundle
      await page.goto(b.link, {
        waitUntil: "networkidle2",
        timeout: 60000
      });

      const data = await page.evaluate(() => {
        const desc =
          document.querySelector("meta[property='og:description']")?.content ||
          "";
        const price =
          document.body.innerText.match(/\$\d+(\.\d+)?/)?.[0] ||
          null;
        const image =
          document.querySelector("meta[property='og:image']")?.content ||
          null;

        return { desc, price, image };
      });

      // 🛠 Zapisujemy historię
      savedData.indiegalaBundles.push(b.link);
      savedData.indiegalaBundles = [
        ...new Set(savedData.indiegalaBundles)
      ].slice(-100);
      saveData();

      // 📨 wysyłamy embed
      const channel = await client.channels.fetch(CHANNEL_ID);

      const embed = new EmbedBuilder()
        .setTitle(`🎁 ${b.title}`)
        .setURL(b.link)
        .setColor(0x9b59b6)
        .setFooter({ text: "IndieGala Bundle 🎮" })
        .setTimestamp();

      let descString = "";

      if (data.price) descString += `💰 Cena: **${data.price}**\n\n`;
      descString += data.desc.substring(0, 600);

      embed.setDescription(descString);

      if (data.image) embed.setImage(data.image);

      await channel.send({
        content: `🎉 **NOWY INDIEGALA BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 IndieGala wysłany:", b.title);
    }

    await browser.close();
  } catch (err) {
    console.log("🔥 IndieGala error:", err.message);
    if (browser) await browser.close();
  }
};