require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { execFileSync, fork } = require("child_process");

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

const SCAN_WORKER_MODE = process.env.SCAN_WORKER === "1";
const USE_SCAN_WORKER =
  process.env.USE_SCAN_WORKER !== "0" && !SCAN_WORKER_MODE;

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL_MS || 15 * 60 * 1000);
const STORE_DELAY = Number(process.env.STORE_DELAY_MS || 1500);
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL_MS || 70 * 60 * 1000);
const STORE_TIMEOUT = Number(process.env.STORE_TIMEOUT_MS || 90 * 1000);
const AMAZON_INTERVAL_MS = Number(
  process.env.AMAZON_INTERVAL_MS || 6 * 60 * 60 * 1000
);

// Post-scan flush:
// POST_SCAN_GC_RUNS=5          - how many forced GC passes after each full scan
// POST_SCAN_RESTART_MB=260     - restart after scan if RSS is still above this
// MEMORY_RESTART_MB=260        - accepted as an alias for POST_SCAN_RESTART_MB
// POST_SCAN_KILL_CHROME=0      - disable Linux Chromium cleanup
// PROCESS_RESTART_ENABLED=1    - allow process.exit restarts on Railway
// RESTART_AFTER_SCAN=1         - restart after every finished scan, needs PROCESS_RESTART_ENABLED=1
// RESTART_COOLDOWN_MS=1200000  - skip immediate scan after memory restart
const POST_SCAN_GC_RUNS = Math.max(
  1,
  Number(process.env.POST_SCAN_GC_RUNS || 5)
);
const POST_SCAN_RESTART_MB = Number(
  process.env.POST_SCAN_RESTART_MB || process.env.MEMORY_RESTART_MB || 230
);
const POST_SCAN_KILL_CHROME = process.env.POST_SCAN_KILL_CHROME !== "0";
const PROCESS_RESTART_ENABLED = process.env.PROCESS_RESTART_ENABLED === "1";
const RESTART_AFTER_SCAN =
  PROCESS_RESTART_ENABLED && process.env.RESTART_AFTER_SCAN === "1";
const RESTART_COOLDOWN_MS = Number(
  process.env.RESTART_COOLDOWN_MS || 20 * 60 * 1000
);
const SKIP_FIRST_RUN_AFTER_RESTART =
  process.env.SKIP_FIRST_RUN_AFTER_RESTART !== "0";
const DAILY_RESTART_ENABLED =
  PROCESS_RESTART_ENABLED && process.env.DAILY_RESTART_ENABLED === "1";
const DAILY_RESTART_HOUR = Number(process.env.DAILY_RESTART_HOUR || 3);
const DAILY_RESTART_MINUTE = Number(process.env.DAILY_RESTART_MINUTE || 5);

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
let maintenanceRestartTimer = null;
let parentScanTimer = null;
let scanWorkerProcess = null;
let parentSchedulerStarted = false;
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

function readMemoryFileMb(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8").trim();

    if (!raw || raw === "max") {
      return null;
    }

    const bytes = Number(raw);

    if (!Number.isFinite(bytes) || bytes <= 0) {
      return null;
    }

    return Math.round(bytes / 1024 / 1024);
  } catch {
    return null;
  }
}

function getContainerMemoryMb() {
  return (
    readMemoryFileMb("/sys/fs/cgroup/memory.current") ??
    readMemoryFileMb("/sys/fs/cgroup/memory/memory.usage_in_bytes")
  );
}

