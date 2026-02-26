const puppeteer = require('puppeteer');
const { EmbedBuilder } = require('discord.js');

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
    let browser;

    try {
        console.log("🔎 GMG: sprawdzam bundle");

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();

        await page.goto('https://www.greenmangamingbundles.com/', {
            waitUntil: 'networkidle2'
        });

        const result = await page.evaluate(() => {

            const pageText = document.body.innerText;

            // 🔥 Jeśli Coming Soon → brak bundle
            if (pageText.includes("COMING SOON")) {
                return { comingSoon: true };
            }

            // 🔥 Jeśli pojawi się prawdziwy bundle,
            // szukamy tytułu (zakładamy że będzie w h1/h2)
            const title =
                document.querySelector('h1')?.innerText.trim() ||
                document.querySelector('h2')?.innerText.trim() ||
                null;

            const image =
                document.querySelector('meta[property="og:image"]')?.content ||
                null;

            const description =
                document.querySelector('meta[property="og:description"]')?.content ||
                "";

            return {
                comingSoon: false,
                title,
                image,
                description
            };
        });

        if (result.comingSoon) {
            console.log("⏸ GMG: Coming Soon – brak aktywnego bundle");
            return;
        }

        if (!result.title) {
            console.log("❌ GMG: brak tytułu bundle");
            return;
        }

        // 🔥 Sprawdzamy czy już wysłany
        if (savedData.gmg === result.title) {
            console.log("⏸ GMG: bez zmian");
            return;
        }

        console.log("🔥 Nowy GMG bundle:", result.title);

        savedData.gmg = result.title;
        saveData();

        const channel = await client.channels.fetch(CHANNEL_ID);

        const embed = new EmbedBuilder()
            .setTitle(`🟢 ${result.title}`)
            .setURL('https://www.greenmangamingbundles.com/')
            .setColor(0x2ECC71)
            .setFooter({ text: "Green Man Gaming Bundle 🎮" })
            .setTimestamp();

        let desc = "";

        if (result.description) {
            desc += result.description.substring(0, 400);
        }

        embed.setDescription(desc);

        if (result.image) {
            embed.setImage(result.image);
        }

        await channel.send({
            content: `🟢 **NOWY GMG BUNDLE!** <@&${ROLE_ID}>`,
            embeds: [embed]
        });

        console.log("🚀 GMG wysłany");

    } catch (err) {
        console.log("GMG error:", err.message);
    } finally {
        if (browser) await browser.close();
    }
};