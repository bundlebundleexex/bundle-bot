require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");

const fs = require("fs");
const path = require("path");

// stores
const humble = require("./stores/humble");
const steam = require("./stores/steam");
const fanatical = require("./stores/fanatical");
const gmg = require("./stores/gmg");
const indiegala = require("./stores/indiegala");
const digiphile = require("./stores/digiphile");

const epic = require("./stores/epic");
const epicDeals = require("./stores/epicdeals");

const freeDeals = require("./stores/freeDeals");
const gog = require("./stores/gog");

const amazon = require("./stores/amazon");
const deals0 = require("./stores/deals0");

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

const CHECK_INTERVAL = 15 * 60 * 1000;
const STORE_DELAY = 1500;
const CLEANUP_INTERVAL = 70 * 60 * 1000;
const STORE_TIMEOUT = Number(process.env.STORE_TIMEOUT_MS || 90 * 1000);

// Optional:
// MEMORY_RESTART_MB=450 - restart process when RSS reaches this value.
// EXIT_ON_STORE_TIMEOUT=1 - restart process when a store gets stuck.
const MEMORY_RESTART_MB = Number(process.env.MEMORY_RESTART_MB || 0);
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

function logMemory(label) {
  const memory = getMemoryMb();

  console.log(
    `🧠 RAM ${label}: rss=${memory.rss} MB | heap=${memory.heapUsed}/${memory.heapTotal} MB | external=${memory.external} MB | buffers=${memory.arrayBuffers} MB`
  );

  if (MEMORY_RESTART_MB > 0 && memory.rss >= MEMORY_RESTART_MB) {
    console.log(
      `♻️ RAM przekroczył ${MEMORY_RESTART_MB} MB - kończę proces do restartu`
    );

    gracefulExit(1, "memory limit");
  }
}

function memoryCleanup() {
  try {
    if (global.gc) {
      global.gc();
    } else if (!gcNoticeShown) {
      console.log(
        "ℹ️ GC niedostępne - uruchom bota przez: node --expose-gc index.js"
      );

      gcNoticeShown = true;
    }

    logMemory("cleanup");
  } catch (err) {
    console.log("❌ memoryCleanup:", err.message);
  }
}

function clearCheckTimer() {
  if (checkTimer) {
    clearTimeout(checkTimer);
    checkTimer = null;
  }
}

function scheduleNextRun(delayMs) {
  clearCheckTimer();

  const safeDelay = Math.max(delayMs, 1000);
  const minutes = Math.ceil(safeDelay / 1000 / 60);

  console.log(`⏱️ Następne sprawdzanie za ${minutes} min`);

  checkTimer = setTimeout(async () => {
    checkTimer = null;

    await runChecks();

    scheduleNextRun(isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL);
  }, safeDelay);
}

function gracefulExit(code, reason) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`👋 Zamykanie bota (${reason})`);

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
    deals0: []
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
      console.log("⚠️ data.json uszkodzony - resetuję");

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
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${DATA_PATH}.tmp`;
    const json = JSON.stringify(savedData, null, 2);

    fs.writeFileSync(tempPath, json);
    fs.renameSync(tempPath, DATA_PATH);
  } catch (err) {
    console.log("❌ saveData:", err.message);
  }
}

// ==========================
// STORES
// ==========================

const STORES = [
  {
    name: "Humble",
    fn: humble.check
  },

  {
    name: "Steam",
    fn: steam.check
  },

  {
    name: "Fanatical",
    fn: fanatical.check
  },

  {
    name: "GMG",
    fn: gmg.check
  },

  {
    name: "IndieGala",
    fn: indiegala.check
  },

  {
    name: "Digiphile",
    fn: digiphile.check
  },

  {
    name: "Deals0",
    fn: deals0.check
  },

  {
    name: "Epic",
    fn: epic.check
  },

  {
    name: "EpicDeals",
    fn: epicDeals.check
  },

  {
    name: "FreeDeals",
    fn: freeDeals.check
  },

  {
    name: "GOG",
    fn: gog.check
  },

  {
    name: "Amazon",
    fn: amazon.check
  }
];

// ==========================
// RUN CHECKS
// ==========================

async function runStoreWithTimeout(store) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  let timeoutId = null;
  let timedOut = false;

  const task = Promise.resolve().then(() =>
    store.fn(
      client,
      savedData,
      saveData,
      controller ? { signal: controller.signal } : undefined
    )
  );

  activeStoreTasks.add(task);

  task.then(
    () => {
      if (timedOut) {
        console.log(`ℹ️ ${store.name}: spóźnione zadanie zakończone`);
      }
    },
    err => {
      if (timedOut) {
        console.log(
          `⚠️ ${store.name}: spóźniony błąd po timeout: ${err.message}`
        );
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

      reject(new Error(`Store timeout po ${STORE_TIMEOUT / 1000}s`));
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
}

async function runChecks() {
  if (isShuttingDown) {
    return;
  }

  // sleep mode
  if (isSleepMode()) {
    console.log(`🌙 Sleep mode (${getTime()})`);
    memoryCleanup();

    return;
  }

  if (isRunning) {
    console.log("⏳ Poprzednie sprawdzanie jeszcze trwa...");

    return;
  }

  if (activeStoreTasks.size > 0) {
    console.log(
      `⏳ Czekam na spóźnione zadania sklepów: ${activeStoreTasks.size}`
    );

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
    console.log(`\n🔎 START sprawdzania - ${getTime()}`);
    logMemory("start");

    for (const store of STORES) {
      const storeStart = Date.now();
      let storeTimedOut = false;

      try {
        await runStoreWithTimeout(store);
      } catch (err) {
        storeTimedOut = err.message.startsWith("Store timeout");

        console.log(`❌ ${store.name}:`, err.message);
      }

      const duration = ((Date.now() - storeStart) / 1000).toFixed(1);

      console.log(`⏱ ${store.name}: ${duration}s`);

      if (global.gc) {
        global.gc();
      }

      logMemory(store.name);

      if (storeTimedOut) {
        console.log(
          `⛔ ${store.name}: przerywam ten cykl, żeby nie dokładać kolejnych zadań w tle`
        );

        if (EXIT_ON_STORE_TIMEOUT) {
          gracefulExit(1, `${store.name} timeout`);
        }

        break;
      }

      await sleep(STORE_DELAY);
    }

    const total = ((Date.now() - startedAt) / 1000).toFixed(1);
    const ram = getMemoryMb();

    console.log(`✅ Sprawdzanie zakończone (${total}s | ${ram.rss} MB)`);
  } finally {
    isRunning = false;

    if (global.gc) {
      global.gc();
    }
  }
}

// ==========================
// READY
// ==========================

client.once("clientReady", async () => {
  console.log(`🤖 Zalogowano jako ${client.user.tag}`);

  loadData();

  console.log(`📄 Data path: ${DATA_PATH}`);

  if (!global.gc) {
    console.log(
      "ℹ️ GC niedostępne. Dla lepszego cleanupu uruchom: node --expose-gc index.js"
    );
    gcNoticeShown = true;
  }

  // first run
  await runChecks();

  // cyclic checks
  scheduleNextRun(isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL);

  // RAM cleanup
  cleanupTimer = setInterval(() => {
    if (!isRunning) {
      memoryCleanup();
    }
  }, CLEANUP_INTERVAL);

  console.log("⏱️ Sprawdzanie ustawione co 15 minut");
});

// ==========================
// ERROR HANDLING
// ==========================

process.on("unhandledRejection", err => {
  console.error("❌ Unhandled promise rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("❌ Uncaught exception:", err);
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