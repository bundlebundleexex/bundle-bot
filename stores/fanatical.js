const axios = require("axios");
const { EmbedBuilder } = require("discord.js");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
const ROLE_ID = "1371122206670852146";

const API_URL = "https://www.fanatical.com/api/algolia/bundles?altRank=false";

const axiosInstance = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0",
    Referer: "https://www.fanatical.com/pl/",
    Origin: "https://www.fanatical.com"
  }
});

function isPickMix(bundle) {
  const slug = String(bundle.slug || "").toLowerCase();
  const type = String(bundle.type || "").toLowerCase();
  const displayType = String(bundle.display_type || "").toLowerCase();

  return (
    type.includes("pick") ||
    displayType.includes("pick") ||
    slug.includes("build-your-own") ||
    slug.includes("pick-and-mix")
  );
}

function buildUrl(bundle) {
  const slug = bundle.slug || "";

  if (isPickMix(bundle)) {
    return `https://www.fanatical.com/en/pick-and-mix/${slug}?langRedirect=pl`;
  }

  return `https://www.fanatical.com/en/bundle/${slug}?langRedirect=pl`;
}

function getPrice(bundle) {
  if (bundle.price?.EUR) return `€${bundle.price.EUR}`;
  if (bundle.price?.USD) return `$${bundle.price.USD}`;
  if (bundle.price?.GBP) return `£${bundle.price.GBP}`;
  return "Check page";
}

function getImage(bundle) {
  if (!bundle.cover) return null;

  if (String(bundle.cover).startsWith("http")) {
    return bundle.cover;
  }

  return `https://fanatical.imgix.net/product/original/${bundle.cover}`;
}

function getText(bundle) {
  return `${bundle.slug || ""} ${bundle.name || ""}`.toLowerCase();
}

function getDrm(bundle) {
  return Array.isArray(bundle.drm)
    ? bundle.drm.map(item => String(item).toLowerCase())
    : [];
}

function isBlockedNonGame(bundle) {
  const text = getText(bundle);

  if (bundle.mystery) return true;
  if (/mystery|random key|random-key/.test(text)) return true;

  return /(comic|comics|manga|ebook|ebooks|course|courses|certification|masterclass|elearning|education|zenva|python|excel|robotics|llm|machine learning|ai bundle|art bundle|graphics and design|design bundle|business|security|cloud|network|programming|coding|code bundle|developer|dev bundle|game dev|game devs|c#|\.net|asset|assets|voice pack|template|manual|guidebook|software)/.test(
    text
  );
}

function hasStrongGameSignal(bundle) {
  const text = getText(bundle);
  const drm = getDrm(bundle);

  if (drm.includes("steam") || drm.includes("gog")) {
    return true;
  }

  return /(platinum|diamond|titanium|supreme|prestige|elite|legendary|ultimate|fanatical favorites|favorites collection|solstice|fusion|capcom|bethesda|bioware|survival-horror|adrenaline|tactical|wholesome|monster|indie games|pc games|steam games|gog games|action games|adventure games|rpg games|strategy games|horror games)/.test(
    text
  );
}

function isGameBundle(bundle) {
  const displayType = String(bundle.display_type || "").toLowerCase();

  if (isBlockedNonGame(bundle)) {
    return false;
  }

  if (isPickMix(bundle)) {
    return hasStrongGameSignal(bundle);
  }

  if (displayType === "bundle") {
    return hasStrongGameSignal(bundle);
  }

  return false;
}

function isRecurringPickMix(bundle) {
  if (!isPickMix(bundle)) {
    return false;
  }

  const text = getText(bundle);

  return /(platinum|diamond|titanium|supreme|prestige|elite|favorites|collection)/.test(
    text
  );
}

function getDateValue(bundle) {
  return (
    bundle.available_valid_from ||
    bundle.valid_from ||
    bundle.start_date ||
    bundle.starts_at ||
    bundle.release_date ||
    bundle.published_at ||
    bundle.created_at ||
    bundle.updated_at ||
    null
  );
}

function parseFanaticalDate(value) {
  if (!value) {
    return null;
  }

  const numericValue = Number(value);

  if (Number.isFinite(numericValue)) {
    const milliseconds =
      numericValue < 100000000000 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getDateKey(bundle) {
  const date = parseFanaticalDate(getDateValue(bundle)) || new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getBundleKey(bundle) {
  const slug = bundle.slug;

  if (isPickMix(bundle)) {
    return `${slug}:${getDateKey(bundle)}`;
  }

  return slug;
}

function ensureData(savedData) {
  savedData.fanaticalBundles ??= [];
}

function saveKnown(savedData, known, saveData) {
  savedData.fanaticalBundles = [...known].slice(-500);
  saveData();
}

module.exports.check = async (client, savedData, saveData, options = {}) => {
  try {
    console.log("🔎 Fanatical: scanning...");

    const { data } = await axiosInstance.get(API_URL, {
      signal: options.signal
    });

    if (!Array.isArray(data)) {
      console.log("❌ Fanatical: bad API response");
      return;
    }

    ensureData(savedData);

    const known = new Set(savedData.fanaticalBundles.map(String));

    let checked = 0;
    let skipped = 0;
    let duplicates = 0;
    let sent = 0;
    let recurring = 0;

    const fresh = [];

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

      const bundleKey = getBundleKey(bundle);

      if (isRecurringPickMix(bundle)) {
        recurring++;
      }

      if (known.has(bundleKey)) {
        duplicates++;
        continue;
      }

      fresh.push({
        bundle,
        bundleKey
      });
    }

    if (!fresh.length) {
      console.log(
        `✅ Fanatical: checked=${checked} skipped=${skipped} duplicates=${duplicates} recurring=${recurring} sent=0`
      );
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const item of fresh) {
      const { bundle, bundleKey } = item;
      const slug = bundle.slug;
      const url = buildUrl(bundle);
      const price = getPrice(bundle);
      const image = getImage(bundle);
      const pickMix = isPickMix(bundle);

      try {
        console.log("🔥 NEW FANATICAL:", slug, `(${bundleKey})`);

        const embed = new EmbedBuilder()
          .setTitle(`🔥 ${bundle.name}`)
          .setURL(url)
          .setColor(pickMix ? 0xf39c12 : 0x2ecc71)
          .setDescription(`💰 **Cena od:** ${price}`)
          .setFooter({
            text: pickMix
              ? "Fanatical Build Your Own Bundle 🧩"
              : "Fanatical Game Bundle 🎮"
          })
          .setTimestamp();

        if (image) {
          embed.setImage(image);
        }

        await channel.send({
          content: `🔥 **NOWY FANATICAL BUNDLE!** <@&${ROLE_ID}>`,
          embeds: [embed]
        });

        known.add(bundleKey);
        saveKnown(savedData, known, saveData);

        sent++;

        console.log("✔ Wysłano:", slug);
      } catch (err) {
        console.log("Fanatical item error:", err.message);
      }
    }

    console.log(
      `✅ Fanatical: checked=${checked} skipped=${skipped} duplicates=${duplicates} recurring=${recurring} sent=${sent}`
    );
  } catch (err) {
    if (err.name === "CanceledError" || err.code === "ERR_CANCELED") {
      throw err;
    }

    console.log("❌ Fanatical error:", err.response?.status || err.message);
  }
};
