const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI PROVIDER ---
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./1337x");
const UIndex = require("./uindex"); 
const Knaben = require("./knaben");
const kitsuHandler = require("./kitsu"); // <--- NUOVO MODULO KITSU

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
    id: "org.community.corsaro-brain-v37",
    version: "37.1.0", 
    name: "Corsaro + Global (V37 Knaben+Anime)",
    description: "🇮🇹 V37.1: Motore Knaben + Supporto Kitsu Anime. Hybrid Search. Safe Mode.",
    resources: ["catalog", "stream"],
    types: ["movie", "series", "anime"], // Aggiunto anime per sicurezza
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt", "kitsu"], // <--- AGGIUNTO KITSU QUI
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

// ==========================================
// 🧠 THE BRAIN: MATCHING & EXTRACTION
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

        // 1. Multi-Stagione
        const multiSeasonRegex = /(?:s|stagion[ie]|seasons?)\s*(\d{1,2})\s*(?:a|to|thru|e|-)\s*(?:s|stagion[ie]|seasons?)?\s*(\d{1,2})/i;
        const multiMatch = title.match(multiSeasonRegex);
        if (multiMatch) {
            const startS = parseInt(multiMatch[1]);
            const endS = parseInt(multiMatch[2]);
            if (s >= startS && s <= endS) return true;
        }

        // 2. Stagione Specifica / Completa
        const seasonPatterns = [
            `s${sStr}`, `s${s} `, `stagione ${s}`, `stagione ${sStr}`, 
            `${s}\\^ stagione`, `season ${s}`, `serie completa`, `complete series`
        ];
        const hasSeason = seasonPatterns.some(p => title.includes(p));
        
        if (!hasSeason) {
            // Se non c'è la stagione scritta esplicitamente, scarta (per sicurezza sui pack)
            if (!new RegExp(`s${sStr}e`, 'i').test(title) && !new RegExp(`${s}x`, 'i').test(title)) {
                return false;
            }
        }

        // 3. Episodio
        const epMatch = title.match(/\b(?:e|ep|episodio|x)\s*(\d{1,3})\b/i);
        if (epMatch) {
            const foundEp = parseInt(epMatch[1]);
            if (foundEp === e) return true; 
            // Range episodi (es. E01-E10)
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

            // --- GESTIONE KITSU (Nuova Integrazione) ---
            if (id.startsWith("kitsu:")) {
                // Formato tipico: kitsu:ID_ANIME:EPISODIO (es. kitsu:1234:5)
                const parts = id.split(":");
                const kitsuIdClean = parts[1];
                const kitsuEp = parts[2] ? parseInt(parts[2]) : 1;

                console.log(`👹 Kitsu Detected: ID ${kitsuIdClean} Ep ${kitsuEp}`);
                
                // Usiamo il nuovo handler
                const conversion = await kitsuHandler(kitsuIdClean);
                
                if (conversion && conversion.imdbID) {
                    console.log(`   ✅ Kitsu -> IMDB: ${conversion.imdbID}`);
                    tmdbId = conversion.imdbID; // Ora abbiamo un tt1234567

                    // Se il mapping ci dà una stagione specifica, usiamola
                    if (conversion.season) {
                        seasonNum = conversion.season;
                        // Nota: Qui assumiamo che l'episodio richiesto (kitsuEp) corrisponda 
                        // all'episodio all'interno della stagione mappata.
                        episodeNum = kitsuEp; 
                        
                        // Forziamo il tipo a serie perché Kitsu è quasi sempre serie/anime
                        type = 'series'; 
                    } else {
                        // Se è un film anime o non c'è mapping stagione
                         if (conversion.imdbID) tmdbId = conversion.imdbID;
                    }
                } else {
                    console.log("   ❌ Kitsu Conversion Failed. Tentativo con ID originale (probabilmente fallirà).");
                }
            }
            // --- FINE GESTIONE KITSU ---

            // Gestione standard Series (tt o tmdb) - Solo se non è già stato gestito da Kitsu o se è standard
            if (type === 'series' && id.includes(':') && !seasonNum) {
                const parts = id.split(':');
                tmdbId = parts[0];
                seasonNum = parseInt(parts[1]);
                episodeNum = parseInt(parts[2]);
            }

            let details;
            // Recupero Dettagli da TMDB (che ora funzionerà anche per Kitsu convertiti in tt...)
            if (tmdbId.startsWith('tt')) {
                const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
                details = (type === 'movie' || !res.data.tv_results.length) ? res.data.movie_results[0] : res.data.tv_results[0];
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
                    isSeries: type === 'series' || !!seasonNum, // È serie se il tipo lo dice O se abbiamo una stagione
                    season: seasonNum,
                    episode: episodeNum
                };
                CACHE.metadata.set(cacheKey, meta);
                return meta;
            }
            return null;
        } catch (e) { 
            console.log("Metadata Error:", e.message);
            return null; 
        }
    }
};

