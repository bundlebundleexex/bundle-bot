const { chromium } = require("playwright");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = "1499461446365352017";
const ROLE_ID = "1499461776604004392";

async function check(client, savedData, saveData) {
  console.log("🟠 Amazon: sprawdzam Prime freebies...");

  let browser;

  try {
    browser = await chromium.launch({
      headless: true
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    });

    await page.goto("https://gaming.amazon.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const games = await page.evaluate(() => {
      const found = [];
      const seen = new Set();

      const links = [...document.querySelectorAll("a[href]")];

      for (const a of links) {
        const text = a.innerText?.trim();
        const href = a.href;

        if (!text || !href) continue;
        if (!href.includes("/claims/")) continue;
        if (!text.includes("Odbierz grę")) continue;
        if (text === "Odbierz grę") continue;

        const title = text.split("\n")[0].trim();

        if (!title) continue;
        if (seen.has(title)) continue;

        seen.add(title);

        found.push({
          title,
          url: href,
          store: "Amazon Prime"
        });
      }

      return found;
    });

    const old = savedData.amazon || [];
    const oldTitles = new Set(old.map(x => x.title));

    const fresh = games.filter(x => !oldTitles.has(x.title));

    if (fresh.length > 0) {
      const channel = await client.channels.fetch(CHANNEL_ID);

      for (const game of fresh) {
        let image = null;

        try {
          const claimPage = await browser.newPage();

          await claimPage.goto(game.url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
          });

          image = await claimPage
            .$eval('meta[property="og:image"]', el => el.content)
            .catch(() => null);

          await claimPage.close();
        } catch {
          image = null;
        }

        const embed = new EmbedBuilder()
          .setColor("#FF9900")
          .setAuthor({
            name: "Amazon Prime Gaming"
          })
          .setTitle(`🎮 ${game.title}`)
          .setURL(game.url)
          .setDescription("🔥 **Nowa darmowa gra do odebrania**")
          .setFooter({
            text: "Amazon Prime Freebie"
          })
          .setTimestamp();

        if (image) {
          embed.setImage(image);
        }

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

        console.log("📨 Wysłano:", game.title);
      }
    } else {
      console.log("⏸ Amazon: bez zmian");
    }

    savedData.amazon = games;
    saveData();

    console.log(`✅ Amazon: ${games.length}`);
  } catch (err) {
    console.log("❌ Amazon:", err.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { check };