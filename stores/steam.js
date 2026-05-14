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

  // ==========================
  // HARD CHROMIUM CLEANUP
  // ==========================

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

  // ==========================
  // HARD GC
  // ==========================

  try {
    global.gc?.();

    global.gc?.();

    global.gc?.();
  } catch {}

  // ==========================
  // RAM LOG
  // ==========================

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