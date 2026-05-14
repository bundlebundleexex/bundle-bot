async function fetchSteamDBFree() {
  let browser = null;

  let page = null;

  try {
    browser =
      await puppeteer.launch({
        headless: true,

        args: [
          "--no-sandbox",

          "--disable-setuid-sandbox",

          "--disable-dev-shm-usage",

          "--disable-gpu",

          "--no-zygote",

          "--disable-extensions",

          "--disable-background-networking",

          "--disable-background-timer-throttling",

          "--disable-renderer-backgrounding",

          "--disable-sync",

          "--mute-audio"
        ]
      });

    page =
      await browser.newPage();

    page.setDefaultNavigationTimeout(
      15000
    );

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36"
    );

    await page.setRequestInterception(
      true
    );

    page.on(
      "request",

      req => {
        const type =
          req.resourceType();

        if (
          type === "image" ||
          type === "media" ||
          type === "font"
        ) {
          req.abort();
        } else {
          req.continue();
        }
      }
    );

    await page.goto(
      "https://steamdb.info/upcoming/free/",

      {
        waitUntil:
          "domcontentloaded",

        timeout: 15000
      }
    );

    await new Promise(r =>
      setTimeout(r, 2000)
    );

    const html =
      await page.evaluate(
        () =>
          document.body.innerHTML
      );

    if (
      !html ||
      html.length < 1000
    ) {
      throw new Error(
        "SteamDB empty HTML"
      );
    }

    const $ =
      cheerio.load(html);

    const games = [];

    const seen =
      new Set();

    $("a[href*='/app/']").each(
      (_, el) => {
        try {
          const href =
            $(el).attr(
              "href"
            ) || "";

          const match =
            href.match(
              /\/app\/(\d+)\//
            );

          if (!match) {
            return;
          }

          const appid =
            match[1];

          if (
            seen.has(
              appid
            )
          ) {
            return;
          }

          if (
            PERMA_F2P.has(
              appid
            )
          ) {
            return;
          }

          const name = $(el)
            .text()
            .trim();

          if (
            !name ||
            name.length < 2
          ) {
            return;
          }

          const areaText =
            $(el)
              .closest("tr")
              .text() || "";

          if (
            !/Free to Keep/i.test(
              areaText
            )
          ) {
            return;
          }

          seen.add(appid);

          games.push({
            appid,

            name,

            url: `https://store.steampowered.com/app/${appid}/`
          });
        } catch {}
      }
    );

    return games;

  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }

    if (browser) {
      try {
        const proc =
          browser.process();

        try {
          await browser.close();
        } catch {}

        try {
          proc?.kill("SIGKILL");
        } catch {}
      } catch {}
    }

    // HARD CHROMIUM CLEANUP

    try {
      execSync(
        "pkill -9 chromium || true"
      );

      execSync(
        "pkill -9 chrome || true"
      );

      execSync(
        "pkill -9 chrome-linux || true"
      );

      execSync(
        "pkill -9 puppeteer || true"
      );
    } catch {}

    // HARD GC

    try {
      global.gc?.();

      global.gc?.();

      global.gc?.();
    } catch {}

    // RAM LOG

    try {
      const used = Math.round(
        process.memoryUsage().rss /
          1024 /
          1024
      );

      console.log(
        `🧹 Steam cleanup (${used} MB)`
      );
    } catch {}
  }
}