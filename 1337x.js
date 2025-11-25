const axios = require("axios");
const cheerio = require("cheerio");

// --- CONFIGURAZIONE VERCEL ---
// Abbassiamo i timeout per evitare blocchi su Serverless functions
const TIMEOUT_SOURCE = 2500; 
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

// --- URL ---
const BASE_1337X = "https://1337x.to"; 

// Regex per catturare risultati italiani
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA)\b/i;

// --- UTILITIES ---
function cleanString(str) {
    return str.replace(/[:"'’]/g, "").replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

// --- 1. 1337x (UNICA FONTE RIMASTA) ---
async function search1337x(title) {
    try {
        // Cerca ordinando per seeders decrescente
        const { data } = await axios.get(`${BASE_1337X}/sort-search/${encodeURIComponent(title)}/seeders/desc/1/`, {
            timeout: TIMEOUT_SOURCE, 
            headers: { 'User-Agent': USER_AGENT }
        });
        const $ = cheerio.load(data);
        let candidates = [];

        // MODIFICA QUI: Preleva i primi 5 risultati (era 4)
        $('table.table-list tr').slice(0, 5).each((_, row) => {
            const name = $(row).find('.name a').eq(1).text();
            const link = $(row).find('.name a').eq(1).attr('href');
            const seeds = parseInt($(row).find('.seeds').text()) || 0;
            
            // Filtra subito per regex ITA
            if (name && link && ITA_REGEX.test(name)) {
                candidates.push({ name, link, seeds });
            }
        });

        // Risolve i magnet link entrando nelle pagine specifiche (in parallelo)
        // Nota: Questo eseguirà fino a 5 richieste in parallelo.
        const magnets = await Promise.all(candidates.map(async c => {
            try {
                const res = await axios.get(`${BASE_1337X}${c.link}`, { timeout: 2000 });
                const $$ = cheerio.load(res.data);
                const magnet = $$('a[href^="magnet:"]').attr('href');
                
                if (magnet) {
                    return { 
                        title: c.name, 
                        magnet, 
                        seeders: c.seeds, 
                        source: '1337x', 
                        sizeBytes: 0 
                    };
                }
            } catch (e) { return null; }
        }));
        
        return magnets.filter(Boolean);
    } catch (e) { 
        return []; 
    }
}

// --- MAIN SEARCH ---
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    console.log(`🔍 Seeking on 1337x: ${cleanTitle}`);

    // Unica query attiva
    const queries = [
        search1337x(cleanTitle)
    ];

    const results = await Promise.allSettled(queries);
    
    let all = [];
    results.forEach(res => {
        if (res.status === 'fulfilled') all.push(...res.value);
    });

    // Deduplica 
    const seen = new Set();
    const unique = all.filter(item => {
        const hash = extractInfoHash(item.magnet);
        if (!hash || seen.has(hash)) return false;
        seen.add(hash);
        return true;
    });

    // MODIFICA QUI: Restituisce massimo 5 risultati finali (era 20)
    return unique.sort((a, b) => b.seeders - a.seeders).slice(0, 5);
}

module.exports = { searchMagnet };
