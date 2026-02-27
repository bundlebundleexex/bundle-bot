const puppeteer = require('puppeteer');
const { EmbedBuilder } = require('discord.js');

const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = "1371122206670852146";

function trim(text, max = 220) {
    if (!text) return "Brak opisu.";
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.substring(0, max) + "..." : clean;
}

module.exports.check = async (client, savedData, saveData) => {
    let browser;

    try {
        if (!savedData.humbleBundles) savedData.humbleBundles = [];

        console.log("🔎 Humble: sprawdzam bundle + choice (homepage)");

        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        /*
        ==========================
        🎪 HUMBLE BUNDLES
        ==========================
        */

        await page.goto('https://www.humblebundle.com/games', {
            waitUntil: 'networkidle2'
        });

        const bundles = await page.$$eval('a[href^="/games/"]', links =>
            links
                .map(link => ({
                    title: link.innerText.trim().split('\n')[0],
                    link: link.href
                }))
                .filter(b => b.title.length > 3)
        );

        for (const bundle of bundles) {

            if (savedData.humbleBundles.includes(bundle.title)) continue;

            await page.goto(bundle.link, { waitUntil: 'networkidle2' });

            const data = await page.evaluate(() => {

                const image =
                    document.querySelector('meta[property="og:image"]')?.content;

                const description =
                    document.querySelector('meta[name="description"]')?.content;

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
            saveData();

            const channel = await client.channels.fetch(CHANNEL_ID);

            const embed = new EmbedBuilder()
                .setTitle(`🔥 ${bundle.title}`)
                .setURL(bundle.link)
                .setColor(0xE67E22)
                .addFields({
                    name: "💰 Cena minimalna",
                    value: data.price || "Brak danych",
                    inline: true
                })
                .setDescription(
                    `──────────────\n${trim(data.description)}\n──────────────`
                )
                .setImage(data.image)
                .setFooter({ text: "Humble Bundle 🎮" })
                .setTimestamp();

            await channel.send({
                content: `🔥 **NOWY HUMBLE BUNDLE!** <@&${ROLE_ID}>`,
                embeds: [embed]
            });
        }

        /*
        ==========================
        🎮 HUMBLE CHOICE (homepage)
        ==========================
        */

        try {

            const choicePage = await browser.newPage();
            await choicePage.goto("https://www.humblebundle.com/", {
                waitUntil: "networkidle2"
            });

            const choiceData = await choicePage.evaluate(() => {

                const card = Array.from(document.querySelectorAll("a"))
                    .find(a => a.innerText && a.innerText.includes("Choice"));

                if (!card) return null;

                const title = card.innerText.split("\n")[0].trim();
                const link = card.href;

                const image =
                    card.querySelector("img")?.src ||
                    document.querySelector('meta[property="og:image"]')?.content;

                return { title, link, image };
            });

            if (choiceData && savedData.humbleChoice !== choiceData.title) {

                savedData.humbleChoice = choiceData.title;
                saveData();

                const channel = await client.channels.fetch(CHANNEL_ID);

                const embed = new EmbedBuilder()
                    .setTitle(`🔥 ${choiceData.title}`)
                    .setURL(choiceData.link)
                    .setColor(0xF1C40F)
                    .setDescription("Miesięczna edycja Humble Choice jest już dostępna!")
                    .setImage(choiceData.image)
                    .setFooter({ text: "Humble Choice 🎮" })
                    .setTimestamp();

                await channel.send({
                    content: `🔥 **NOWY HUMBLE CHOICE!** <@&${ROLE_ID}>`,
                    embeds: [embed]
                });
            }

            await choicePage.close();

        } catch (err) {
            console.log("Choice error:", err.message);
        }

        await browser.close();

    } catch (err) {
        console.log("Humble error:", err.message);
        if (browser) await browser.close();
    }
};