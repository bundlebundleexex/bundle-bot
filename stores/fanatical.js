const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function trim(text, max = 300) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Fanatical: algolia bundles API");

    const { data } = await axios.get(
      "https://www.fanatical.com/api/algolia/bundles?altRank=false",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.fanatical.com/en/bundle/games",
          "Origin": "https://www.fanatical.com"
        },
        timeout: 20000
      }
    );

    if (!Array.isArray(data)) {
      console.log("❌ Nieprawidłowa odpowiedź API");
      return;
    }

    if (!savedData.fanaticalBundles) {
      savedData.fanaticalBundles = [];
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const bundle of data) {
      if (!bundle?.slug) continue;

      // 🔥 tylko prawdziwe bundle
      if (bundle.display_type !== "bundle") continue;

      // 🔥 pomijamy mystery
      if (bundle.mystery) continue;

      const slug = bundle.slug.toLowerCase();

      if (savedData.fanaticalBundles.includes(slug)) continue;

      const url = `https://www.fanatical.com/en/bundle/${slug}`;

      console.log("🔥 Nowy bundle:", slug);

      // minimalna cena z pierwszego tieru
      let price = "Check page";
      if (bundle.bundle_tiers?.length) {
        const tier = bundle.bundle_tiers[0];
        if (tier.price?.EUR) {
          price = `€${tier.price.EUR}`;
        }
      }

      const image = bundle.cover
        ? `https://fanatical.imgix.net/product/original/${bundle.cover}`
        : null;

      savedData.fanaticalBundles.push(slug);
      saveData();

      const embed = new EmbedBuilder()
        .setTitle(`🔥 ${bundle.name}`)
        .setURL(url)
        .setColor(0x2ecc71)
        .setDescription(`💰 **Cena od:** ${price}`)
        .setFooter({ text: "Fanatical Game Bundle 🎮" })
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `🔥 **NOWY FANATICAL GAME BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      console.log("✔ Wysłano:", slug);
    }

  } catch (err) {
    console.log("❌ Fanatical error:", err.response?.status || err.message);
  }
};