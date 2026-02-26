const puppeteer = require("puppeteer");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
  let browser;

  try {
    console.log("🔎 Digiphile: sprawdzam kolekcje...");

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

    await page.goto("https://www.digiphile.co/collections", {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 5000));

    // 🔥 Pobierz wszystkie aktywne kolekcje
    const collections = await page.evaluate(() => {

      const cards = Array.from(document.querySelectorAll("a"));

      return cards
        .filter(a =>
          a.innerText.includes("Get Collection Now") &&
          !a.innerText.includes("Ended")
        )
        .map(a => {
          const title =
            a.querySelector("h3, h2, div")?.innerText?.trim() ||
            a.innerText.split("Get Collection Now")[0].trim();

          const priceMatch = a.innerText.match(/\$\d+/);
          const price = priceMatch ? priceMatch[0] : null;

          const image =
            a.querySelector("img")?.src || null;

          return {
            title,
            link: a.href,
            price,
            image
          };
        })
        .filter(c => c.title && c.link);
    });

    if (!collections.length) {
      console.log("❌ Digiphile: brak aktywnych kolekcji");
      await browser.close();
      return;
    }

    console.log(`✨ Digiphile: znaleziono ${collections.length} aktywnych`);

    if (!savedData.digiphileCollections) {
      savedData.digiphileCollections = [];
    }

    for (const c of collections) {

      if (savedData.digiphileCollections.includes(c.link)) continue;

      console.log("🔥 Nowa kolekcja Digiphile:", c.title);

      savedData.digiphileCollections.push(c.link);
      savedData.digiphileCollections =
        [...new Set(savedData.digiphileCollections)].slice(-100);

      saveData();

      const channel = await client.channels.fetch(CHANNEL_ID);

      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${c.title}`)
        .setURL(c.link)
        .setColor(0x3498DB)
        .setFooter({ text: "Digiphile Collection 🎮" })
        .setTimestamp();

      let desc = "";

      if (c.price) desc += `💰 Cena od: **${c.price}**\n\n`;

      embed.setDescription(desc || "Nowa kolekcja dostępna na Digiphile!");

      if (c.image) embed.setImage(c.image);

      await channel.send({
        content: `🔥 **NOWA KOLEKCJA DIGIPHILE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("🚀 Digiphile wysłana:", c.title);
    }

    await browser.close();

  } catch (err) {
    console.log("🔥 Digiphile error:", err.message);
    if (browser) await browser.close();
  }
};