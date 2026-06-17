require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { execFileSync } = require("child_process");

const fs = require("fs");
const path = require("path");

// Store modules are loaded lazily during scans. This keeps the idle process
// lighter, especially at night, because heavy modules like puppeteer are not
// kept in memory from startup.

// ==========================
// CLIENT
// ==========================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ==========================
// CONFIG
// ==========================

const TIME_ZONE = "Europe/Warsaw";

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 15 * 60 * 1000);
const STORE_DELAY = Number(process.env.STORE_DELAY_MS || 1500);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL_MS || 70 * 60 * 1000);
const STORE_TIMEOUT = Number(process.env.STORE_TIMEOUT_MS || 90 * 1000);

// Post-scan flush:
// POST_SCAN_GC_RUNS=5          - how many forced GC passes after each full scan
// POST_SCAN_RESTART_MB=260     - restart after scan if RSS is still above this
// MEMORY_RESTART_MB=260        - accepted as an alias for POST_SCAN_RESTART_MB
// POST_SCAN_KILL_CHROME=0      - disable Linux Chromium cleanup
// RESTART_COOLDOWN_MS=1200000  - skip immediate scan after memory restart
const POST_SCAN_GC_RUNS = Math.max(
  1,
  Number(process.env.POST_SCAN_GC_RUNS || 5)
);
const POST_SCAN_RESTART_MB = Number(
  process.env.POST_SCAN_RESTART_MB || process.env.MEMORY_RESTART_MB || 0
);
const POST_SCAN_KILL_CHROME = process.env.POST_SCAN_KILL_CHROME !== "0";
const PURGE_STORE_CACHE = process.env.PURGE_STORE_CACHE !== "0";
const RESTART_COOLDOWN_MS = Number(
  process.env.RESTART_COOLDOWN_MS || 20 * 60 * 1000
);
const SKIP_FIRST_RUN_AFTER_RESTART =
  process.env.SKIP_FIRST_RUN_AFTER_RESTART !== "0";

const EXIT_ON_STORE_TIMEOUT = process.env.EXIT_ON_STORE_TIMEOUT === "1";

const DATA_PATH = fs.existsSync("/data")
  ? "/data/data.json"
  : path.join(__dirname, "data.json");

// ==========================
// STATE
// ==========================

let savedData = {};

let isRunning = false;
let isShuttingDown = false;
let gcNoticeShown = false;
let checkTimer = null;
let cleanupTimer = null;
let lastStoreTimeoutAt = 0;

const activeStoreTasks = new Set();

// ==========================
// HELPERS
// ==========================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getWarsawTimeParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = type =>
    Number(parts.find(part => part.type === type)?.value ?? 0);

  return {
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second")
  };
}

// sleep mode 00:00 -> 10:00
function isSleepMode() {
  const { hour } = getWarsawTimeParts();

  return hour >= 0 && hour < 10;
}

function msUntilWakeModeEnds() {
  if (!isSleepMode()) {
    return CHECK_INTERVAL;
  }

  const { hour, minute, second } = getWarsawTimeParts();
  const wakeAtSeconds = 10 * 60 * 60;
  const currentSeconds = hour * 60 * 60 + minute * 60 + second;
  const secondsLeft = wakeAtSeconds - currentSeconds;

  return Math.max((secondsLeft + 5) * 1000, 60 * 1000);
}

