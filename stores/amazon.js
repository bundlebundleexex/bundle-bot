const puppeteer = require("puppeteer");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID =
  "1499461446365352017";

const ROLE_ID =
  "1499461776604004392";

// ==========================
// MAIN
// ==========================

async function check(
  client,
  savedData,
  saveData
) {
  console.log(
    "🟠 Amazon: sprawdzam Prime freebies..."
  );

  let browser = null;

  let page = null;

  try {
    browser =
      await puppeteer.launch({
        headless: "new",

        args: [
          "--no-sandbox",

          "--disable-setuid-sandbox",

          "--disable-dev-shm-usage",

          "--disable-gpu",

          "--no-zygote",

          // ❌ removed single-process
          // powodował detached frames

          "--disable-extensions",

          "--disable-background-networking",

          "--disable-background-timer-throttling",

          "--disable-renderer-backgrounding",

          "--disable-sync",

          "--mute-audio",

          // stabilniejsze chromium
          "--disable-features=site-per-process"
        ]
      });

    page =
      await browser.newPage();

    page.setDefaultNavigationTimeout(
      20000
    );

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    // ❌ bez request interception
    // Amazon źle działa z interception

    await page.goto(
      "https://gaming.amazon.com/home",

      {
        waitUntil:
          "domcontentloaded",

        timeout: 20000
      }
    );

    // stabilizacja React DOM
    await new Promise(r =>
      setTimeout(r, 3000)
    );

    // lazy loading
    for (
      let i = 0;
      i < 4;
      i++
    ) {
      try {
        await page.evaluate(
          () => {
            window.scrollBy(
              0,
              2500
            );
          }
        );

        await new Promise(r =>
          setTimeout(r, 1000)
        );
      } catch {
        break;
      }
    }

    const games =
      await page.evaluate(() => {
        const found =
          [];

        const seen =
          new Set();

        const links = [
          ...document.querySelectorAll(
            "a[href*='/claims/']"
          )
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
          try {
            const href =
              a.href;

            const text =
              a.innerText?.trim();

            if (
              !href ||
              !text
            ) {
              continue;
            }

            const slug =
              href
                .split(
                  "/claims/"
                )[1]
                ?.split(
                  /[?#]/
                )[0];

            if (!slug) {
              continue;
            }

            if (
              seen.has(slug)
            ) {
              continue;
            }

            const lines =
              text
                .split("\n")
                .map(x =>
                  x.trim()
                )
                .filter(Boolean);

            const title =
              lines.find(
                line => {
                  const lower =
                    line.toLowerCase();

                  if (
                    line.length <
                    3
                  ) {
                    return false;
                  }

                  if (
                    line.length >
                    80
                  ) {
                    return false;
                  }

                  if (
                    blacklist.some(
                      word =>
                        lower.includes(
                          word
                        )
                    )
                  ) {
                    return false;
                  }

                  return true;
                }
              );

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

    const old =
      savedData.amazon ||
      [];

    const oldKeys =
      new Set(
        old.map(x =>
          x.url
            ?.split(
              "/claims/"
            )[1]
            ?.split(/[?#]/)[0]
        )
      );

    const fresh =
      games.filter(game => {
        const slug =
          game.url
            .split(
              "/claims/"
            )[1]
            ?.split(/[?#]/)[0];

        return (
          slug &&
          !oldKeys.has(slug)
        );
      });

    if (fresh.length > 0) {
      const channel =
        await client.channels.fetch(
          CHANNEL_ID
        );

      for (const game of fresh) {
        try {
          const embed =
            new EmbedBuilder()
              .setColor(
                "#FF9900"
              )

              .setAuthor({
                name:
                  "Amazon Prime Gaming"
              })

              .setTitle(
                `🎮 ${game.title}`
              )

              .setURL(
                game.url
              )

              .setDescription(
                "🔥 **Nowa darmowa gra do odebrania**"
              )

              .setFooter({
                text:
                  "Amazon Prime Freebie"
              })

              .setTimestamp();

          const button =
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel(
                  "🎁 Odbierz grę"
                )

                .setStyle(
                  ButtonStyle.Link
                )

                .setURL(
                  game.url
                )
            );

          await channel.send({
            content: `<@&${ROLE_ID}>`,

            embeds: [embed],

            components: [button]
          });

          console.log(
            "📨 Wysłano:",
            game.title
          );
        } catch (e) {
          console.log(
            "Amazon item error:",
            e.message
          );
        }
      }
    } else {
      console.log(
        "⏸ Amazon: bez zmian"
      );
    }

    savedData.amazon =
      games;

    saveData();

    console.log(
      `✅ Amazon: ${games.length}`
    );
  } catch (err) {
    console.log(
      "❌ Amazon:",
      err.message
    );
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }

    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    global.gc?.();
  }
}

module.exports = {
  check
};