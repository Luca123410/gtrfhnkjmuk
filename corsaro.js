const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const CORSARO_URL = "https://ilcorsaronero.link";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        // Cerchiamo solo il titolo per massimizzare i risultati
        const searchUrl = `${CORSARO_URL}/search?q=${encodeURIComponent(cleanTitle)}`;
        
        console.log(`\n--- [CORSARO REGEX SEARCH] ---`);
        console.log(`🔎 Scrape: ${searchUrl}`);

        const { data } = await axios.get(searchUrl, { headers, httpsAgent, timeout: 10000 });
        
        if (data.includes("Cloudflare")) {
            console.error("⛔ Blocco Cloudflare (Corsaro).");
            return [];
        }

        const $ = cheerio.load(data);
        let potentialItems = [];

        // --- METODO SCANSIONE LINK ---
        // Cerchiamo link che contengono "/torrent/" o "details.php"
        $('a').each((i, elem) => {
            if (potentialItems.length >= 12) return; // Max 12 risultati

            const href = $(elem).attr('href');
            const text = $(elem).text().trim();

            if (!href || !text || text.length < 5) return;

            // Verifica se è un link di dettaglio
            if (href.includes('/torrent/') || href.includes('details.php')) {
                // Filtro Anno Base
                if (year && !text.includes(year)) return;

                let fullUrl = href.startsWith('http') ? href : `${CORSARO_URL}${href.startsWith('/') ? '' : '/'}${href}`;
                
                // Evita duplicati
                if (!potentialItems.some(p => p.url === fullUrl)) {
                    potentialItems.push({ url: fullUrl, title: text });
                }
            }
        });

        console.log(`   ⚡ Trovati ${potentialItems.length} candidati. Scansione dettagli...`);

        if (potentialItems.length === 0) {
            // Fallback: Magnet diretto in home (vecchio stile)
            const directMagnet = $('a[href^="magnet:?"]').first().attr('href');
            if (directMagnet) {
                return [{ 
                    title: title, 
                    magnet: directMagnet, 
                    size: "Sconosciuta", 
                    sizeBytes: 9999999999, // Max priority
                    source: "Corsaro" 
                }];
            }
            return [];
        }

        // Scansione Parallela Dettagli
        const promises = potentialItems.map(async (item) => {
            try {
                const detailPage = await axios.get(item.url, { headers, httpsAgent, timeout: 8000 });
                const detailText = detailPage.data;
                
                // --- ESTRAZIONE MAGNET VIA REGEX ---
                // Più robusto di cheerio per i magnet nascosti nei commenti o script
                const magnetMatch = detailText.match(/magnet:\?xt=urn:btih:([a-zA-Z0-9]{40})/);
                
                if (!magnetMatch) return null;

                const hash = magnetMatch[1];
                const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(item.title)}`;

                // Estrazione Dimensione
                const sizeMatch = detailText.match(/(\d+(\.\d+)?)\s?(GB|MB|KB)/i);
                let sizeStr = "??";
                let sizeBytes = 0;

                if (sizeMatch) {
                    sizeStr = sizeMatch[0];
                    const num = parseFloat(sizeMatch[1]);
                    if (sizeStr.includes("GB")) sizeBytes = num * 1024**3;
                    else if (sizeStr.includes("MB")) sizeBytes = num * 1024**2;
                }

                return {
                    title: item.title,
                    magnet: magnet,
                    size: sizeStr,
                    sizeBytes: sizeBytes,
                    source: "Corsaro"
                };

            } catch (e) { return null; }
        });

        const results = (await Promise.all(promises)).filter(r => r !== null);
        results.sort((a, b) => b.sizeBytes - a.sizeBytes);

        console.log(`✅ CORSARO: Estratti ${results.length} magnet validi.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore Corsaro:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