function getTime() {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function getMemoryMb() {
  const memory = process.memoryUsage();

  return {
    rss: Math.round(memory.rss / 1024 / 1024),
    heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
    external: Math.round(memory.external / 1024 / 1024),
    arrayBuffers: Math.round(memory.arrayBuffers / 1024 / 1024)
  };
}

function formatMemory(memory) {
  return (
    `rss=${memory.rss} MB | ` +
    `heap=${memory.heapUsed}/${memory.heapTotal} MB | ` +
    `external=${memory.external} MB | ` +
    `buffers=${memory.arrayBuffers} MB`
  );
}

function logMemory(label) {
  console.log(`RAM ${label}: ${formatMemory(getMemoryMb())}`);
}

async function runGcPasses(passes) {
  if (!global.gc) {
    if (!gcNoticeShown) {
      console.log("GC unavailable. Start with: node --expose-gc index.js");
      gcNoticeShown = true;
    }

    return;
  }

  for (let i = 0; i < passes; i++) {
    global.gc();
    await sleep(150);
  }
}

function hardChromeCleanup() {
  if (!POST_SCAN_KILL_CHROME || process.platform === "win32") {
    return;
  }

  for (const name of ["chromium", "chrome", "chrome-linux"]) {
    try {
      execFileSync("pkill", ["-9", name], {
        stdio: "ignore"
      });
    } catch {}
  }
}

async function memoryFlush(reason, options = {}) {
  const before = getMemoryMb();

  if (options.killChrome) {
    hardChromeCleanup();
  }

  await runGcPasses(options.gcRuns || POST_SCAN_GC_RUNS);
  await sleep(250);

  const after = getMemoryMb();
  const diff = before.rss - after.rss;

  console.log(
    `Memory flush (${reason}): before ${formatMemory(before)} -> after ${formatMemory(
      after
    )} | rss_delta=${diff} MB`
  );

  return after;
}

async function memoryCleanup(reason = "interval") {
  try {
    await memoryFlush(reason, {
      gcRuns: Math.max(2, POST_SCAN_GC_RUNS),
      killChrome: true
    });
  } catch (err) {
    console.log("memoryCleanup error:", err.message);
  }
}

function markMemoryRestart(reason, memory) {
  savedData.runtime ??= {};
  savedData.runtime.lastMemoryRestartAt = Date.now();
  savedData.runtime.lastMemoryRestartReason = reason;
  savedData.runtime.lastMemoryRestartRss = memory?.rss || null;
  saveData();
}

function shouldSkipFirstRunAfterMemoryRestart() {
  if (!SKIP_FIRST_RUN_AFTER_RESTART) {
    return false;
  }

  const lastRestartAt = Number(savedData.runtime?.lastMemoryRestartAt || 0);

  if (!lastRestartAt) {
    return false;
  }

  return Date.now() - lastRestartAt < RESTART_COOLDOWN_MS;
}

function clearCheckTimer() {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

function scheduleNextRun(delayMs) {
  if (isShuttingDown) {
    return;
  }

  clearCheckTimer();

  const safeDelay = Math.max(delayMs, 1000);
  const minutes = Math.ceil(safeDelay / 1000 / 60);

  console.log(`Next scan in ${minutes} min`);

  checkTimer = setTimeout(async () => {
    checkTimer = null;

    await runChecks();

    if (!isShuttingDown) {
      scheduleNextRun(isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL);
    }
  }, safeDelay);
}

function gracefulExit(code, reason) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`Shutting down bot (${reason})`);

  clearCheckTimer();

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  try {
    saveData();
  } catch {}

  try {
    client.destroy();
  } catch {}

  setTimeout(() => process.exit(code), 500);
}

// ==========================
// LOAD / SAVE
// ==========================

function ensureDataShape() {
  let changed = false;

  const defaults = {
    humbleBundles: [],
    humbleChoice: null,
    fanaticalBundles: [],
    gmgBundles: [],
    indiegalaBundles: [],
    digiphileCollections: [],
    epicGames: [],
    epicDeals: [],
    freeDeals: [],
    gogGames: [],
    steamGames: [],
    amazon: [],
    deals0: [],
    runtime: {}
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (savedData[key] === undefined) {
      savedData[key] = Array.isArray(value) ? [] : value;
      changed = true;
    }
  }

  return changed;
}

function loadData() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

      savedData =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
    } catch {
      console.log("data.json is damaged - resetting state");

      savedData = {};
    }
  }

  if (ensureDataShape()) {
    saveData();
  }
}

