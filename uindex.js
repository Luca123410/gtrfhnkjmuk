const axios = require("axios");
const https = require("https");

const UINDEX_URL = "https://uindex.org/search.php";

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// Headers copiati esattamente dallo script funzionante per evitare blocchi
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
};

function decodeHtmlEntities(text) {
    if (!text) return "";
    const entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
        '&nbsp;': ' ', '&#8217;': "'", '&#8220;': '"', '&#8221;': '"',
        '&#8211;': '–', '&#8212;': '—'
    };
    return text.replace(/&[#\w]+;/g, match => entities[match] || match);
}

function extractInfoHash(magnet) {
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

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

async function searchMagnet(title, year) {
    try {
        // Pulizia titolo come da script di riferimento
        const cleanTitle = title
            .replace(/[:"']/g, "")
            .replace(/[^a-zA-Z0-9 ]/g, " ")
            .trim();
            
        // UIndex funziona meglio con query semplici. Aggiungiamo "ITA" per filtrare.
        const query = `${cleanTitle} ITA`;
        
        console.log(`\n--- [UINDEX ADVANCED SEARCH] ---`);
        console.log(`🔎 Query: ${query}`);

        // c=0 cerca in tutte le categorie (Film, Serie, Anime, ecc.)
        const searchUrl = `${UINDEX_URL}?search=${encodeURIComponent(query)}&c=0`;

        const { data } = await axios.get(searchUrl, { 
            headers, 
            httpsAgent, 
            timeout: 10000,
            validateStatus: status => status < 500 // Accetta anche redirect se capitano
        });

        if (!data || typeof data !== 'string') return [];

        // --- LOGICA DI PARSING DAL CODICE VERCEL ---
        // Splitta per righe di tabella e filtra quelle che sembrano torrent
        const rows = data.split(/<tr[^>]*>/gi).filter(row => 
            row.includes('magnet:?xt=urn:btih:') && 
            row.includes('<td')
        );

        console.log(`📊 UIndex: Analisi di ${rows.length} righe potenziali...`);

        let results = [];

        for (const row of rows) {
            try {
                // 1. Estrazione Magnet
                const magnetMatch = row.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i);
                if (!magnetMatch) continue;
                
                let magnet = decodeHtmlEntities(magnetMatch[1]);
                const hash = extractInfoHash(magnet);
                if (!hash) continue;

                // 2. Parsing Celle
                const cellRegex = /<td[^>]*>(.*?)<\/td>/gis;
                const cells = [];
                let cellMatch;
                while ((cellMatch = cellRegex.exec(row)) !== null) {
                    cells.push(cellMatch[1].trim());
                }

                if (cells.length < 3) continue;

                // 3. Estrazione Titolo (Logica complessa per gestire vari layout)
                let name = "";
                const titleCell = cells[1] || ""; // Di solito la seconda cella
                
                // Cerca link a details.php
                const detailsMatch = titleCell.match(/<a[^>]*href=["']\/details\.php[^"']*["'][^>]*>([^<]+)<\/a>/i);
                if (detailsMatch) {
                    name = detailsMatch[1].trim();
                } else {
                    // Fallback: cerca il secondo anchor tag o il primo
                    const anchors = titleCell.match(/<a[^>]*>([^<]+)<\/a>/gi);
                    if (anchors && anchors.length >= 2) {
                        const secondAnchor = anchors[1].match(/>([^<]+)</);
                        if (secondAnchor) name = secondAnchor[1].trim();
                    } else if (anchors && anchors.length === 1) {
                        const singleAnchor = anchors[0].match(/>([^<]+)</);
                        if (singleAnchor) name = singleAnchor[1].trim();
                    }
                }

                if (!name) continue;
                name = decodeHtmlEntities(name).trim();

                // 4. Filtri (Lingua e Anno)
                const nameUpper = name.toUpperCase();
                const isItalian = nameUpper.includes("ITA") || nameUpper.includes("ITALIAN") || nameUpper.includes("MULTI");
                
                if (!isItalian) continue; 
                if (year && !name.includes(year)) {
                    // Se è una serie TV, spesso l'anno non c'è nel nome del file, quindi siamo più permissivi
                    // Se è un film, l'anno è importante.
                    // Per sicurezza, se non matcha l'anno, controlliamo se la query originale è contenuta nel nome
                    const simplifiedTitle = title.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                    const simplifiedName = name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                    if (!simplifiedName.includes(simplifiedTitle)) continue;
                }

                // 5. Estrazione Dimensione
                let sizeStr = "??";
                const sizeCell = cells[2] || "";
                const sizeMatch = sizeCell.match(/([\d.,]+\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i);
                if (sizeMatch) sizeStr = sizeMatch[1].trim();
                const sizeBytes = parseSize(sizeStr);

                // 6. Estrazione Seeders (opzionale, se disponibile)
                let seeders = 0;
                if (cells.length > 4) {
                    const seedMatch = cells[4].match(/(\d+)/);
                    if (seedMatch) seeders = parseInt(seedMatch[1]);
                }

                results.push({
                    title: name,
                    magnet: magnet,
                    size: sizeStr,
                    sizeBytes: sizeBytes,
                    seeders: seeders,
                    source: "UIndex"
                });

            } catch (e) {
                // Ignora errori su singola riga
            }
        }

        // Ordina per Seeders (se presenti) poi per Dimensione
        results.sort((a, b) => (b.seeders - a.seeders) || (b.sizeBytes - a.sizeBytes));

        console.log(`✅ UINDEX: Trovati ${results.length} risultati validi.`);
        return results;

    } catch (error) {
        console.error("🔥 Errore UIndex:", error.message);
        // Se errore di rete, ritorna array vuoto per non bloccare addon.js
        return [];
    }
}

module.exports = { searchMagnet };
