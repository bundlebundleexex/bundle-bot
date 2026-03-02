const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function trim(text, max = 300) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

function buildFanaticalUrl(bundle) {
  const slug = bundle.slug.toLowerCase();

  // 🔥 Pick & Mix detection
  if (
    slug.startsWith("build-your-own") ||
    bundle.name?.toLowerCase().includes("build your own")
  ) {
    return `https://www.fanatical.com/en/pick-and-mix/${slug}`;
  }

  return `https://www.fanatical.com/en/bundle/${slug}`;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Fanatical: algolia bundles API");

    const { data } = await axios.get(
      "https://www.fanatical.com/api/algolia/bundles?altRank=false",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
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

      // tylko prawdziwe bundle
      if (bundle.display_type !== "bundle") continue;

      // pomijamy mystery
      if (bundle.mystery) continue;

      const slug = bundle.slug.toLowerCase();

      if (savedData.fanaticalBundles.includes(slug)) continue;

      const url = buildFanaticalUrl(bundle);

      console.log("🔥 Nowy bundle:", slug);
      console.log("🔗 URL:", url);

      // minimalna cena
      let price = "Check page";
      if (bundle.bundle_tiers?.length) {
        const tier = bundle.bundle_tiers[0];

        if (tier.price?.EUR) {
          price = `€${tier.price.EUR}`;
        } else if (tier.price?.USD) {
          price = `$${tier.price.USD}`;
        }
      }

      const image = bundle.cover
        ? `https://fanatical.imgix.net/product/original/${bundle.cover}`
        : null;

      savedData.fanaticalBundles.push(slug);
      savedData.fanaticalBundles =
        [...new Set(savedData.fanaticalBundles)].slice(-100);
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