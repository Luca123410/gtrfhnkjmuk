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

// LISTA TRACKERS DI FALLBACK (Migliora resilienza download su RD)
const BEST_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://9.rarbg.to:2920/announce",
    "udp://tracker.coppersurfer.tk:6969/announce",
    "udp://tracker.leechers-paradise.org:6969/announce",
    "udp://tracker.internetwarriors.net:1337/announce"
];

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST (V31.1 STABLE) ---
const MANIFEST = {
    id: "org.community.corsaro-brain-v31-stable",
    version: "31.1.0", 
    name: "Corsaro + Global (V31 STABLE)",
    description: "🇮🇹 V31.1: Anime Support + Anti-429 Protection. Ottimizzato per Real-Debrid.",
    resources: ["catalog", "stream"],
    types: ["movie", "series", "anime"],
    catalogs: [
        { type: "movie", id: "tmdb_trending", name: "Popolari Italia" },
        { type: "series", id: "tmdb_trending_series", name: "Serie TV Popolari" }
    ],
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

function enrichMagnet(magnet) {
    if (!magnet.startsWith("magnet:?")) return magnet;
    const trParams = BEST_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");
    return magnet + trParams;
}

// ==========================================
// 🧠 THE BRAIN: MATCHING INTELLIGENTE V2
// ==========================================

const Brain = {
    isEpisodeMatch: (torrentTitle, season, episode, isAnime = false) => {
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

        // 1. ANIME / ABSOLUTE NUMBERING
        if (isAnime) {
            const absoluteRegex = new RegExp(`(?:\\s|\\.|_|\\[|#)${e}(?:\\s|\\.|_|\\]|v\\d|$)`, 'i');
            if (absoluteRegex.test(title)) return true;
        }

        // 2. CHECK MULTI-STAGIONE (Range S01-S03)
        const multiSeasonRegex = /(?:s|stagion[ie]|seasons?)\s*(\d{1,2})\s*(?:a|to|thru|e|-)\s*(?:s|stagion[ie]|seasons?)?\s*(\d{1,2})/i;
        const multiMatch = title.match(multiSeasonRegex);
        if (multiMatch) {
            const startS = parseInt(multiMatch[1]);
            const endS = parseInt(multiMatch[2]);
            if (s >= startS && s <= endS) return true;
        }
        
        const rangePack = title.match(/S(\d+)\s*-\s*S(\d+)/i);
        if (rangePack) {
            const start = parseInt(rangePack[1]);
            const end = parseInt(rangePack[2]);
            if (s >= start && s <= end) return true;
        }

        // 3. CHECK STAGIONE SPECIFICA
        const seasonPatterns = [
            `s${sStr}`, `s${s} `, `stagione ${s}`, `stagione ${sStr}`,  
            `${s}\\^ stagione`, `season ${s}`, `serie completa`, `complete series`
        ];

        const hasSeason = seasonPatterns.some(p => title.includes(p));
        
        if (!hasSeason && !isAnime) {
            if (!new RegExp(`s${sStr}e`, 'i').test(title) && !new RegExp(`${s}x`, 'i').test(title)) {
                return false;
            }
        }

        // PACK DETECTION
        if (hasSeason && (title.includes("pack") || title.includes("completa") || title.includes("complete") || title.includes("tutta"))) {
            return true;
        }

        // 4. CHECK EPISODIO
        const epMatch = title.match(/\b(?:e|ep|episodio|x)\s*(\d{1,3})\b/i);
        if (epMatch) {
            const foundEp = parseInt(epMatch[1]);
            if (foundEp === e) return true; 
            const rangeRegex = /(?:e|x)(\d{1,3})\s*(?:-|al?)\s*(?:e|x)?(\d{1,3})/i;
            const rangeMatch = title.match(rangeRegex);
            if (rangeMatch && e >= parseInt(rangeMatch[1]) && e <= parseInt(rangeMatch[2])) return true;
            return false; 
        }

        if (hasSeason) return true;
        return false;
    },

    extractInfo: (title) => {
        const t = title.toLowerCase();
        let quality = "Unknown";
        if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) quality = "4K UHD";
        else if (t.includes("1080p")) quality = "1080p";
        else if (t.includes("720p")) quality = "720p";
        else if (t.includes("480p") || t.includes("sd")) quality = "SD";
        
        let lang = [];
        if (t.includes("sub ita") || t.includes("subita") || t.includes("vose")) lang.push("SUB-ITA 🇮🇹");
        else if (t.includes("ita") || t.includes("italian") || t.includes("itali")) lang.push("ITA 🇮🇹");
        if (t.includes("multi") || t.includes("mux") || t.includes("mxt")) lang.push("MULTI 🌐");
        if (lang.length === 0) lang.push("ENG/SUB 🇬🇧");
        
        // AUDIO DETECTION
        let audio = "";
        if (t.match(/ac3|dd5\.1|5\.1|dts/)) audio = "🔊 5.1";
        else if (t.match(/aac|2\.0|stereo/)) audio = "🔊 2.0";

        return { quality, lang, audio };
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
                const genres = details.genres || [];
                const isAnime = genres.some(g => g.name === 'Animation') || details.original_language === 'ja';

                const meta = {
                    title: details.title || details.name,
                    originalTitle: details.original_title || details.original_name,
                    year: (details.release_date || details.first_air_date)?.split('-')[0],
                    isSeries: type === 'series',
                    isAnime: isAnime,
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
        
        const cleanTitle = cleanSearchQuery(metadata.title);
        const isShortTitle = cleanTitle.length < 4; 

        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0'); 

            queries.push(`${metadata.title} ITA`);
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
            queries.push(`${metadata.title} S${s}`);
            queries.push(`${metadata.title} stagione ${metadata.season} pack ita`);
            queries.push(`${metadata.title} S${s} completa ita`);
            
            if (metadata.isAnime) {
                queries.push(`${metadata.title} ${metadata.episode}`);
                queries.push(`${metadata.title} ${metadata.episode} ITA`);
            } else {
                queries.push(`${metadata.title} ${metadata.season}x${e} ita`);
            }

            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
                queries.push(`${metadata.originalTitle} S${s}`);
                if (metadata.isAnime) queries.push(`${metadata.originalTitle} ${metadata.episode}`);
            }
        } else {
            if (!isShortTitle) queries.push(`${metadata.title} ITA`);
            queries.push(`${metadata.title} ${metadata.year}`);
            queries.push(`${metadata.title} ITA ${metadata.year}`); 
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
                queries.push(`${metadata.originalTitle} ${metadata.year}`);
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
            let globalQuery = metadata.isSeries 
                ? `${cleanTitle} S${String(metadata.season).padStart(2,'0')}` 
                : `${cleanTitle} ${metadata.year}`; 
            
            if (metadata.isAnime) globalQuery = `${cleanTitle} ${metadata.episode}`;
            const itaQuery = `${cleanSearchQuery(metadata.title)} ITA`;

            promises.push(Knaben.searchMagnet(globalQuery, searchYear).catch(() => []));
            promises.push(Knaben.searchMagnet(itaQuery, searchYear).catch(() => []));
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

        const uniqueMap = new Map();
        for (const item of results) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const hash = hashMatch ? hashMatch[1].toUpperCase() : null;
            if (hash && !uniqueMap.has(hash)) {
                item.magnet = enrichMagnet(item.magnet);
                uniqueMap.set(hash, item);
            }
        }
        let uniqueResults = Array.from(uniqueMap.values());

        if (metadata.isSeries) {
            uniqueResults = uniqueResults.filter(item => 
                Brain.isEpisodeMatch(item.title, metadata.season, metadata.episode, metadata.isAnime)
            );
        }

        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) uniqueResults = uniqueResults.filter(i => !/cam|dvdscr|telesync/i.test(i.title));

        uniqueResults.sort((a, b) => {
            const infoA = Brain.extractInfo(a.title);
            const infoB = Brain.extractInfo(b.title);
            const itaA = infoA.lang.some(l => l.includes("ITA")) ? 1 : 0;
            const itaB = infoB.lang.some(l => l.includes("ITA")) ? 1 : 0;
            if (itaA !== itaB) return itaB - itaA; 
            return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        });
        
        // 🛡️ SICUREZZA ANTI-429: Processa max 30 risultati
        const candidates = uniqueResults.slice(0, 30); 
        let streams = [];

        console.log(`   ⚡ RD Checking ${candidates.length} candidates...`);

        for (const item of candidates) {
            try {
                // 1. Richiesta a RD
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                // 2. PAUSA TATTICA (Anti-429)
                await wait(250); 

                if (!streamData) continue;
                if (streamData.type !== 'ready') continue;
                if (streamData.size < REAL_SIZE_FILTER) continue;

                const fileTitle = streamData.filename || item.title;
                const finalInfo = Brain.extractInfo(fileTitle); 

                let displayLang = finalInfo.lang.join(" / ");
                if (!displayLang) {
                    if (item.source.includes("Corsaro")) displayLang = "ITA 🇮🇹";
                    else if (item.source.includes("UIndex") && item.title.includes("ITA")) displayLang = "ITA 🇮🇹";
                    else displayLang = "ENG/MULTI ❓";
                }

                let nameTag = `[RD ⚡] ${item.source}\n${finalInfo.quality}`;
                let titleStr = `${fileTitle}\n`;
                titleStr += `💾 ${formatBytes(streamData.size)} `;
                if (finalInfo.audio) titleStr += `${finalInfo.audio}\n`;
                else titleStr += "\n";
                titleStr += `🔊 ${displayLang}`;

                streams.push({
                    name: nameTag,
                    title: titleStr,
                    url: streamData.url,
                    behaviorHints: { notWebReady: false }
                });
                
            } catch (e) {
                // 3. GESTIONE RATE LIMIT
                if (e.message && e.message.includes('429')) {
                    console.log("⚠️ RD RATE LIMIT! Raffreddamento 2 secondi...");
                    await wait(2000); 
                }
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
        const response = streams.length > 0 ? { streams } : { streams: [{ title: "🚫 Nessun file CACHED trovato" }] };

        CACHE.streams.set(cacheKey, response);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(response);
    } catch (error) {
        console.error("🔥 Error:", error.message);
        res.status(500).json({ streams: [{ title: "Errore Interno" }] });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 BRAIN V31.1 (ANTI-429) - Port ${PORT}`);
});