const ProviderService = {
    search: async (metadata, filters) => {
        // --- V23 HYBRID STRATEGY (ITA + ENG) ---
        let queries = [];
        
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            queries.push(`${metadata.title} S${s}`); // Standard S01
            queries.push(`${metadata.title} Stagione ${metadata.season}`); // Italiano
            
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} S${s}`); // Originale S01
                queries.push(`${metadata.originalTitle} Season ${metadata.season}`); // Inglese
            }
        } else {
            queries.push(`${metadata.title} ${metadata.year}`);
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ${metadata.year}`);
            }
        }

        queries = [...new Set(queries)].map(q => cleanSearchQuery(q));
        console.log(`   🔍 Strategies: ${JSON.stringify(queries)}`);

        let promises = [];
        const searchYear = metadata.isSeries ? null : metadata.year;

        queries.forEach(q => {
            // 1. Italian Providers
            promises.push(Corsaro.searchMagnet(q, searchYear).catch(() => []));
            promises.push(UIndex.searchMagnet(q, searchYear).catch(() => []));
            
            // 2. Global Providers (Knaben è il re qui)
            if (!filters.onlyIta) {
                promises.push(Knaben.searchMagnet(q, searchYear).catch(() => [])); 
                promises.push(Apibay.searchMagnet(q, searchYear).catch(() => []));
            }
        });
        
        // Se vuole SOLO ITA, forziamo comunque una ricerca su Knaben con "ITA"
        if (filters.onlyIta) {
            const itaQuery = `${metadata.title} ITA`;
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

        // 1. BRAIN FILTER (Episode Matching)
        if (metadata.isSeries) {
            uniqueResults = uniqueResults.filter(item => 
                Brain.isEpisodeMatch(item.title, metadata.season, metadata.episode)
            );
        }

        // 2. FILTRI UTENTE
        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) uniqueResults = uniqueResults.filter(i => !/cam|dvdscr|telesync/i.test(i.title));

        // 3. SORTING
        uniqueResults.sort((a, b) => {
            const itaA = (Brain.extractInfo(a.title).lang.some(l => l.includes("ITA"))) ? 1 : 0;
            const itaB = (Brain.extractInfo(b.title).lang.some(l => l.includes("ITA"))) ? 1 : 0;
            if (itaA !== itaB) return itaB - itaA; 
            return (b.sizeBytes || 0) - (a.sizeBytes || 0); 
        });
        
        // --- SAFE MODE LIMIT (12) ---
        const candidates = uniqueResults.slice(0, 12); 
        let streams = [];

        console.log(`   ⚡ Processing ${candidates.length} candidates (Safe Mode)...`);

        for (const item of candidates) {
            await wait(600); 

            try {
                let streamData = null;
                try {
                    streamData = await RD.getStreamLink(config.rd, item.magnet);
                } catch (rdError) {
                    console.log(`   ⚠️ RD Error (${rdError.response?.status || 'Unknown'}). Fallback...`);
                    const fallbackInfo = Brain.extractInfo(item.title);
                    streams.push({
                        name: `[⚠️ Error] ${item.source}\n${fallbackInfo.quality}`,
                        title: `⚠️ RD Error (${rdError.response?.status || '!'})\n📄 ${item.title}\n💾 ${item.size || "??"}`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true, bin: true }
                    });
                    await wait(2000); 
                    continue; 
                }

                if (!streamData) continue; 
                if (streamData.type !== 'ready' && !streamData.url) continue;
                if (streamData.size < REAL_SIZE_FILTER) continue;

                const fileTitle = streamData?.filename || item.title;
                const finalInfo = Brain.extractInfo(fileTitle); 

                let displayLang = finalInfo.lang.join(" / ");
                if (!displayLang) {
                    if (item.source === "Corsaro") displayLang = "ITA 🇮🇹"; 
                    else if (item.source === "UIndex" && item.title.includes("ITA")) displayLang = "ITA 🇮🇹";
                    else if (item.source === "Knaben" && /ITA|Italian/i.test(item.title)) displayLang = "ITA 🇮🇹";
                    else displayLang = "ENG/MULTI ❓";
                }

                streams.push({
                    name: `[RD ⚡] ${item.source}\n${finalInfo.quality}`,
                    title: `${fileTitle}\n💾 ${formatBytes(streamData.size)}\n🔊 ${displayLang}`,
                    url: streamData.url,
                    behaviorHints: { notWebReady: false }
                });

            } catch (e) { }
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
            const noRes = { streams: [{ title: "🚫 Nessun risultato" }] };
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
    console.log(`🚀 THE BRAIN V37.1 - KNABEN + ANIME - Port ${PORT}`);
});
