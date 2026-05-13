const axios = require("axios");

const http = require("http");

const https = require("https");

// ==========================
// AXIOS
// ==========================

const axiosInstance =
  axios.create({
    timeout: 15000,

    httpAgent:
      new http.Agent({
        keepAlive: false
      }),

    httpsAgent:
      new https.Agent({
        keepAlive: false
      }),

    headers: {
      "User-Agent":
        "Mozilla/5.0"
    }
  });

// ==========================
// FILTERS
// ==========================

function isBlocked(
  game
) {
  const text =
    `${game.title || ""} ${game.description || ""}`.toLowerCase();

  const blocked = [
    "dlc",

    "starter pack",

    "starter bundle",

    "founder pack",

    "founder's pack",

    "skin pack",

    "weapon pack",

    "bonus pack",

    "beta",

    "playtest",

    "early access",

    "demo",

    "trial",

    "soundtrack",

    "artbook",

    "primogems",

    "gift pack",

    "bundle key",

    "ufo hat",

    "currency",

    "drops",

    "closed beta",

    "open beta"
  ];

  return blocked.some(
    word =>
      text.includes(word)
  );
}

function isValidPlatform(
  platforms
) {
  if (!platforms) {
    return false;
  }

  const text =
    platforms.toLowerCase();

  // mobile only out
  if (
    !text.includes("pc") &&
    (text.includes(
      "android"
    ) ||
      text.includes(
        "ios"
      ))
  ) {
    return false;
  }

  return true;
}

function isInterestingStore(
  game
) {
  const text =
    `${game.platforms || ""} ${game.title || ""}`.toLowerCase();

  // Epic out
  if (
    text.includes("epic")
  ) {
    return false;
  }

  // itch.io out
  if (
    text.includes("itch.io") ||
    text.includes("itchio")
  ) {
    return false;
  }

  return (
    text.includes(
      "steam"
    ) ||

    text.includes(
      "ubisoft"
    ) ||

    text.includes(
      "xbox"
    ) ||

    text.includes(
      "amazon"
    ) ||

    text.includes(
      "gog"
    ) ||

    text.includes(
      "indiegala"
    ) ||

    text.includes(
      "fanatical"
    )
  );
}

function isGoodSteamGiveaway(
  game
) {
  const text =
    `${game.title || ""} ${game.description || ""}`.toLowerCase();

  // Steam key giveaways
  if (
    text.includes(
      "steam key"
    ) ||
    text.includes(
      "key giveaway"
    )
  ) {
    return true;
  }

  // normal Steam games
  if (
    text.includes(
      "steam"
    ) &&
    game.type === "Game"
  ) {
    return true;
  }

  return false;
}

// ==========================
// MAIN
// ==========================

async function check(
  client,
  savedData,
  saveData
) {
  try {
    console.log(
      "🧪 deals0: scanning giveaways..."
    );

    const res =
      await axiosInstance.get(
        "https://www.gamerpower.com/api/giveaways"
      );

    const data =
      res.data || [];

    savedData.deals0 ??=
      [];

    const known =
      new Set(
        savedData.deals0
      );

    const fresh = [];

    for (const game of data) {
      try {
        if (
          game.status !==
          "Active"
        ) {
          continue;
        }

        if (
          game.type !==
            "Game" &&
          !isGoodSteamGiveaway(
            game
          )
        ) {
          continue;
        }

        if (
          game.worth ===
          "N/A"
        ) {
          continue;
        }

        if (
          isBlocked(game)
        ) {
          continue;
        }

        if (
          !isValidPlatform(
            game.platforms
          )
        ) {
          continue;
        }

        if (
          !isInterestingStore(
            game
          )
        ) {
          continue;
        }

        const id =
          String(game.id);

        if (
          known.has(id)
        ) {
          continue;
        }

        fresh.push({
          id,

          title:
            game.title,

          worth:
            game.worth,

          platforms:
            game.platforms,

          type:
            game.type,

          end:
            game.end_date
        });

        savedData.deals0.push(
          id
        );
      } catch {}
    }

    savedData.deals0 =
      [
        ...new Set(
          savedData.deals0
        )
      ].slice(-1000);

    saveData();

    console.log(
      "========== DEALS0 =========="
    );

    console.log(fresh);

    console.log(
      "============================"
    );

    console.log(
      `✅ deals0: ${fresh.length}`
    );

    global.gc?.();
  } catch (err) {
    console.log(
      "❌ deals0:",
      err.message
    );
  }
}

module.exports = {
  check
};