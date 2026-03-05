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

    console.log("🔎 Fanatical: sprawdzam Algolia API...");

    const { data } = await axios.get(
      "https://www.fanatical.com/api/algolia/bundles?altRank=false",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Referer": "https://www.fanatical.com/en/bundle/games",
          "Origin": "https://www.fanatical.com",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty"
        },
        timeout: 20000
      }
    );

    if (!Array.isArray(data)) {
      console.log("❌ Fanatical: nieprawidłowa odpowiedź API");
      return;
    }

    savedData.fanaticalBundles ??= [];

    const channel = await client.channels.fetch(CHANNEL_ID);

    console.log("📦 Bundle znalezione:", data.length);

    for (const bundle of data) {

      if (!bundle.slug) continue;
      if (bundle.display_type !== "bundle") continue;
      if (bundle.mystery) continue;

      const slug = bundle.slug;

      if (savedData.fanaticalBundles.includes(slug))
        continue;

      const url = buildUrl(bundle);

      console.log("🔥 Nowy bundle:", slug);

      let price = "Check page";

      if (bundle.price?.EUR)
        price = `€${bundle.price.EUR}`;
      else if (bundle.price?.USD)
        price = `$${bundle.price.USD}`;

      const image = bundle.cover
        ? `https://fanatical.imgix.net/product/original/${bundle.cover}`
        : null;

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

      savedData.fanaticalBundles.push(slug);
      savedData.fanaticalBundles =
        [...new Set(savedData.fanaticalBundles)].slice(-100);

      saveData();

      console.log("✔ Wysłano:", slug);

    }

  }

  catch (err) {

    console.log("❌ Fanatical error:", err.response?.status || err.message);

  }

};