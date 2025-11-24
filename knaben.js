const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE STYLE "FAST & FURIOUS" ---
const TIMEOUT_SOURCE = 4000; // Knaben è un po' più lento di APIBay, diamogli 4s
const KNABEN_BASE_URL = "https://knaben.org";

// Agent HTTPS permissivo (Knaben ha spesso certificati strani)
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Referer': 'https://knaben.org/'
};

// --- REGEX PERMISSIVA (COME RICHIESTO) ---
// Questa cattura "ITA", "ITALIAN", "MULTI", "DUAL", "MD", "SUB ITA" anche se scritti male
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA)\b/i;

// --- UTILITIES ---
function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|GiB|MB|MiB|KB|KiB)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit.includes('G')) val *= 1024 * 1024 * 1024;
    else if (unit.includes('M')) val *= 1024 * 1024;
    return Math.round(val);
}

function cleanString(str) {
    return str.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

// --- MAIN SEARCH ---
async function searchMagnet(title, year) {
    try {
        const cleanTitle = cleanString(title);
        // Costruiamo la query per Knaben: /search/{query}/0/1/seeders
        // 0 = Tutte le categorie, 1 = Pagina 1, seeders = Ordina per seeders
        const searchUrl = `${KNABEN_BASE_URL}/search/${encodeURIComponent(cleanTitle)}/0/1/seeders`;

        console.log(`🔍 [KNABEN FAST] Seeking: ${cleanTitle}`);

        const { data } = await axios.get(searchUrl, { 
            headers, 
            httpsAgent, 
            timeout: TIMEOUT_SOURCE 
        });

        const $ = cheerio.load(data);
        const results = [];

        $('table.table tbody tr').each((_, row) => {
            // Selettori specifici per la tabella di Knaben
            const tds = $(row).find('td');
            if (tds.length < 5) return;

            // 1. Titolo
            const titleLink = tds.eq(1).find('a[title]').first();
            const name = titleLink.text().trim();
            if (!name) return;

            // 2. Filtro Regex "Aggressivo"
            if (!ITA_REGEX.test(name)) return;
            
            // 3. Filtro Anno (opzionale ma consigliato)
            if (year && !name.includes(year)) return;

            // 4. Estrazione Magnet
            const magnet = $(row).find('a[href^="magnet:"]').attr('href');
            if (!magnet) return;

            // 5. Size e Seeders
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

        // Ordina per seeders decrescenti
        return results.sort((a, b) => b.seeders - a.seeders);

    } catch (e) {
        console.error(`⚠️ Knaben Error: ${e.message}`);
        // In caso di errore (timeout o altro), restituisci array vuoto per non bloccare l'addon
        return [];
    }
}

module.exports = { searchMagnet };
