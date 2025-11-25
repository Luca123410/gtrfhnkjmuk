const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI PROVIDER ---
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 
const Knaben = require("./knaben");

// --- CONFIGURAZIONE CACHE ---
const CACHE = {
    streams: new NodeCache({ stdTTL: 1800, checkperiod: 300 }), // 30 min
    catalog: new NodeCache({ stdTTL: 43200, checkperiod: 3600 }), // 12 ore
    metadata: new NodeCache({ stdTTL: 86400, checkperiod: 3600 }) // 24 ore
};

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const MANIFEST = {
    id: "org.community.corsaro-brain-v32",
    version: "32.0.0", 
    name: "Corsaro + Global (V32 SAFE)",
    description: "🇮🇹 V32: Fix critico Loop 429. Ritardo preventivo obbligatorio. Solo Cache Strict.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// ==========================================
// 🛠️ UTILITIES
// ==========================================

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getConfig(configStr) {
    try { return JSON.parse(Buffer.from(configStr, 'base64').toString()); } catch (e) { return {}; }
}

function cleanSearchQuery(query) {
    return query
        .replace(/\s*\(\d{4}\)\s*$/, '') 
        .replace(/[^a-zA-Z0-9 ]/g, " ") 
        .replace(/\s+/g, ' ')
        .trim();
}

// [V30] Calcolo Similarità Stringhe
function similar(a, b) {
    if (!a || !b) return 0;
    const cleanA = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
    const cleanB = b.toLowerCase();
    const words = cleanA.split(" ").filter(w => w.length > 1);
    if (words.length === 0) return 0;
    let matches = 0;
    for (let w of words) {
        if (cleanB.includes(w)) matches++;
    }
    return matches / words.length;
}

// ==========================================
// 🧠 THE BRAIN: ITALIAN SMART MATCHING
// ==========================================

const Brain = {
    isEpisodeMatch: (torrentTitle, season, episode) => {
        if (!torrentTitle) return false;
        
        const title = torrentTitle.toLowerCase()
            .replace(/\./g, ' ')
            .replace(/-/g, ' ')
            .replace(/\[/g, ' ')
            .replace(/\]/g, ' ')
            .replace(/\(/g, ' ')
            .replace(/\)/g, ' ')
            .replace(/_/g, ' ')
            .trim();

        const s = parseInt(season);
        const e = parseInt(episode);
        const sStr = String(s).padStart(2, '0');

        // 1. CHECK MULTI-STAGIONE
        const multiSeasonRegex = /(?:s|stagion[ie]|seasons?)\s*(\d{1,2})\s*(?:a|to|thru|e|-)\s*(?:s|stagion[ie]|seasons?)?\s*(\d{1,2})/i;
        const multiMatch = title.match(multiSeasonRegex);
        if (multiMatch) {
            const startS = parseInt(multiMatch[1]);
            const endS = parseInt(multiMatch[2]);
            if (s >= startS && s <= endS) return true;
        }

        // 2. CHECK STAGIONE SPECIFICA
        const seasonPatterns = [
            `s${sStr}`, `s${s} `, `stagione ${s}`, `stagione ${sStr}`, 
            `${s}\\^ stagione`, `season ${s}`, `serie completa`, `complete series`
        ];

        const hasSeason = seasonPatterns.some(p => title.includes(p));
        
        if (!hasSeason) {
            if (!new RegExp(`s${sStr}e`, 'i').test(title) && !new RegExp(`${s}x`, 'i').test(title)) {
                return false;
            }
        }

        // 3. CHECK EPISODIO
        const epMatch = title.match(/\b(?:e|ep|episodio|x)\s*(\d{1,3})\b/i);
        if (epMatch) {
            const foundEp = parseInt(epMatch[1]);
            if (foundEp === e) return true; 
            const rangeRegex = /(?:e|x)(\d{1,3})\s*(?:-|al?)\s*(?:e|x)?(\d{1,3})/i;
            const rangeMatch = title.match(rangeRegex);
            if (rangeMatch && e >= parseInt(rangeMatch[1]) && e <= parseInt(rangeMatch[2])) return true;
            return false; 
        }
        return true;
    },

    extractInfo: (title) => {
        const t = title.toLowerCase();
        let quality = "Unknown";
        if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) quality = "4K UHD";
        else if (t.includes("1080p")) quality = "1080p";
        else if (t.includes("720p")) quality = "720p";
        else if (t.includes("480p") || t.includes("sd")) quality = "SD";
        
        let lang = [];
        if (t.includes("ita")) lang.push("ITA 🇮🇹");
        if (t.includes("multi")) lang.push("MULTI 🌐");
        if (!t.includes("ita") && !t.includes("multi")) lang.push("ENG/SUB 🇬🇧");
        
        return { quality, lang };
    }
};