function saveData() {
  try {
    const dir = path.dirname(DATA_PATH);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {
        recursive: true
      });
    }

    const tempPath = `${DATA_PATH}.tmp`;
    const json = JSON.stringify(savedData, null, 2);

    fs.writeFileSync(tempPath, json);
    fs.renameSync(tempPath, DATA_PATH);
  } catch (err) {
    console.log("saveData error:", err.message);
  }
}

// ==========================
// STORES
// ==========================

const STORES = [
  {
    name: "Humble",
    modulePath: "./stores/humble"
  },
  {
    name: "Steam",
    modulePath: "./stores/steam"
  },
  {
    name: "Fanatical",
    modulePath: "./stores/fanatical"
  },
  {
    name: "GMG",
    modulePath: "./stores/gmg"
  },
  {
    name: "IndieGala",
    modulePath: "./stores/indiegala"
  },
  {
    name: "Digiphile",
    modulePath: "./stores/digiphile"
  },
  {
    name: "Deals0",
    modulePath: "./stores/deals0"
  },
  {
    name: "Epic",
    modulePath: "./stores/epic"
  },
  {
    name: "FreeDeals",
    modulePath: "./stores/freeDeals"
  },
  {
    name: "GOG",
    modulePath: "./stores/gog"
  },
  {
    name: "Amazon",
    modulePath: "./stores/amazon"
  }
];

// ==========================
// RUN CHECKS
// ==========================

function loadStoreCheck(store) {
  const resolved = require.resolve(store.modulePath);
  const storeModule = require(resolved);
  const check = storeModule.check || storeModule;

  if (typeof check !== "function") {
    throw new Error(`${store.name} does not export check()`);
  }

  return {
    check,
    resolved
  };
}

function purgeCacheByIncludes(parts) {
  for (const id of Object.keys(require.cache)) {
    if (parts.some(part => id.includes(part))) {
      delete require.cache[id];
    }
  }
}

function purgeStoreCache(store, resolved) {
  if (!PURGE_STORE_CACHE) {
    return;
  }

  try {
    delete require.cache[resolved || require.resolve(store.modulePath)];
  } catch {}

  if (store.name === "Amazon") {
    purgeCacheByIncludes([
      `${path.sep}node_modules${path.sep}puppeteer`,
      `${path.sep}node_modules${path.sep}@puppeteer`,
      `${path.sep}node_modules${path.sep}puppeteer-core`,
      `${path.sep}node_modules${path.sep}chromium-bidi`,
      `${path.sep}node_modules${path.sep}devtools-protocol`
    ]);
  }

  if (store.name === "Digiphile") {
    purgeCacheByIncludes([
      `${path.sep}node_modules${path.sep}cheerio`,
      `${path.sep}node_modules${path.sep}htmlparser2`,
      `${path.sep}node_modules${path.sep}domhandler`,
      `${path.sep}node_modules${path.sep}domutils`
    ]);
  }
}

