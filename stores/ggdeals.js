const axios = require("axios");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const API_KEY = process.env.ITAD_API_KEY;
const CHANNEL_ID = "1499525953791983737";

const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent": "bundle-bot/1.0",
    Accept: "application/json"
  }
});

const ALLOWED_SHOPS = [
  "Steam",
  "Fanatical",
  "Humble Store",
  "Humble Bundle",
  "Green Man Gaming",
  "Gamesplanet",
  "WinGameStore",
  "GameBillet"
];

// rzeczy, których NIE chcemy
const BAD_TITLE =
  /(dlc|soundtrack|ost|season pass|cosmetic|skin|artbook|demo|beta|alpha|software|subscription|lifetime|business|plan|vpn|antivirus|office|editor|pdf|photo|video editor|course|license|ebook|guide|template|asset pack|collector's edition|collector edition|hidden object|match 3|puzzle pack)/i;

// lekki pozytywny sygnał, że to faktycznie gra
const GAME_HINT =
  /(game|edition|bundle|pack|definitive|ultimate|complete|remaster|remastered|enhanced|deluxe)/i;

function isValidGame(item) {
  const title = item.title || "";
  if (!title) return false;

  if (BAD_TITLE.test(title)) return false;

  const shop = item.deal?.shop?.name || "";
  if (!ALLOWED_SHOPS.includes(shop)) return false;

  // jeśli nazwa wygląda totalnie niegrowo → out
  const words = title.toLowerCase();
  const suspicious =
    /(ai|advanced business|subscription|lifetime|plan)/i.test(words);

  if (suspicious) return false;

  // albo ma hint growy, albo po prostu wygląda jak normalny tytuł
  return GAME_HINT.test(title) || title.split(" ").length >= 2;
}

function getDiscount(item) {
  return item.deal?.cut || 0;
}

function getPrice(item) {
  const p = item.deal?.price;
  if (!p) return "?";
  return `${p.amount} ${p.currency}`;
}

function isHistoricalLow(item) {
  return item.deal?.flag === "H";
}

function buildITADLink(item) {
  if (item.slug) {
    return `https://isthereanydeal.com/game/${item.slug}/info/`;
  }
  return item.deal?.url || "https://isthereanydeal.com/";
}

async function sendDeal(client, deal) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x00cc66)
    .setTitle("🔥 Killer Steam Deal")
    .setDescription(`**${deal.title}**`)
    .addFields(
      { name: "💰 Cena", value: deal.price, inline: true },
      { name: "📉 Rabat", value: `-${deal.discount}%`, inline: true },
      { name: "🏪 Sklep", value: deal.shop, inline: true },
      { name: "🏷️ Typ", value: deal.tag, inline: false }
    )
    .setFooter({ text: "ITAD • Steam deals only" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("🔗 Sprawdź ceny")
      .setStyle(ButtonStyle.Link)
      .setURL(deal.link)
  );

  await channel.send({
    embeds: [embed],
    components: [row]
  }).catch(() => {});
}

async function fetchPage(offset = 0) {
  const res = await http.get("https://api.isthereanydeal.com/deals/v2", {
    params: {
      key: API_KEY,
      country: "PL",
      offset
    }
  });

  return res.data;
}

async function check(client, savedData, saveData) {
  console.log("🔥 ITAD: scanning...");

  if (!API_KEY) {
    console.log("❌ Missing ITAD_API_KEY");
    return;
  }

  let allItems = [];
  let offset = 0;
  let pages = 0;
  let hasMore = true;

  try {
    while (hasMore && pages < 10) {
      const data = await fetchPage(offset);

      const list = data.list || [];
      allItems.push(...list);

      hasMore = data.hasMore;
      offset = data.nextOffset || 0;
      pages++;
    }
  } catch (e) {
    console.log("❌ ITAD:", e.response?.status || e.message);
    return;
  }

  const deals = [];

  for (const item of allItems) {
    if (!isValidGame(item)) continue;

    const discount = getDiscount(item);
    if (discount < 85) continue;

    deals.push({
      title: item.title,
      link: buildITADLink(item),
      price: getPrice(item),
      shop: item.deal.shop.name,
      discount,
      tag: isHistoricalLow(item)
        ? "💀 Historical Low"
        : discount >= 95
        ? "🚨 95%+"
        : "🔥 85%+"
    });
  }

  deals.sort((a, b) => b.discount - a.discount);

  console.log("🔍 checked:", allItems.length);
  console.log("========== ITAD DEALS ==========");
  console.log(deals.slice(0, 15));
  console.log("================================");

  savedData.ggdeals ??= [];
  const oldSet = new Set(savedData.ggdeals.map(x => x.link));

  const isFirst = savedData.ggdeals.length === 0;
  const fresh = isFirst
    ? deals
    : deals.filter(x => !oldSet.has(x.link));

  for (const d of fresh) {
    await sendDeal(client, d);
    console.log("📨 Sent:", d.title);
  }

  if (!fresh.length) {
    console.log("⏸ No new deals");
  }

  savedData.ggdeals = deals.slice(0, 500);
  saveData();

  console.log(`✅ ITAD deals: ${deals.length}`);
}

module.exports = { check };