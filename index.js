require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');

const humble = require('./stores/humble');
const fanatical = require('./stores/fanatical');
const gmg = require('./stores/gmg');
const indiegala = require('./stores/indiegala');
const digiphile = require('./stores/digiphile');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const CHECK_INTERVAL = 30 * 60 * 1000; // 🔥 30 minut

let savedData = {};

// 🔐 Bezpieczne ładowanie data.json
function loadData() {
    if (fs.existsSync('data.json')) {
        try {
            const raw = fs.readFileSync('data.json', 'utf8');
            savedData = JSON.parse(raw);
        } catch (err) {
            console.log("⚠️ data.json uszkodzony – resetuję");
            savedData = {};
            saveData();
        }
    } else {
        saveData();
    }
}

function saveData() {
    fs.writeFileSync('data.json', JSON.stringify(savedData, null, 2));
}

// 🔥 Główna funkcja sprawdzająca
async function runChecks() {
    console.log("🔎 Sprawdzam bundle...");

    try {
        await humble.check(client, savedData, saveData);
    } catch (err) {
        console.log("❌ Humble error:", err.message);
    }

    try {
        await fanatical.check(client, savedData, saveData);
    } catch (err) {
        console.log("❌ Fanatical error:", err.message);
    }

    try {
        await gmg.check(client, savedData, saveData);
    } catch (err) {
        console.log("❌ GMG error:", err.message);
    }

    try {
        await indiegala.check(client, savedData, saveData);
    } catch (err) {
        console.log("❌ IndieGala error:", err.message);
    }

    try {
        await digiphile.check(client, savedData, saveData);
    } catch (err) {
        console.log("❌ Digiphile error:", err.message);
    }

    console.log("✅ Sprawdzanie zakończone\n");
}

client.once('clientReady', async () => {
    console.log(`🤖 Zalogowano jako ${client.user.tag}`);

    loadData();

    await runChecks();

    setInterval(runChecks, CHECK_INTERVAL);
});

client.login(process.env.TOKEN);