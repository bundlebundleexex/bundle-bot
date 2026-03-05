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
const gog = require("./stores/gog");
const steam = require("./stores/steam");
const ggdeals = require("./stores/ggdeals");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// co ile sprawdzamy
const CHECK_INTERVAL = 10 * 60 * 1000;

// railway volume path
const DATA_PATH = fs.existsSync("/data")
  ? "/data/data.json"
  : path.join(__dirname, "data.json");

let savedData = {};
let isRunning = false;

// ==========================
// LOAD DATA
// ==========================

function loadData() {

  if (fs.existsSync(DATA_PATH)) {
    try {
      savedData = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    }
    catch {
      console.log("⚠️ data.json uszkodzony — resetuję");
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
  savedData.gogGames ??= [];
  savedData.steamGames ??= [];
  savedData.ggdeals ??= [];

  saveData();
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(savedData, null, 2));
}

// ==========================
// CHECK STORES
// ==========================

async function runChecks() {

  if (isRunning) {
    console.log("⏳ Poprzednie sprawdzanie jeszcze trwa...");
    return;
  }

  isRunning = true;

  console.log(`\n🔎 START sprawdzania - ${new Date().toLocaleString()}`);

  try { await humble.check(client, savedData, saveData); }
  catch (e) { console.log("❌ Humble:", e.message); }

  try { await fanatical.check(client, savedData, saveData); }
  catch (e) { console.log("❌ Fanatical:", e.message); }

  try { await gmg.check(client, savedData, saveData); }
  catch (e) { console.log("❌ GMG:", e.message); }

  try { await indiegala.check(client, savedData, saveData); }
  catch (e) { console.log("❌ IndieGala:", e.message); }

  try { await digiphile.check(client, savedData, saveData); }
  catch (e) { console.log("❌ Digiphile:", e.message); }

  try { await epic.check(client, savedData, saveData); }
  catch (e) { console.log("❌ Epic:", e.message); }

  try { await gog.check(client, savedData, saveData); }
  catch (e) { console.log("❌ GOG:", e.message); }

  try { await steam.check(client, savedData, saveData); }
  catch (e) { console.log("❌ Steam:", e.message); }

  try { await ggdeals.check(client, savedData, saveData); }
  catch (e) { console.log("❌ GG.DEALS:", e.message); }

  console.log("✅ Sprawdzanie zakończone");

  isRunning = false;
}

// ==========================
// BOT READY
// ==========================

client.once("clientReady", async () => {

  console.log(`🤖 Zalogowano jako ${client.user.tag}`);

  loadData();

  await runChecks();

  setInterval(runChecks, CHECK_INTERVAL);

  console.log("⏱️ Sprawdzanie ustawione co 10 minut");
});

// ==========================
// ERROR PROTECTION
// ==========================

process.on("unhandledRejection", err => {
  console.error("❌ Unhandled promise rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("❌ Uncaught exception:", err);
});

// ==========================

client.login(process.env.TOKEN);