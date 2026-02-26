const puppeteer = require('puppeteer');
const { EmbedBuilder } = require('discord.js');

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

module.exports.check = async (client, savedData, saveData) => {
    let browser;

    try {
        console.log("🔎 Humble: sprawdzam listę bundle");

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();

        await page.goto('https://www.humblebundle.com/games', {
            waitUntil: 'networkidle2'
        });

        await page.waitForSelector('a[href^="/games/"] img');

        // 🔥 Pobieramy WSZYSTKIE bundle z siatki
        const bundles = await page.$$eval(
            'a[href^="/games/"]',
            links => {
                return links
                    .filter(el => el.querySelector('img'))
                    .map(el => ({
                        title: el.innerText.trim().split('\n')[0],
                        link: el.href
                    }))
                    .filter(b => b.title.length > 3);
            }
        );

        if (!bundles.length) {
            console.log("❌ Humble: brak bundle");
            return;
        }

        if (!savedData.humbleBundles) {
            savedData.humbleBundles = [];
        }

        for (const bundle of bundles) {

            if (savedData.humbleBundles.includes(bundle.title)) {
                continue;
            }

            console.log("🔥 Nowy Humble:", bundle.title);

            await page.goto(bundle.link, { waitUntil: 'networkidle2' });

            const data = await page.evaluate(() => {

                const image =
                    document.querySelector('meta[property="og:image"]')?.content || null;

                const description =
                    document.querySelector('meta[property="og:description"]')?.content ||
                    document.querySelector('meta[name="description"]')?.content ||
                    "";

                const priceText = Array.from(document.querySelectorAll('*'))
                    .map(el => el.innerText)
                    .find(text => text && text.includes('Pay at least'));

                let price = null;

                if (priceText) {
                    const match = priceText.match(/([$€£]\s?\d+[\.,]?\d*)/);
                    if (match) price = match[1];
                }

                return { image, description, price };
            });

            savedData.humbleBundles.push(bundle.title);
            savedData.humbleBundles =
                [...new Set(savedData.humbleBundles)].slice(-50);

            saveData();

            const channel = await client.channels.fetch(CHANNEL_ID);

            const embed = new EmbedBuilder()
                .setTitle(`🎪 ${bundle.title}`)
                .setURL(bundle.link)
                .setColor(0xE67E22)
                .setFooter({ text: "Humble Bundle 🎮" })
                .setTimestamp();

            let desc = "";

            if (data.price) {
                desc += `💰 Cena minimalna: **${data.price}**\n\n`;
            }

            if (data.description) {
                desc += data.description.substring(0, 400);
            }

            embed.setDescription(desc);

            if (data.image) {
                embed.setImage(data.image);
            }

            await channel.send({
                content: `🎉 **NOWY HUMBLE BUNDLE!** <@&${ROLE_ID}>`,
                embeds: [embed]
            });

            console.log("🚀 Humble wysłany:", bundle.title);
        }

    } catch (err) {
        console.log("Humble error:", err.message);
    } finally {
        if (browser) await browser.close();
    }
};