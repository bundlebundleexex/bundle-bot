const axios = require("axios");

module.exports.check = async () => {

  try {
    console.log("==== HUMBLE CHOICE PAGE DEBUG START ====");

    const { data: membershipHtml } = await axios.get(
      "https://www.humblebundle.com/membership",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const membershipScripts = [
      ...membershipHtml.matchAll(/<script[^>]*application\/json[^>]*>(.*?)<\/script>/gs)
    ];

    if (!membershipScripts[1]) {
      console.log("Brak JSON membership");
      return;
    }

    const membershipJson = JSON.parse(membershipScripts[1][1]);
    const machineName = membershipJson.activeContentMachineName;

    console.log("machineName:", machineName);

    if (!machineName) {
      console.log("Brak machineName");
      return;
    }

    const choiceUrl = `https://www.humblebundle.com/membership/${machineName}`;

    try {
      const { data: choiceHtml } = await axios.get(choiceUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      console.log("Choice page length:", choiceHtml.length);

      const ogImageMatch = choiceHtml.match(
        /<meta property="og:image" content="([^"]+)"/
      );

      console.log("OG IMAGE:", ogImageMatch ? ogImageMatch[1] : "BRAK");

    } catch (err) {
      console.log("Choice page error:", err.message);
    }

    console.log("==== HUMBLE CHOICE PAGE DEBUG END ====");

  } catch (err) {
    console.log("DEBUG ERROR:", err.message);
  }
};