async function runStoreWithTimeout(store) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  let timeoutId = null;
  let timedOut = false;
  let resolved = null;

  const task = Promise.resolve().then(() => {
    const loaded = loadStoreCheck(store);
    resolved = loaded.resolved;

    return loaded.check(
      client,
      savedData,
      saveData,
      controller ? { signal: controller.signal } : undefined
    );
  });

  activeStoreTasks.add(task);

  task.then(
    () => {
      if (timedOut) {
        console.log(`${store.name}: late task finished`);
      }
    },
    err => {
      if (timedOut) {
        console.log(`${store.name}: late error after timeout: ${err.message}`);
      }
    }
  ).finally(() => {
    activeStoreTasks.delete(task);
  });

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      lastStoreTimeoutAt = Date.now();

      if (controller) {
        controller.abort();
      }

      reject(new Error(`Store timeout after ${STORE_TIMEOUT / 1000}s`));
    }, STORE_TIMEOUT);
  });

  try {
    await Promise.race([task, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (!timedOut) {
      activeStoreTasks.delete(task);
    }
  }

  return {
    resolved,
    timedOut
  };
}

async function runChecks() {
  if (isShuttingDown) {
    return;
  }

  if (isSleepMode()) {
    console.log(`Sleep mode (${getTime()})`);
    await memoryCleanup("sleep mode");
    return;
  }

  if (isRunning) {
    console.log("Previous scan is still running");
    return;
  }

  if (activeStoreTasks.size > 0) {
    console.log(`Waiting for late store tasks: ${activeStoreTasks.size}`);

    if (
      EXIT_ON_STORE_TIMEOUT &&
      lastStoreTimeoutAt > 0 &&
      Date.now() - lastStoreTimeoutAt > STORE_TIMEOUT
    ) {
      gracefulExit(1, "stuck store task");
    }

    return;
  }

  isRunning = true;

  const startedAt = Date.now();

  try {
    console.log(`\nSTART scan - ${getTime()}`);
    logMemory("start");

    for (const store of STORES) {
      const storeStart = Date.now();
      let storeTimedOut = false;
      let storeResult = null;

      try {
        storeResult = await runStoreWithTimeout(store);
      } catch (err) {
        storeTimedOut = err.message.startsWith("Store timeout");

        console.log(`${store.name}: ${err.message}`);
      }

      const duration = ((Date.now() - storeStart) / 1000).toFixed(1);

      console.log(`${store.name}: ${duration}s`);

      if (!storeTimedOut) {
        purgeStoreCache(store, storeResult?.resolved);
      }

      await runGcPasses(1);
      logMemory(store.name);

      if (storeTimedOut) {
        console.log(
          `${store.name}: stopping this scan to avoid stacking background tasks`
        );

        if (EXIT_ON_STORE_TIMEOUT) {
          gracefulExit(1, `${store.name} timeout`);
        }

        break;
      }

      await sleep(STORE_DELAY);
    }

    const total = ((Date.now() - startedAt) / 1000).toFixed(1);
    const ramBeforeFlush = getMemoryMb();

    console.log(`Scan finished (${total}s | ${ramBeforeFlush.rss} MB before flush)`);

    const ramAfterFlush = await memoryFlush("post-scan", {
      gcRuns: POST_SCAN_GC_RUNS,
      killChrome: true
    });

    if (POST_SCAN_RESTART_MB > 0 && ramAfterFlush.rss >= POST_SCAN_RESTART_MB) {
      console.log(
        `RSS still above ${POST_SCAN_RESTART_MB} MB after flush - restarting process for Railway`
      );

      markMemoryRestart("post-scan memory limit", ramAfterFlush);
      gracefulExit(1, "post-scan memory limit");
    }
  } finally {
    isRunning = false;
  }
}

// ==========================
// READY
// ==========================

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  loadData();

  console.log(`Data path: ${DATA_PATH}`);

  if (!global.gc) {
    console.log("GC unavailable. For Railway use start: node --expose-gc index.js");
    gcNoticeShown = true;
  }

  if (shouldSkipFirstRunAfterMemoryRestart()) {
    console.log(
      `Recent memory restart detected - skipping immediate first scan for ${Math.ceil(
        RESTART_COOLDOWN_MS / 60000
      )} min cooldown`
    );
  } else {
    await runChecks();
  }

  scheduleNextRun(isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL);

  cleanupTimer = setInterval(() => {
    if (!isRunning) {
      memoryCleanup("interval");
    }
  }, CLEANUP_INTERVAL);

  console.log("Scan interval set");
});

// ==========================
// ERROR HANDLING
// ==========================

process.on("unhandledRejection", err => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err);
  gracefulExit(1, "uncaught exception");
});

process.on("SIGINT", () => {
  gracefulExit(0, "SIGINT");
});

process.on("SIGTERM", () => {
  gracefulExit(0, "SIGTERM");
});

// ==========================
// LOGIN
// ==========================

client.login(process.env.TOKEN);
