const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const KNABEN_URL = "https://knaben.org";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://knaben.org/'
};

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
    if (!match) return 0;
    const [, value, unit] = match;
    const cleanValue = parseFloat(value.replace(',', '.'));
    const multipliers = {
        'B': 1, 'KB': 1024, 'MB': 1024**2, 'GB': 1024**3, 'TB': 1024**4,
        'KIB': 1024, 'MIB': 1024**2, 'GIB': 1024**3, 'TIB': 1024**4
    };
    return Math.round(cleanValue * (multipliers[unit.toUpperCase()] || 1));
}

// Filtro categorie adulti (preso dal tuo script di riferimento)
function isAdultCategory(categoryText, title) {
    if (!categoryText) return false;
    const normalizedCategory = categoryText.toLowerCase().replace(/[\s/.-]/g, '');
    const normalizedTitle = (title || "").toLowerCase();
    
    const adultKeywords = ['xxx', 'porn', 'hardcore', 'erotic', 'hentai', 'sex', 'adult'];
    
    if (adultKeywords.some(k => normalizedCategory.includes(k))) return true;
    if (adultKeywords.some(k => normalizedTitle.includes(k))) return true;
    
    return false;
}

async function searchMagnet(title, year) {
    try {
        // Pulizia query: Knaben preferisce query pulite senza caratteri speciali
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        const query = `${cleanTitle}`; // Cerchiamo largo, poi filtriamo ITA in Javascript

        console.log(`\n--- [KNABEN SEARCH] ---`);
        console.log(`🔎 Query: ${query}`);

        let results = [];
        const maxPages = 2; // Scansiona fino a 2 pagine per velocità

        for (let page = 1; page <= maxPages; page++) {
            // URL pattern: /search/{query}/0/{page}/ (0 = All Categories)
            const searchUrl = `${KNABEN_URL}/search/${encodeURIComponent(query)}/0/${page}/`;

            try {
                const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 8000 });
                const $ = cheerio.load(data);
                const rows = $('table.table tbody tr');

                if (rows.length === 0) break; // Nessun risultato, stop paginazione

                rows.each((i, elem) => {
                    const tds = $(elem).find('td');
                    if (tds.length < 5) return;

                    // Estrazione Dati
                    const category = tds.eq(0).text().trim();
                    const titleLink = tds.eq(1).find('a[title]').first();
                    const name = titleLink.text().trim();
                    
                    if (!name) return;

                    // Filtro Adulti
                    if (isAdultCategory(category, name)) return;

                    // Filtro ITA (Cruciale: Knaben è internazionale)
                    const nameUpper = name.toUpperCase();
                    const isItalian = nameUpper.includes("ITA") || nameUpper.includes("ITALIAN") || nameUpper.includes("MULTI") || nameUpper.includes("DUAL");
                    
                    if (!isItalian) return;
                    if (year && !name.includes(year)) return;

                    // Estrazione Magnet
                    const magnet = $(elem).find('a[href^="magnet:?"]').attr('href');
                    if (!magnet) return;

                    // Estrazione Size e Seeders
                    const sizeStr = tds.eq(2).text().trim();
                    const seeders = parseInt(tds.eq(4).text().trim()) || 0;
                    
                    results.push({
                        title: name,
                        magnet: magnet,
                        size: sizeStr,
                        sizeBytes: parseSize(sizeStr),
                        seeders: seeders,
                        source: "Knaben"
                    });
                });

            } catch (e) {
                console.warn(`⚠️ Errore Knaben pagina ${page}: ${e.message}`);
                break; 
            }
        }

        // Ordina per Seeders poi Dimensione
        results.sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes);

        console.log(`✅ KNABEN: Trovati ${results.length} magnet ITA.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore Knaben:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
