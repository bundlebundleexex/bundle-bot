require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");

const fs = require("fs");
const path = require("path");

// stores
const humble = require("./stores/humble");
const fanatical = require("./stores/fanatical");
const gmg = require("./stores/gmg");
const indiegala = require("./stores/indiegala");
const digiphile = require("./stores/digiphile");

const epic = require("./stores/epic");
const epicDeals = require("./stores/epicdeals");

const freeDeals = require("./stores/freeDeals");
const gog = require("./stores/gog");

const steam = require("./stores/steam");
const amazon = require("./stores/amazon");
const deals0 = require("./stores/deals0");

// browser manager
const {
  restartBrowser
} = require("./browser");

// ==========================
// CLIENT
// ==========================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ==========================
// CONFIG
// ==========================

const CHECK_INTERVAL =
  15 * 60 * 1000;

const STORE_DELAY = 1500;

const DATA_PATH =
  fs.existsSync("/data")
    ? "/data/data.json"
    : path.join(
        __dirname,
        "data.json"
      );

// ==========================
// STATE
// ==========================

let savedData = {};

let isRunning = false;

// ==========================
// HELPERS
// ==========================

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

// sleep mode 00:05 -> 10:00
function isSleepMode() {
  const now = new Date();

  const hour = now.getHours();

  return hour >= 0 && hour < 10;
}

// ==========================
// LOAD / SAVE
// ==========================

function loadData() {
  if (fs.existsSync(DATA_PATH)) {
    try {
      savedData = JSON.parse(
        fs.readFileSync(
          DATA_PATH,
          "utf8"
        )
      );
    } catch {
      console.log(
        "⚠️ data.json uszkodzony — resetuję"
      );

      savedData = {};
    }
  }

  savedData.humbleBundles ??= [];

  savedData.humbleChoice ??= null;

  savedData.fanaticalBundles ??= [];

  savedData.gmgBundles ??= [];

  savedData.indiegalaBundles ??= [];

  savedData.digiphileCollections ??= [];

  savedData.epicGames ??= [];

  savedData.epicDeals ??= [];

  savedData.freeDeals ??= [];

  savedData.gogGames ??= [];

  savedData.steamGames ??= [];

  savedData.amazon ??= [];

  savedData.deals0 ??= [];

  saveData();
}

function saveData() {
  try {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify(
        savedData,
        null,
        2
      )
    );
  } catch (err) {
    console.log(
      "❌ saveData:",
      err.message
    );
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
    name: "Steam",
    fn: steam.check
  },

  {
    name: "Amazon",
    fn: amazon.check
  }
];

// ==========================
// RUN CHECKS
// ==========================

async function runChecks() {
  // sleep mode
  if (isSleepMode()) {
    console.log("🌙 Sleep mode");

    return;
  }

  if (isRunning) {
    console.log(
      "⏳ Poprzednie sprawdzanie jeszcze trwa..."
    );

    return;
  }

  isRunning = true;

  const startedAt = Date.now();

  try {
    console.log(
      `\n🔎 START sprawdzania - ${new Date().toLocaleString()}`
    );

    for (const store of STORES) {
      const storeStart =
        Date.now();

      try {
        await Promise.race([
          store.fn(
            client,
            savedData,
            saveData
          ),

          new Promise(
            (_, reject) =>
              setTimeout(() => {
                reject(
                  new Error(
                    "Store timeout"
                  )
                );
              }, 90000)
          )
        ]);
      } catch (err) {
        console.log(
          `❌ ${store.name}:`,
          err.message
        );
      }

      const duration =
        (
          (Date.now() -
            storeStart) /
          1000
        ).toFixed(1);

      console.log(
        `⏱ ${store.name}: ${duration}s`
      );

      // mała przerwa
      await sleep(STORE_DELAY);

      global.gc?.();
    }

    const total =
      (
        (Date.now() -
          startedAt) /
        1000
      ).toFixed(1);

    console.log(
      `✅ Sprawdzanie zakończone (${total}s)`
    );
  } finally {
    isRunning = false;

    global.gc?.();
  }
}

// ==========================
// READY
// ==========================

client.once(
  "clientReady",

  async () => {
    console.log(
      `🤖 Zalogowano jako ${client.user.tag}`
    );

    loadData();

    // first run
    await runChecks();

    // cyclic checks
    setInterval(
      runChecks,
      CHECK_INTERVAL
    );

    // browser restart co 6h
    setInterval(
      async () => {
        try {
          console.log(
            "🔄 Restart shared browser..."
          );

          await restartBrowser();

          global.gc?.();
        } catch (err) {
          console.log(
            "❌ Browser restart error:",
            err.message
          );
        }
      },

      6 * 60 * 60 * 1000
    );

    console.log(
      "⏱️ Sprawdzanie ustawione co 15 minut"
    );
  }
);

// ==========================
// ERROR HANDLING
// ==========================

process.on(
  "unhandledRejection",

  err => {
    console.error(
      "❌ Unhandled promise rejection:",
      err
    );
  }
);

process.on(
  "uncaughtException",

  err => {
    console.error(
      "❌ Uncaught exception:",
      err
    );
  }
);

// ==========================
// LOGIN
// ==========================

client.login(
  process.env.TOKEN
);