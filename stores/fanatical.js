const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function buildUrl(bundle) {
  const slug = bundle.slug || "";

  if (
    bundle.type === "pick-and-mix" ||
    slug.includes("build-your-own")
  ) {
    return `https://www.fanatical.com/pl/pick-and-mix/${slug}`;
  }

  return `https://www.fanatical.com/pl/bundle/${slug}`;
}

function getPrice(bundle) {
  if (bundle.price?.EUR) return `€${bundle.price.EUR}`;
  if (bundle.price?.USD) return `$${bundle.price.USD}`;
  if (bundle.price?.GBP) return `£${bundle.price.GBP}`;
  return "Check page";
}

function getImage(bundle) {
  if (!bundle.cover) return null;
  return `https://fanatical.imgix.net/product/original/${bundle.cover}`;
}

function isGameBundle(bundle) {
  const slug = (bundle.slug || "").toLowerCase();
  const name = (bundle.name || "").toLowerCase();
  const text = `${slug} ${name}`;

  const type = (bundle.type || "").toLowerCase();
  const displayType = (bundle.display_type || "").toLowerCase();

  const drm = Array.isArray(bundle.drm)
    ? bundle.drm.map(x => String(x).toLowerCase())
    : [];

  // ❌ mystery
  if (bundle.mystery) return false;
  if (/mystery|random key|random-key/.test(text)) return false;

  // ❌ obvious non-gaming
  if (
    /(comic|comics|manga|ebook|ebooks|course|courses|certification|masterclass|elearning|education|zenva|python|excel|robotics|llm|machine learning|ai bundle|art bundle|graphics and design|design bundle|business|security|cloud|network|programming|coding|code bundle|developer|dev bundle|game dev|game devs|c#|\.net|asset|assets|voice pack|template|manual|guidebook|software)/.test(
      text
    )
  ) {
    return false;
  }

  // ✅ normal game bundle
  if (
    displayType === "bundle" &&
    (drm.includes("steam") || drm.includes("gog"))
  ) {
    return true;
  }

  // ✅ pick & mix only with STRONG gaming signals
  if (
    type === "pick-and-mix" ||
    slug.includes("build-your-own")
  ) {
    return /(capcom|bethesda|survival-horror|adrenaline|tactical|legendary|platinum|wholesome|gamersky|monster|indie games|pc games|steam games|gog games|action games|rpg games)/.test(
      text
    );
  }

  return false;
}

module.exports.check = async (client, savedData, saveData) => {
  try {
    console.log("🔎 Fanatical: scanning...");

    const { data } = await axios.get(
      "https://www.fanatical.com/api/algolia/bundles?altRank=false",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.fanatical.com/pl/",
          Origin: "https://www.fanatical.com"
        },
        timeout: 20000
      }
    );

    if (!Array.isArray(data)) {
      console.log("❌ Fanatical: bad API response");
      return;
    }

    savedData.fanaticalBundles ??= [];
    const channel = await client.channels.fetch(CHANNEL_ID);

    let checked = 0;
    let skipped = 0;
    let duplicates = 0;
    let sent = 0;

    for (const bundle of data) {
      checked++;

      if (!bundle.slug) {
        skipped++;
        continue;
      }

      if (!isGameBundle(bundle)) {
        skipped++;
        continue;
      }

      const slug = bundle.slug;

      if (savedData.fanaticalBundles.includes(slug)) {
        duplicates++;
        continue;
      }

      const url = buildUrl(bundle);
      const price = getPrice(bundle);
      const image = getImage(bundle);

      console.log("🔥 NEW FANATICAL:", slug);

      const isPickMix =
        bundle.type === "pick-and-mix" ||
        slug.includes("build-your-own");

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
        [...new Set(savedData.fanaticalBundles)].slice(-250);

      saveData();
      sent++;

      console.log("✔ Wysłano:", slug);
    }

    console.log(
      `✅ Fanatical: checked=${checked} skipped=${skipped} duplicates=${duplicates} sent=${sent}`
    );
  } catch (err) {
    console.log(
      "❌ Fanatical error:",
      err.response?.status || err.message
    );
  }
};