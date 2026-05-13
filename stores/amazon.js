const { getBrowser } = require("../browser");

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

  let page = null;

  try {
    const browser = await getBrowser();

    page = await browser.newPage();

    page.setDefaultNavigationTimeout(30000);

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    await page.setRequestInterception(true);

    page.on("request", req => {
      const type = req.resourceType();

      if (
        type === "image" ||
        type === "media" ||
        type === "font" ||
        type === "stylesheet"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto("https://gaming.amazon.com/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 2500);
      });

      await new Promise(r => setTimeout(r, 1000));
    }

    const games = await page.evaluate(() => {
      const found = [];
      const seen = new Set();

      const links = [
        ...document.querySelectorAll("a[href*='/claims/']")
      ];

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
        "notification"
      ];

      for (const a of links) {
        const href = a.href;
        const text = a.innerText?.trim();

        if (!href || !text) continue;

        const slug = href
          .split("/claims/")[1]
          ?.split(/[?#]/)[0];

        if (!slug) continue;
        if (seen.has(slug)) continue;

        const lines = text
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean);

        const title = lines.find(line => {
          const lower = line.toLowerCase();

          if (line.length < 3) return false;
          if (line.length > 80) return false;

          if (blacklist.some(word => lower.includes(word))) {
            return false;
          }

          return true;
        });

        if (!title) continue;

        seen.add(slug);

        found.push({
          title,
          url: href
        });
      }

      return found;
    });

    const old = savedData.amazon || [];

    const oldKeys = new Set(
      old.map(x =>
        x.url?.split("/claims/")[1]?.split(/[?#]/)[0]
      )
    );

    const fresh = games.filter(game => {
      const slug = game.url
        .split("/claims/")[1]
        ?.split(/[?#]/)[0];

      return slug && !oldKeys.has(slug);
    });

    if (fresh.length > 0) {
      const channel = await client.channels.fetch(CHANNEL_ID);

      for (const game of fresh) {
        let image = null;
        let claimPage = null;

        try {
          claimPage = await browser.newPage();

          claimPage.setDefaultNavigationTimeout(15000);

          await claimPage.setRequestInterception(true);

          claimPage.on("request", req => {
            const type = req.resourceType();

            if (
              type === "image" ||
              type === "media" ||
              type === "font" ||
              type === "stylesheet"
            ) {
              req.abort();
            } else {
              req.continue();
            }
          });

          await claimPage.goto(game.url, {
            waitUntil: "domcontentloaded",
            timeout: 15000
          });

          image = await claimPage.evaluate(() => {
            return (
              document
                .querySelector('meta[property="og:image"]')
                ?.getAttribute("content") || null
            );
          });
        } catch {
          image = null;
        } finally {
          if (claimPage) {
            try {
              await claimPage.close();
            } catch {}
          }
        }

        const embed = new EmbedBuilder()
          .setColor("#FF9900")
          .setAuthor({
            name: "Amazon Prime Gaming"
          })
          .setTitle(`🎮 ${game.title}`)
          .setURL(game.url)
          .setDescription(
            "🔥 **Nowa darmowa gra do odebrania**"
          )
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
    if (page) {
      try {
        await page.close();
      } catch {}
    }

    global.gc?.();
  }
}

module.exports = { check };