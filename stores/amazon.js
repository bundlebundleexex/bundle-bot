const path = require("path");
const { fork } = require("child_process");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const CHANNEL_ID = process.env.AMAZON_CHANNEL_ID || "1499461446365352017";
const ROLE_ID = process.env.AMAZON_ROLE_ID || "1499461776604004392";

const SEND_INITIAL = process.env.AMAZON_SEND_INITIAL === "1";
const MAX_SAVED_KEYS = 1200;
const WORKER_TIMEOUT_MS = Number(process.env.AMAZON_WORKER_TIMEOUT_MS || 45000);

function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getClaimSlug(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/claims/")[1]?.split("/")[0] || null;
  } catch {
    return String(url).split("/claims/")[1]?.split(/[/?#]/)[0] || null;
  }
}

function getGameKeys(game) {
  const keys = [];
  const titleKey = normalizeTitle(game.title);
  const slug = getClaimSlug(game.url);

  if (titleKey) {
    keys.push(`title:${titleKey}`);
  }

  if (slug) {
    keys.push(`slug:${slug}`);
  }

  return keys;
}

function collectKnownKeys(rawAmazonData) {
  const keys = new Set();

  for (const item of rawAmazonData || []) {
    if (!item) {
      continue;
    }

    if (typeof item === "string") {
      keys.add(item);

      const slug = getClaimSlug(item);
      const isLegacyPlainSlug =
        !item.includes(":") && !item.includes("/") && item.length > 2;

      if (slug) {
        keys.add(`slug:${slug}`);
      } else if (isLegacyPlainSlug) {
        keys.add(`slug:${item}`);
      }

      continue;
    }

    if (typeof item === "object") {
      for (const key of getGameKeys(item)) {
        keys.add(key);
      }

      if (item.key) {
        keys.add(String(item.key));
      }

      if (item.slug) {
        keys.add(`slug:${item.slug}`);
      }
    }
  }

  return keys;
}

function isKnownGame(game, knownKeys) {
  const keys = getGameKeys(game);
  return keys.length > 0 && keys.some(key => knownKeys.has(key));
}

function saveKnownKeys(savedData, knownKeys, saveData) {
  savedData.amazon = [...knownKeys].slice(-MAX_SAVED_KEYS);
  saveData();
}

function runAmazonWorker(options = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "amazonWorker.js");
    const child = fork(workerPath, [], {
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });

    let settled = false;
    let output = "";
    let errorOutput = "";

    const finish = (err, games) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      if (options.signal) {
        options.signal.removeEventListener("abort", abortWorker);
      }

      if (!child.killed) {
        child.kill("SIGKILL");
      }

      if (err) {
        reject(err);
      } else {
        resolve(Array.isArray(games) ? games : []);
      }
    };

    const abortWorker = () => {
      finish(new Error("Amazon worker aborted"));
    };

    const timeoutId = setTimeout(() => {
      finish(new Error(`Amazon worker timeout after ${WORKER_TIMEOUT_MS / 1000}s`));
    }, WORKER_TIMEOUT_MS);

    if (options.signal) {
      if (options.signal.aborted) {
        abortWorker();
      } else {
        options.signal.addEventListener("abort", abortWorker, { once: true });
      }
    }

    child.stdout?.on("data", chunk => {
      output += chunk.toString();
    });

    child.stderr?.on("data", chunk => {
      errorOutput += chunk.toString();
    });

    child.on("message", message => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.ok) {
        finish(null, message.games);
      } else {
        finish(new Error(message.error || "Amazon worker failed"));
      }
    });

    child.on("error", err => {
      finish(err);
    });

    child.on("exit", code => {
      if (settled) {
        return;
      }

      const details = [output.trim(), errorOutput.trim()].filter(Boolean).join(" | ");
      finish(new Error(`Amazon worker exited with code ${code}${details ? `: ${details}` : ""}`));
    });
  });
}

async function check(client, savedData, saveData, options = {}) {
  console.log("Amazon: sprawdzam Prime freebies...");

  savedData.amazon ??= [];

  try {
    const games = await runAmazonWorker(options);
    const knownKeys = collectKnownKeys(savedData.amazon);
    const currentKeys = new Set(games.flatMap(getGameKeys));
    const fresh = games.filter(game => !isKnownGame(game, knownKeys));

    console.log(
      `Amazon: found=${games.length} knownKeys=${knownKeys.size} fresh=${fresh.length}`
    );

    if (!games.length) {
      console.log("Amazon: nie znaleziono gier, nie ruszam cache");
      return;
    }

    if (!knownKeys.size && !SEND_INITIAL) {
      saveKnownKeys(savedData, currentKeys, saveData);

      console.log(`Amazon: pierwszy run, zapisuje ${games.length} gier bez wysylania`);
      console.log("Amazon: aby wyslac wszystko przy pustym cache ustaw AMAZON_SEND_INITIAL=1");

      return;
    }

    if (!fresh.length) {
      for (const key of currentKeys) {
        knownKeys.add(key);
      }

      saveKnownKeys(savedData, knownKeys, saveData);

      console.log("Amazon: bez zmian");
      console.log(`Amazon: ${games.length}`);

      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);

    for (const game of fresh) {
      try {
        const embed = new EmbedBuilder()
          .setColor("#FF9900")
          .setAuthor({ name: "Amazon Prime Gaming" })
          .setTitle(`Game: ${game.title}`)
          .setURL(game.url)
          .setDescription("Nowa darmowa gra do odebrania")
          .setFooter({ text: "Amazon Prime Freebie" })
          .setTimestamp();

        const button = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Odbierz gre")
            .setStyle(ButtonStyle.Link)
            .setURL(game.url)
        );

        await channel.send({
          content: `<@&${ROLE_ID}>`,
          embeds: [embed],
          components: [button]
        });

        for (const key of getGameKeys(game)) {
          knownKeys.add(key);
        }

        saveKnownKeys(savedData, knownKeys, saveData);

        console.log("Amazon wyslano:", game.title);
      } catch (err) {
        console.log("Amazon item error:", err.message);
      }
    }

    for (const game of games) {
      for (const key of getGameKeys(game)) {
        knownKeys.add(key);
      }
    }

    saveKnownKeys(savedData, knownKeys, saveData);

    console.log(`Amazon: ${games.length}`);
  } catch (err) {
    console.log("Amazon:", err.message);
  } finally {
    global.gc?.();
  }
}

module.exports = {
  check
};