// ==========================================
// 📡 SERVICES
// ==========================================

const MetadataService = {
    get: async (id, type, tmdbKey) => {
        const cacheKey = `meta:${type}:${id}`;
        if (CACHE.metadata.has(cacheKey)) return CACHE.metadata.get(cacheKey);
        try {
            let tmdbId = id;
            let seasonNum, episodeNum;
            if (type === 'series' && id.includes(':')) {
                const parts = id.split(':');
                tmdbId = parts[0];
                seasonNum = parseInt(parts[1]);
                episodeNum = parseInt(parts[2]);
            }
            let details;
            if (tmdbId.startsWith('tt')) {
                const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
                details = (type === 'movie') ? res.data.movie_results[0] : res.data.tv_results[0];
            } else if (tmdbId.startsWith('tmdb:')) {
                const cleanId = tmdbId.split(':')[1];
                const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${cleanId}?api_key=${tmdbKey}&language=it-IT`);
                details = res.data;
            }
            if (details) {
                const meta = {
                    title: details.title || details.name,
                    originalTitle: details.original_title || details.original_name,
                    year: (details.release_date || details.first_air_date)?.split('-')[0],
                    isSeries: type === 'series',
                    season: seasonNum,
                    episode: episodeNum
                };
                CACHE.metadata.set(cacheKey, meta);
                return meta;
            }
            return null;
        } catch (e) { return null; }
    }
};

const ProviderService = {
    search: async (metadata, filters) => {
        let queries = [];
        const searchYear = metadata.isSeries ? null : metadata.year;

        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            queries.push(`${metadata.title} ITA`);
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
            queries.push(`${metadata.title} S${s}`);
            queries.push(`${metadata.title} Stagioni`);
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
                queries.push(`${metadata.originalTitle} Stagione ${metadata.season}`);
            }
        } else {
            queries.push(`${metadata.title} ITA`);
            queries.push(`${metadata.title} ${metadata.year}`);
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
            }
        }

        queries = [...new Set(queries)];
        console.log(`   🔍 Queries: ${JSON.stringify(queries)}`);

        let promises = [];
        queries.forEach(q => {
            promises.push(Corsaro.searchMagnet(q, searchYear).catch(() => []));
            promises.push(UIndex.searchMagnet(q, searchYear).catch(() => []));
        });

        if (!filters.onlyIta) {
            const cleanTitle = cleanSearchQuery(metadata.title);
            let globalQuery = metadata.isSeries ? `${cleanTitle} S${String(metadata.season).padStart(2,'0')}` : `${cleanTitle} ${metadata.year}`;
            promises.push(Knaben.searchMagnet(globalQuery, searchYear).catch(() => []));
            promises.push(Apibay.searchMagnet(globalQuery, searchYear).catch(() => []));
            promises.push(TorrentMagnet.searchMagnet(globalQuery, searchYear).catch(() => []));
        } else {
            const itaQuery = `${cleanSearchQuery(metadata.title)} ITA`;
            promises.push(Knaben.searchMagnet(itaQuery, searchYear).catch(() => []));
        }

        const resultsArray = await Promise.all(promises);
        return resultsArray.flat();
    }
};

const StreamService = {
    processResults: async (results, metadata, config) => {
        const filters = config.filters || {};
        const REAL_SIZE_FILTER = metadata.isSeries ? 50 * 1024 * 1024 : 200 * 1024 * 1024;

        // Deduplica
        const uniqueMap = new Map();
        for (const item of results) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const hash = hashMatch ? hashMatch[1].toUpperCase() : null;
            if (hash && !uniqueMap.has(hash)) uniqueMap.set(hash, item);
        }
        let uniqueResults = Array.from(uniqueMap.values());

        // 1. BRAIN FILTER
        if (metadata.isSeries) {
            uniqueResults = uniqueResults.filter(item => 
                Brain.isEpisodeMatch(item.title, metadata.season, metadata.episode)
            );
        }

        // 2. FILTRI UTENTE
        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) uniqueResults = uniqueResults.filter(i => !/cam|dvdscr|telesync/i.test(i.title));

        // 3. SIMILARITY FILTER
        uniqueResults = uniqueResults.filter(item => {
            const scoreIta = similar(metadata.title, item.title);
            const scoreEng = metadata.originalTitle ? similar(metadata.originalTitle, item.title) : 0;
            if (scoreIta < 0.33 && scoreEng < 0.33) return false;
            return true;
        });

        // 4. ORDINAMENTO
        uniqueResults.sort((a, b) => {
            const infoA = Brain.extractInfo(a.title);
            const infoB = Brain.extractInfo(b.title);
            const itaA = infoA.lang.some(l => l.includes("ITA")) ? 1 : 0;
            const itaB = infoB.lang.some(l => l.includes("ITA")) ? 1 : 0;
            if (itaA !== itaB) return itaB - itaA; 
            return (b.sizeBytes || 0) - (a.sizeBytes || 0); 
        });
        
        // --- 🛡️ LIMITAZIONE CANDIDATI (V32) ---
        // Ridotto a 12 per sicurezza massima
        const candidates = uniqueResults.slice(0, 12); 
        let streams = [];

        console.log(`   ⚡ Processing ${candidates.length} candidates (Safe Mode)...`);

        for (const item of candidates) {
            // --- 🛡️ WAIT PREVENTIVO (V32) ---
            // Aspettiamo PRIMA di fare qualsiasi cosa.
            // Questo assicura che anche in caso di continue/error, il tempo passa.
            await wait(600); 

            try {
                // Chiamata RD con protezione
                let streamData = null;
                try {
                    streamData = await RD.getStreamLink(config.rd, item.magnet);
                } catch (rdError) {
                    console.log("   ⚠️ RD Error. Waiting extra 2s...");
                    await wait(2000); // Backoff in caso di errore
                    continue; // Salta al prossimo (dopo il wait iniziale del prossimo giro)
                }

                // ========================================================
                // 🛑 STRICT MODE: Se non c'è link o non è READY, CANCELLA.
                // ========================================================
                if (!streamData) continue; 
                if (streamData.type !== 'ready' && !streamData.url) continue;

                // Filtro dimensione reale
                if (streamData.size < REAL_SIZE_FILTER) continue;

                const fileTitle = streamData?.filename || item.title;
                const finalInfo = Brain.extractInfo(fileTitle); 

                let displayLang = finalInfo.lang.join(" / ");
                if (!displayLang) {
                    if (item.source === "Corsaro") displayLang = "ITA 🇮🇹"; 
                    else if (item.source === "UIndex" && item.title.includes("ITA")) displayLang = "ITA 🇮🇹";
                    else displayLang = "ENG/MULTI ❓";
                }

                streams.push({
                    name: `[RD ⚡] ${item.source}\n${finalInfo.quality}`,
                    title: `${fileTitle}\n💾 ${formatBytes(streamData.size)}\n🔊 ${displayLang}`,
                    url: streamData.url,
                    behaviorHints: { notWebReady: false }
                });

            } catch (e) {
                // Ignora errori minori
            }
        }
        return streams;
    }
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...MANIFEST };
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    m.logo = `${protocol}://${host}/logo.png`;
    if (config.tmdb && config.rd) m.behaviorHints.configurationRequired = false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ metas: [] });
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const { type, id, userConf } = req.params;
    const cleanId = id.replace('.json', '');
    const config = getConfig(userConf);
    const cacheKey = `stream:${userConf}:${type}:${cleanId}`;

    if (CACHE.streams.has(cacheKey)) {
        console.log(`🚀 Cache Hit: ${cleanId}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.json(CACHE.streams.get(cacheKey));
    }

    console.log(`⚡ Stream Request: ${type} ${cleanId}`);
    if (!config.rd || !config.tmdb) return res.json({ streams: [{ title: "⚠️ Config mancante" }] });

    try {
        const metadata = await MetadataService.get(cleanId, type, config.tmdb);
        if (!metadata) return res.json({ streams: [{ title: "⚠️ Metadata mancante" }] });

        const rawResults = await ProviderService.search(metadata, config.filters || {});
        if (rawResults.length === 0) {
            const noRes = { streams: [{ title: "🚫 Nessun risultato ITA" }] };
            CACHE.streams.set(cacheKey, noRes, 300);
            return res.json(noRes);
        }

        const streams = await StreamService.processResults(rawResults, metadata, config);
        const response = streams.length > 0 ? { streams } : { streams: [{ title: "🚫 Nessun file in cache trovato" }] };

        CACHE.streams.set(cacheKey, response);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(response);
    } catch (error) {
        console.error("🔥 Error:", error.message);
        res.status(500).json({ streams: [{ title: "Errore Interno" }] });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 THE BRAIN V32 - SAFE MODE - Port ${PORT}`);
});
