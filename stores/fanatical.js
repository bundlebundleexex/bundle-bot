const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function buildUrl(bundle) {
  if (bundle.type === "pick-and-mix") {
    return `https://www.fanatical.com/en/pick-and-mix/${bundle.slug}`;
  }
  return `https://www.fanatical.com/en/bundle/${bundle.slug}`;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Fanatical: CLEAN SCAN");

    const { data } = await axios.get(
      "https://www.fanatical.com/api/algolia/bundles?altRank=false",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://www.fanatical.com/en/bundle/games",
          "Origin": "https://www.fanatical.com"
        },
        timeout: 20000
      }
    );

    if (!Array.isArray(data)) {
      console.log("❌ Fanatical: zła odpowiedź API");
      return;
    }

    savedData.fanaticalBundles ??= [];
    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const bundle of data) {

      if (!bundle.slug) continue;

      // ❌ SKIP MYSTERY
      if (bundle.mystery) continue;

      // ❌ TYLKO GRY (NAJWAŻNIEJSZE)
      const isGameBundle =
        bundle.display_type === "bundle" &&
        bundle.drm?.includes("steam");

      // ❌ LUB PICK&MIX (TEŻ GRY)
      const isPickMix =
        bundle.type === "pick-and-mix" &&
        bundle.drm?.includes("steam");

      if (!isGameBundle && !isPickMix) continue;

      const slug = bundle.slug;

      if (savedData.fanaticalBundles.includes(slug))
        continue;

      const url = buildUrl(bundle);

      console.log("🔥 NOWY:", slug);

      let price = "Check page";
      if (bundle.price?.EUR) price = `€${bundle.price.EUR}`;
      else if (bundle.price?.USD) price = `$${bundle.price.USD}`;

      const image = bundle.cover
        ? `https://fanatical.imgix.net/product/original/${bundle.cover}`
        : null;

      const embed = new EmbedBuilder()
        .setTitle(`🔥 ${bundle.name}`)
        .setURL(url)
        .setColor(isPickMix ? 0xf39c12 : 0x2ecc71)
        .setDescription(`💰 **Cena od:** ${price}`)
        .setFooter({
          text: isPickMix
            ? "Fanatical Build Your Own Bundle 🧩"
            : "Fanatical Game Bundle 🎮"
        })
        .setTimestamp();

      if (image) embed.setImage(image);

      await channel.send({
        content: `🔥 **NOWY FANATICAL BUNDLE!** <@&${ROLE_ID}>`,
        embeds: [embed]
      });

      savedData.fanaticalBundles.push(slug);
      savedData.fanaticalBundles =
        [...new Set(savedData.fanaticalBundles)].slice(-100);

      saveData();

      console.log("✔ Wysłano:", slug);
    }

  } catch (err) {
    console.log("❌ Fanatical error:", err.response?.status || err.message);
  }
};