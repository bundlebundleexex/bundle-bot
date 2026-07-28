const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
const ROLE_ID = "1371122206670852146";

function trim(text, max = 220) {
  if (!text) return "Brak opisu.";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

function formatDate(dateString) {
  if (!dateString) return "Brak danych";

  const date = new Date(dateString);

  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function extractLowestPrice(product) {
  const prices = [];

  const highlights = [
    ...(product.hero_highlights || []),
    ...(product.hover_highlights || [])
  ];

  for (const h of highlights) {
    if (!h.heading) continue;

    const match = h.heading.match(/([$€£]\s?\d+[\.,]?\d*)/);
    if (match) {
      const numeric = parseFloat(
        match[1].replace(/[€$£\s]/g, "").replace(",", ".")
      );
      prices.push({ raw: match[1], value: numeric });
    }
  }

  if (!prices.length) return "Brak danych";

  prices.sort((a, b) => a.value - b.value);
  return prices[0].raw;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Humble: start sprawdzania");

    const channel = await client.channels.fetch(CHANNEL_ID);

    /* =========================
       🎮 HUMBLE GAMES
    ========================= */

    if (!savedData.humbleBundles) savedData.humbleBundles = [];

    const { data: gamesHtml } = await axios.get(
      "https://www.humblebundle.com/games",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const scripts = [
      ...gamesHtml.matchAll(
        /<script[^>]*application\/json[^>]*>(.*?)<\/script>/gs
      )
    ];

    if (scripts[1]) {
      const json = JSON.parse(scripts[1][1]);
      const mosaic = json?.data?.games?.mosaic || [];

      for (const section of mosaic) {
        if (!section.products) continue;

        for (const product of section.products) {
          if (product.category !== "bundle") continue;
          if (!product.product_url?.startsWith("/games/")) continue;

          const link = `https://www.humblebundle.com${product.product_url}`;

          if (savedData.humbleBundles.includes(link)) continue;

          const title = product.tile_name;
          const description =
            product.short_marketing_blurb ||
            product.marketing_blurb ||
            "";

          const image =
            product.high_res_tile_image ||
            product.tile_image ||
            null;

          const price = extractLowestPrice(product);

          savedData.humbleBundles.push(link);
          savedData.humbleBundles =
            [...new Set(savedData.humbleBundles)].slice(-100);
          saveData();

          const embed = new EmbedBuilder()
            .setTitle(`🔥 ${title}`)
            .setURL(link)
            .setColor(0xE67E22)
            .setDescription(
              `────────────────\n${trim(description)}\n────────────────`
            )
            .addFields({
              name: "💰 Cena minimalna",
              value: price,
              inline: false
            })
            .setFooter({ text: "Humble Game Bundle 🎮" })
            .setTimestamp();

          if (image) embed.setImage(image);

          await channel.send({
            content: `🔥 **NOWY HUMBLE GAME BUNDLE!** <@&${ROLE_ID}>`,
            embeds: [embed]
          });

          console.log("🚀 Humble GAME wysłany:", title);
        }
      }
    } else {
      console.log("❌ Humble Games: brak JSON");
    }

    /* =========================
       🎮 HUMBLE CHOICE
    ========================= */

    const { data: membershipHtml } = await axios.get(
      "https://www.humblebundle.com/membership",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const membershipScripts = [
      ...membershipHtml.matchAll(
        /<script[^>]*application\/json[^>]*>(.*?)<\/script>/gs
      )
    ];

    if (!membershipScripts[1]) {
      console.log("❌ Humble Choice: brak JSON");
      return;
    }

    const membershipJson = JSON.parse(membershipScripts[1][1]);

    const machineName = membershipJson.activeContentMachineName;
    const humanName = membershipJson.navbarOptions?.productHumanName;
    const endDateRaw =
      membershipJson.navbarOptions?.["activeContentEndDate|datetime"];
    const priceObj = membershipJson["baseSubscriptionPrice|money"];

    if (!machineName) {
      console.log("❌ Humble Choice: brak machineName");
      return;
    }

    if (savedData.humbleChoice === machineName) {
      console.log("⏸ Humble Choice: bez zmian");
      return;
    }

    savedData.humbleChoice = machineName;
    saveData();

    const price = priceObj
      ? `${priceObj.amount} ${priceObj.currency}`
      : "Brak danych";

    const endDate = formatDate(endDateRaw);

    const embed = new EmbedBuilder()
      .setTitle(`🔥 ${humanName}`)
      .setURL("https://www.humblebundle.com/membership")
      .setColor(0xF1C40F)
      .setDescription(
        `────────────────\nNowa edycja Humble Choice jest już dostępna!\n────────────────`
      )
      .addFields(
        { name: "💰 Cena", value: price, inline: true },
        { name: "⏳ Dostępne do", value: endDate, inline: true }
      )
      .setFooter({ text: "Humble Choice 🎮" })
      .setTimestamp();

    await channel.send({
      content: `🔥 **NOWY HUMBLE CHOICE!** <@&${ROLE_ID}>`,
      embeds: [embed]
    });

    console.log("🚀 Humble Choice wysłany:", humanName);

  } catch (err) {
    console.log("🔥 Humble error:", err.message);
  }
};