function formatMemory(memory) {
  const container = getContainerMemoryMb();
  const containerText =
    container !== null ? ` | container=${container} MB` : "";

  return (
    `rss=${memory.rss} MB | ` +
    `heap=${memory.heapUsed}/${memory.heapTotal} MB | ` +
    `external=${memory.external} MB | ` +
    `buffers=${memory.arrayBuffers} MB` +
    containerText
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

  const names = [
    "chromium",
    "chromium-browser",
    "chrome",
    "chrome-linux",
    "google-chrome",
    "chrome_crashpad"
  ];

  for (const name of names) {
    try {
      execFileSync("pkill", ["-9", name], {
        stdio: "ignore"
      });
    } catch {}
  }

  const commandPatterns = [
    "chrome",
    "chromium",
    "chrome_crashpad_handler",
    "puppeteer"
  ];

  for (const pattern of commandPatterns) {
    try {
      execFileSync("pkill", ["-9", "-f", pattern], {
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
    const memoryAfterFlush = await memoryFlush(reason, {
      gcRuns: Math.max(2, POST_SCAN_GC_RUNS),
      killChrome: true
    });

    const containerAfterFlush = getContainerMemoryMb();
    const memoryForRestart = Math.max(
      memoryAfterFlush.rss,
      containerAfterFlush || 0
    );

    if (POST_SCAN_RESTART_MB > 0 && memoryForRestart >= POST_SCAN_RESTART_MB) {
      const message =
        `Idle memory still above ${POST_SCAN_RESTART_MB} MB after flush ` +
        `(rss=${memoryAfterFlush.rss} MB, container=${
          containerAfterFlush ?? "unknown"
        } MB)`;

      if (!PROCESS_RESTART_ENABLED) {
        console.log(`${message} - restart disabled, keeping bot online`);
        return;
      }

      console.log(`${message} - restarting process for Railway`);

      markMemoryRestart(`${reason} memory limit`, memoryAfterFlush);
      gracefulExit(1, `${reason} memory limit`);
    }
  } catch (err) {
    console.log("memoryCleanup error:", err.message);
  }
}

function markMemoryRestart(reason, memory) {
  savedData.runtime ??= {};
  savedData.runtime.lastMemoryRestartAt = Date.now();
  savedData.runtime.lastMemoryRestartReason = reason;
  savedData.runtime.lastMemoryRestartRss = memory?.rss || null;
  savedData.runtime.lastMemoryRestartContainer = getContainerMemoryMb();
  saveData();
}

function shouldSkipFirstRunAfterMemoryRestart() {
  if (!SKIP_FIRST_RUN_AFTER_RESTART) {
    return false;
  }

  return getMemoryRestartCooldownLeft() > 0;
}

function getMemoryRestartCooldownLeft() {
  const lastRestartAt = Number(savedData.runtime?.lastMemoryRestartAt || 0);

  if (!lastRestartAt) {
    return 0;
  }

  return Math.max(RESTART_COOLDOWN_MS - (Date.now() - lastRestartAt), 0);
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

function msUntilDailyRestart() {
  const { hour, minute, second } = getWarsawTimeParts();
  const currentSeconds = hour * 3600 + minute * 60 + second;
  const targetSeconds = DAILY_RESTART_HOUR * 3600 + DAILY_RESTART_MINUTE * 60;
  let secondsLeft = targetSeconds - currentSeconds;

  if (secondsLeft <= 0) {
    secondsLeft += 24 * 3600;
  }

  return secondsLeft * 1000;
}

function requestDailyRestart() {
  maintenanceRestartTimer = null;

  if (isRunning) {
    console.log("Daily restart waiting for current scan to finish");
    maintenanceRestartTimer = setTimeout(requestDailyRestart, 60 * 1000);
    return;
  }

  console.log("Daily maintenance restart starting");
  gracefulExit(1, "daily maintenance restart");
}

function scheduleDailyRestart() {
  if (!DAILY_RESTART_ENABLED || isShuttingDown) {
    return;
  }

  if (maintenanceRestartTimer) {
    clearTimeout(maintenanceRestartTimer);
  }

  const delay = msUntilDailyRestart();
  const hours = (delay / 3600000).toFixed(1);

  console.log(
    `Daily restart scheduled for ${String(DAILY_RESTART_HOUR).padStart(2, "0")}:${String(
      DAILY_RESTART_MINUTE
    ).padStart(2, "0")} Europe/Warsaw (in ${hours}h)`
  );

  maintenanceRestartTimer = setTimeout(requestDailyRestart, delay);
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

  if (maintenanceRestartTimer) {
    clearTimeout(maintenanceRestartTimer);
    maintenanceRestartTimer = null;
  }

  clearParentScanTimer();

  if (scanWorkerProcess && !scanWorkerProcess.killed) {
    try {
      scanWorkerProcess.kill("SIGKILL");
    } catch {}

    scanWorkerProcess = null;
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
    modulePath: "./stores/amazon",
    minIntervalMs: AMAZON_INTERVAL_MS
  }
];

// ==========================
// RUN CHECKS
// ==========================

const loadedStores = new Map();

function loadStoreCheck(store) {
  if (loadedStores.has(store.modulePath)) {
    return loadedStores.get(store.modulePath);
  }

  const resolved = require.resolve(store.modulePath);
  const storeModule = require(resolved);
  const check = storeModule.check || storeModule;

  if (typeof check !== "function") {
    throw new Error(`${store.name} does not export check()`);
  }

  const loaded = { check, resolved };
  loadedStores.set(store.modulePath, loaded);

  return loaded;
}

function getStoreIntervalLeft(store) {
  if (!store.minIntervalMs || store.minIntervalMs <= 0) {
    return 0;
  }

  const lastRuns = savedData.runtime?.lastStoreRunAt || {};
  const lastRunAt = Number(lastRuns[store.name] || 0);

  if (!lastRunAt) {
    return 0;
  }

  return Math.max(store.minIntervalMs - (Date.now() - lastRunAt), 0);
}

function markStoreRun(store) {
  if (!store.minIntervalMs || store.minIntervalMs <= 0) {
    return;
  }

  savedData.runtime ??= {};
  savedData.runtime.lastStoreRunAt ??= {};
  savedData.runtime.lastStoreRunAt[store.name] = Date.now();

  saveData();
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
      const intervalLeft = getStoreIntervalLeft(store);

      if (intervalLeft > 0) {
        console.log(
          `${store.name}: skipped, next run in ${Math.ceil(
            intervalLeft / 60000
          )} min`
        );

        continue;
      }

      const storeStart = Date.now();
      let storeTimedOut = false;

      try {
        await runStoreWithTimeout(store);
        markStoreRun(store);
      } catch (err) {
        storeTimedOut = err.message.startsWith("Store timeout");

        console.log(`${store.name}: ${err.message}`);
      }

      const duration = ((Date.now() - storeStart) / 1000).toFixed(1);

      console.log(`${store.name}: ${duration}s`);

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
    const containerAfterFlush = getContainerMemoryMb();
    const memoryForRestart = Math.max(
      ramAfterFlush.rss,
      containerAfterFlush || 0
    );

    if (RESTART_AFTER_SCAN) {
      console.log("Restart after scan enabled - restarting process for Railway");

      markMemoryRestart("restart after scan", ramAfterFlush);
      gracefulExit(1, "restart after scan");

      return;
    }

    if (POST_SCAN_RESTART_MB > 0 && memoryForRestart >= POST_SCAN_RESTART_MB) {
      const message =
        `Memory still above ${POST_SCAN_RESTART_MB} MB after flush ` +
        `(rss=${ramAfterFlush.rss} MB, container=${
          containerAfterFlush ?? "unknown"
        } MB)`;

      if (!PROCESS_RESTART_ENABLED) {
        console.log(`${message} - restart disabled, keeping bot online`);
        return;
      }

      console.log(`${message} - restarting process for Railway`);

      markMemoryRestart("post-scan memory limit", ramAfterFlush);
      gracefulExit(1, "post-scan memory limit");
    }
  } finally {
    isRunning = false;
  }
}

// ==========================
// WORKER SCHEDULER
// ==========================

function clearParentScanTimer() {
  if (parentScanTimer) {
    clearTimeout(parentScanTimer);
    parentScanTimer = null;
  }
}

function scheduleNextParentScan(delayMs) {
  if (isShuttingDown) {
    return;
  }

  clearParentScanTimer();

  const safeDelay = Math.max(delayMs, 1000);
  const minutes = Math.ceil(safeDelay / 1000 / 60);

  console.log(`Parent: next worker scan in ${minutes} min`);

  parentScanTimer = setTimeout(() => {
    parentScanTimer = null;
    runParentScanCycle();
  }, safeDelay);
}

function runParentScanCycle() {
  if (isShuttingDown) {
    return;
  }

  if (isSleepMode()) {
    console.log(`Parent: sleep mode (${getTime()})`);

    memoryCleanup("parent sleep mode").finally(() => {
      scheduleNextParentScan(msUntilWakeModeEnds());
    });

    return;
  }

  if (scanWorkerProcess) {
    console.log("Parent: previous scan worker is still running");
    scheduleNextParentScan(Math.min(CHECK_INTERVAL, 5 * 60 * 1000));
    return;
  }

  console.log(`\nParent: starting scan worker - ${getTime()}`);
  logMemory("parent before worker");

  const child = fork(__filename, [], {
    env: {
      ...process.env,
      SCAN_WORKER: "1"
    },
    execArgv: process.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });

  scanWorkerProcess = child;

  child.on("error", err => {
    console.log("Parent: scan worker error:", err.message);
  });

  child.on("exit", (code, signal) => {
    scanWorkerProcess = null;

    console.log(
      `Parent: scan worker finished (code=${code ?? "null"}, signal=${
        signal ?? "null"
      })`
    );

    memoryCleanup("parent post-worker").finally(() => {
      logMemory("parent after worker");
      scheduleNextParentScan(isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL);
    });
  });
}

function startParentScheduler() {
  if (parentSchedulerStarted) {
    console.log("Parent scheduler already running");
    return;
  }

  parentSchedulerStarted = true;

  console.log("Parent scheduler mode enabled");
  console.log(`Data path will be used by scan workers: ${DATA_PATH}`);

  if (!global.gc) {
    console.log("GC unavailable. For Railway use start: node --expose-gc index.js");
    gcNoticeShown = true;
  }

  runParentScanCycle();

  cleanupTimer = setInterval(() => {
    memoryCleanup("parent interval");
  }, CLEANUP_INTERVAL);

  console.log("Parent scheduler started");
}

// ==========================
// READY
// ==========================

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  loadData();

  console.log(`Data path: ${DATA_PATH}`);

  if (SCAN_WORKER_MODE) {
    console.log("Scan worker mode enabled");

    if (!global.gc) {
      console.log("GC unavailable. For Railway use start: node --expose-gc index.js");
      gcNoticeShown = true;
    }

    try {
      await runChecks();
      await memoryFlush("worker final", {
        gcRuns: POST_SCAN_GC_RUNS,
        killChrome: true
      });
    } finally {
      gracefulExit(0, "scan worker finished");
    }

    return;
  }

  if (USE_SCAN_WORKER) {
    startParentScheduler();
    return;
  }

  scheduleDailyRestart();

  if (!global.gc) {
    console.log("GC unavailable. For Railway use start: node --expose-gc index.js");
    gcNoticeShown = true;
  }

  let firstDelay = isSleepMode() ? msUntilWakeModeEnds() : CHECK_INTERVAL;
  const restartCooldownLeft = getMemoryRestartCooldownLeft();

  if (shouldSkipFirstRunAfterMemoryRestart()) {
    firstDelay = isSleepMode()
      ? msUntilWakeModeEnds()
      : Math.max(restartCooldownLeft, CHECK_INTERVAL);

    console.log(
      `Recent memory restart detected - skipping immediate first scan for ${Math.ceil(
        firstDelay / 60000
      )} min cooldown`
    );
  } else {
    await runChecks();
  }

  scheduleNextRun(firstDelay);

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
