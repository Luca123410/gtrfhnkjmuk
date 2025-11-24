const axios = require("axios");
const https = require("https");

const UINDEX_URL = "https://uindex.org/search.php";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

function extractInfoHash(magnet) {
    const match = magnet.match(/btih:([A-Fa-f0-9]{40})/i);
    return match ? match[1].toUpperCase() : null;
}

function decodeHtmlEntities(text) {
    if (!text) return "";
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        // Cerchiamo titolo + ITA
        const query = `${cleanTitle} ITA`;
        
        console.log(`\n--- [UINDEX SEARCH] ---`);
        console.log(`🔎 Query: ${query}`);

        // c=0 (All), c=1 (Movies), c=2 (TV) - Usiamo 0 per sicurezza
        const searchUrl = `${UINDEX_URL}?search=${encodeURIComponent(query)}&c=0`;

        const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 10000 });

        if (!data || data.includes("No results found")) return [];

        // LOGICA DI PARSING REGEX (Presa dal tuo file)
        // UIndex ha una tabella complessa, usiamo regex per estrarre le righe grezze
        const rows = data.split(/<tr[^>]*>/gi).filter(row => row.includes('magnet:?xt=urn:btih:') && row.includes('<td'));

        let results = [];

        for (const row of rows) {
            // Estrai magnet
            const magnetMatch = row.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i);
            if (!magnetMatch) continue;
            
            let magnet = decodeHtmlEntities(magnetMatch[1]);
            const hash = extractInfoHash(magnet);
            if (!hash) continue;

            // Estrai Titolo (cerca nei tag <a>)
            let name = "";
            const titleMatch = row.match(/<a[^>]*href=["']\/details\.php[^"']*["'][^>]*>([^<]+)<\/a>/i);
            if (titleMatch) name = titleMatch[1];
            else {
                // Fallback titolo
                const altMatch = row.match(/<a[^>]*title=["']([^"']+)["'][^>]*>/i);
                if (altMatch) name = altMatch[1];
            }
            
            if (!name) continue;
            name = decodeHtmlEntities(name).trim();

            // Filtri
            const nameUpper = name.toUpperCase();
            const isItalian = nameUpper.includes("ITA") || nameUpper.includes("ITALIAN") || nameUpper.includes("MULTI") || nameUpper.includes("DUAL");
            if (!isItalian) continue;
            if (year && !name.includes(year)) continue;

            // Estrai Dimensione
            const sizeMatch = row.match(/([\d.,]+\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i);
            let sizeStr = sizeMatch ? sizeMatch[1] : "??";
            
            let sizeBytes = 0;
            if (sizeStr.toUpperCase().includes("GB")) sizeBytes = parseFloat(sizeStr) * 1024**3;
            else if (sizeStr.toUpperCase().includes("MB")) sizeBytes = parseFloat(sizeStr) * 1024**2;

            results.push({
                title: name,
                magnet: magnet,
                size: sizeStr,
                sizeBytes: sizeBytes,
                source: "UIndex"
            });
        }

        console.log(`✅ UINDEX: Trovati ${results.length} magnet ITA.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore UIndex:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
