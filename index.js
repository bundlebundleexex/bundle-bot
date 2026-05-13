require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");

const fs = require("fs");
const path = require("path");

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

const {
  restartBrowser
} = require("./browser");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHECK_INTERVAL =
  10 * 60 * 1000;

// ==========================
// DATA PATH
// ==========================

const DATA_PATH =
  fs.existsSync("/data")
    ? "/data/data.json"
    : path.join(
        __dirname,
        "data.json"
      );

let savedData = {};

let isRunning = false;

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
  if (isRunning) {
    console.log(
      "⏳ Poprzednie sprawdzanie jeszcze trwa..."
    );

    return;
  }

  isRunning = true;

  try {
    console.log(
      `\n🔎 START sprawdzania - ${new Date().toLocaleString()}`
    );

    for (const store of STORES) {
      try {
        await store.fn(
          client,
          savedData,
          saveData
        );
      } catch (err) {
        console.log(
          `❌ ${store.name}:`,
          err.message
        );
      }
    }

    console.log(
      "✅ Sprawdzanie zakończone"
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

    await runChecks();

    setInterval(
      runChecks,
      CHECK_INTERVAL
    );

    // restart browser co 6h
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
      "⏱️ Sprawdzanie ustawione co 10 minut"
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

client.login(
  process.env.TOKEN
);