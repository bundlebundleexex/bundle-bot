const axios = require("axios");
const { EmbedBuilder } = require("discord.js");
const { isSignificantExtension } = require("./renewal");

const CHANNEL_ID = process.env.BUNDLE_CHANNEL_ID || "1531609869327667210";
const ROLE_ID = "1371122206670852146";
const PERMANENTLY_BLOCKED_SLUGS = new Set([
  "batman-arkham-collection",
  "neurovoider-deluxe-edition"
]);
// This recurring Pick-and-Mix was marked as seen during legacy-key migration,
// but the user confirmed it was never posted. Announce it once when it appears.
const ONE_TIME_ANNOUNCEMENT_REPAIRS = new Set([
  "platinum-collection-build-your-own-bundle"
]);

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

  // Fanatical uses year 3001 as an open-ended sentinel, not a real deadline.
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() > 2100 ? null : date;
}

function getDateKey(bundle) {
  const date = parseFanaticalDate(getDateValue(bundle));
  return date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : "unknown-start";
}

function getBundleKey(bundle) {
  return `${bundle.slug}:${getDateKey(bundle)}:${getEndDateKey(bundle)}`;
}

function getEndDateKey(bundle) {
  const value = bundle.available_valid_to || bundle.available_valid_until || bundle.valid_to ||
    bundle.valid_until || bundle.end_date || bundle.available_end_date || bundle.ends_at ||
    bundle.expiry_date || bundle.expires_at || null;
  const date = parseFanaticalDate(value);
  if (!date) return "unknown-end";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isPermanentlyBlocked(bundle) {
  const slug = String(bundle.slug || "").toLowerCase();
  const text = `${slug} ${String(bundle.name || "").toLowerCase()}`;
  return PERMANENTLY_BLOCKED_SLUGS.has(slug) ||
    /batman[ -:]?.{0,20}arkham.{0,20}collection|neurovoider.{0,20}deluxe/.test(text);
}

function hasSeenBundle(known, slug) {
  return [...known].some(key => key === slug || key.startsWith(`${slug}:`));
}

function hasLegacyBundleKey(known, slug) {
  return [...known].some(key => key === slug || new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d{4}-\\d{2}-\\d{2}$`).test(key));
}

function findPreviousEndDate(known, slug) {
  const dates = [...known]
    .filter(key => key.startsWith(`${slug}:`))
    .map(key => key.match(/:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/)?.[1])
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return dates[0] || null;
}

function formatFanaticalDate(value) {
  const date = parseFanaticalDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function ensureData(savedData) {
  savedData.fanaticalBundles ??= [];
}

function saveKnown(savedData, known, saveData) {
  savedData.fanaticalBundles = [...known].slice(-500);
  saveData();
}

function pruneInactiveFanaticalBundles(savedData, currentKeys, saveData) {
  if (!currentKeys.size) {
    return;
  }

  const activeSlugs = new Set([...currentKeys].map(key => String(key).split(":")[0]));
  const previous = savedData.fanaticalBundles.map(String);
  // Keep prior end-date keys for active slugs so renewal checks have a stable baseline.
  const next = [...new Set(previous)].filter(key => activeSlugs.has(key.split(":")[0]));

  if (
    previous.length !== next.length ||
    previous.some((key, index) => key !== next[index])
  ) {
    savedData.fanaticalBundles = next;
    saveData();

    console.log(
      `🧹 Fanatical: wyczyszczono nieaktywne bundle=${previous.length - next.length}`
    );
  }
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
    if (!Array.isArray(savedData.fanaticalAnnouncementRepairSlugs)) {
      savedData.fanaticalAnnouncementRepairSlugs = [];
    }

    let checked = 0;
    let skipped = 0;
    let duplicates = 0;
    let sent = 0;
    let recurring = 0;

    const candidates = [];
    const fresh = [];

    for (const bundle of data) {
      checked++;

      if (!bundle.slug) {
        skipped++;
        continue;
      }

      if (isPermanentlyBlocked(bundle) || !isGameBundle(bundle)) {
        skipped++;
        continue;
      }

      const bundleKey = getBundleKey(bundle);

      if (isRecurringPickMix(bundle)) {
        recurring++;
      }

      candidates.push({
        bundle,
        bundleKey
      });
    }

    const known = new Set(savedData.fanaticalBundles.map(String));
    const queuedKeys = new Set();

    for (const item of candidates) {
      const { bundle, bundleKey } = item;
      const repairAnnouncement =
        ONE_TIME_ANNOUNCEMENT_REPAIRS.has(bundle.slug) &&
        !savedData.fanaticalAnnouncementRepairSlugs.includes(bundle.slug);

      if ((!repairAnnouncement && known.has(bundleKey)) || queuedKeys.has(bundleKey)) {
        duplicates++;
        continue;
      }

      if (!repairAnnouncement && hasLegacyBundleKey(known, bundle.slug)) {
        // Migrate previous slug/day keys without announcing them as renewals.
        known.add(bundleKey);
        saveKnown(savedData, known, saveData);
        duplicates++;
        continue;
      }

      if (!repairAnnouncement && getEndDateKey(bundle) === "unknown-end" && hasSeenBundle(known, bundle.slug)) {
        // No end date means we cannot confirm a renewal, so do not ping a known offer again.
        known.add(bundleKey);
        saveKnown(savedData, known, saveData);
        duplicates++;
        continue;
      }

      const previousEndDate = findPreviousEndDate(known, bundle.slug);
      const currentEndDate = getEndDateKey(bundle);
      if (
        !repairAnnouncement &&
        previousEndDate &&
        !isSignificantExtension(previousEndDate, currentEndDate)
      ) {
        // Keep the old baseline so repeated small date adjustments accumulate.
        duplicates++;
        continue;
      }

      fresh.push({
        ...item,
        isRenewal: repairAnnouncement ? false : hasSeenBundle(known, bundle.slug),
        repairAnnouncement
      });
      queuedKeys.add(bundleKey);
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
      const endDate = getEndDateKey(bundle);
      const previousEndDate = findPreviousEndDate(known, slug);
      const isRenewal = Boolean(
        item.isRenewal &&
        previousEndDate &&
        endDate !== "unknown-end" &&
        isSignificantExtension(previousEndDate, endDate)
      );

      try {
        console.log("🔥 NEW FANATICAL:", slug, `(${bundleKey})`);

        const embed = new EmbedBuilder()
          .setTitle(`🔥 ${bundle.name}`)
          .setURL(url)
          .setColor(isRenewal ? 0x2ecc71 : pickMix ? 0xf39c12 : 0x2ecc71)
          .setDescription(isRenewal
            ? "Termin dostępności tej oferty został przedłużony."
            : "Nowy pakiet dostępny do kupienia.\nSprawdź zawartość i progi cenowe na stronie oferty.")
          .setFooter({
            text: pickMix
              ? "Fanatical Build Your Own Bundle 🧩"
              : "Fanatical Game Bundle 🎮"
          })
          .setTimestamp();

        embed.addFields({ name: "💰 Cena od", value: price, inline: true });

        if (isRenewal) {
          embed.addFields(
            { name: "Poprzednio do", value: formatFanaticalDate(previousEndDate), inline: true },
            { name: "Nowy termin", value: formatFanaticalDate(endDate), inline: true }
          );
        } else {
          embed.addFields({
            name: "⏳ Dostępne do",
            value: endDate !== "unknown-end"
              ? formatFanaticalDate(endDate)
              : "Sklep nie podał daty końca",
            inline: false
          });
        }

        if (image) {
          embed.setImage(image);
        }

        await channel.send({
          content: isRenewal
            ? "🔁 **PAKIET PRZEDŁUŻONY — FANATICAL**"
            : `🔥 **NOWY FANATICAL BUNDLE!** <@&${ROLE_ID}>`,
          allowedMentions: isRenewal ? { parse: [] } : { parse: [], roles: [ROLE_ID] },
          embeds: [embed]
        });

        known.add(bundleKey);
        if (item.repairAnnouncement) {
          savedData.fanaticalAnnouncementRepairSlugs = [
            ...new Set([...savedData.fanaticalAnnouncementRepairSlugs, slug])
          ];
        }
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

module.exports.getBundleKey = getBundleKey;
module.exports.isPermanentlyBlocked = isPermanentlyBlocked;
module.exports.hasSeenBundle = hasSeenBundle;
module.exports.hasLegacyBundleKey = hasLegacyBundleKey;
module.exports.findPreviousEndDate = findPreviousEndDate;
module.exports.parseFanaticalDate = parseFanaticalDate;
module.exports.getEndDateKey = getEndDateKey;
module.exports.pruneInactiveFanaticalBundles = pruneInactiveFanaticalBundles;
