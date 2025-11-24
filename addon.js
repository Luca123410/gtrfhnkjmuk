const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const NodeCache = require("node-cache");

// --- MODULI ESTERNI ---
const RD = require("./rd");
const Corsaro = require("./corsaro");
const Apibay = require("./apibay");
const TorrentMagnet = require("./torrentmagnet");
const UIndex = require("./uindex"); 

// --- CONFIGURAZIONE CACHE ---
const streamCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min
const catalogCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 }); // 12 ore

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MANIFEST ---
const manifestBase = {
    id: "org.community.corsaro-brain-update",
    version: "23.0.0", 
    name: "Corsaro + Global (THE BRAIN)",
    description: "🇮🇹 Motore V23: Matching Intelligente Episodi, Auto-Selezione File RD, Multi-Strategia di Ricerca. Il più avanzato di sempre.",
    resources: ["catalog", "stream"],
    types: ["movie", "series"],
    catalogs: [{ type: "movie", id: "tmdb_trending", name: "Popolari Italia" }],
    idPrefixes: ["tmdb", "tt"],
    behaviorHints: { configurable: true, configurationRequired: true }
};

// --- UTILITIES ---
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const REAL_SIZE_FILTER = 200 * 1024 * 1024; // 200MB soglia minima

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

// --- 🧠 SMART MATCHING LOGIC (Estratta dal tuo script avanzato) ---
function isExactEpisodeMatch(torrentTitle, season, episode) {
    if (!torrentTitle) return false;
    const title = torrentTitle.toLowerCase();
    const s = season;
    const e = episode;
    const sStr = String(s).padStart(2, '0');
    const eStr = String(e).padStart(2, '0');

    // 1. Match Esatto Standard (S01E01, 1x01)
    const exactPatterns = [
        new RegExp(`s${sStr}e${eStr}`, 'i'),
        new RegExp(`${s}x${eStr}`, 'i'),
        new RegExp(`s${sStr}\\.?e${eStr}`, 'i')
    ];
    if (exactPatterns.some(p => p.test(title))) return true;

    // 2. Match Range Episodi (S01E01-10 include E05?)
    // Es: S01E01-12, 1x01-12
    const rangePattern = new RegExp(`s${sStr}e(\\d{1,2})\\s*[-–—]\\s*e?(\\d{1,2})`, 'i');
    const rangeMatch = title.match(rangePattern);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        if (e >= start && e <= end) return true;
    }

    // 3. Match Season Pack (S01 Complete, Stagione 1)
    // Se cerchiamo S01E05 e troviamo "Stagione 1 Completa", è un match!
    const packPatterns = [
        new RegExp(`stagione\\s*${s}(?!\\d)`, 'i'), // Stagione 1
        new RegExp(`season\\s*${s}(?!\\d)`, 'i'),   // Season 1
        new RegExp(`s${sStr}\\s*(?:completa|complete|pack)`, 'i'), // S01 Complete
        new RegExp(`s${sStr}\\s*$`, 'i') // Finisce con S01
    ];
    if (packPatterns.some(p => p.test(title))) return true;

    return false;
}

function extractStreamInfo(title) {
    const t = title.toLowerCase();
    let quality = "Unknown";
    if (t.includes("2160p") || t.includes("4k")) quality = "4k";
    else if (t.includes("1080p")) quality = "1080p";
    else if (t.includes("720p")) quality = "720p";
    else if (t.includes("480p") || t.includes("sd")) quality = "SD";
    else if (t.includes("dvdrip")) quality = "DVD";

    let extra = [];
    if (t.includes("hdr") || t.includes("10bit")) extra.push("HDR");
    if (t.includes("dolby") || t.includes("vision")) extra.push("DV");
    if (t.includes("hevc") || t.includes("x265")) extra.push("HEVC");
    if (t.includes("5.1") || t.includes("ac3")) extra.push("5.1");

    let lang = [];
    if (t.includes("ita")) lang.push("ITA 🇮🇹");
    if (t.includes("multi")) lang.push("MULTI 🌐");
    
    return { quality, lang, extraInfo: extra.join(" | ") };
}

async function getMetadata(id, type, tmdbKey) {
    try {
        let tmdbId = id;
        let seasonNum, episodeNum;
        if (type === 'series' && id.includes(':')) {
            const parts = id.split(':');
            tmdbId = parts[0]; seasonNum = parseInt(parts[1]); episodeNum = parseInt(parts[2]);
        }
        let details;
        if (tmdbId.startsWith('tt')) {
            const res = await axios.get(`https://api.themoviedb.org/3/find/${tmdbId}?api_key=${tmdbKey}&language=it-IT&external_source=imdb_id`);
            if (type === 'movie') details = res.data.movie_results[0];
            else details = res.data.tv_results[0];
        } else if (tmdbId.startsWith('tmdb:')) {
            const cleanId = tmdbId.split(':')[1];
            const res = await axios.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${cleanId}?api_key=${tmdbKey}&language=it-IT`);
            details = res.data;
        }
        if (details) {
            return {
                title: details.title || details.name, 
                originalTitle: details.original_title || details.original_name, 
                year: (details.release_date || details.first_air_date)?.split('-')[0],
                isSeries: type === 'series', season: seasonNum, episode: episodeNum
            };
        }
        return null;
    } catch (e) { return null; }
}

// --- CATALOGO ---
async function generateCatalog(type, id, config) {
    const cacheKey = `catalog:${type}:${id}`;
    if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);

    if (id === "tmdb_trending" && config.tmdb) {
        try {
            const r = await axios.get(`https://api.themoviedb.org/3/trending/movie/day?api_key=${config.tmdb}&language=it-IT`);
            const result = { metas: r.data.results.map(m => ({
                id: `tmdb:${m.id}`, type: "movie", name: m.title, poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`
            }))};
            catalogCache.set(cacheKey, result);
            return result;
        } catch (e) { return { metas: [] }; }
    }
    return { metas: [] };
}

// --- STREAM HANDLER POTENZIATO ---
async function generateStream(type, id, config, userConfStr) {
    const { rd, tmdb } = config || {};
    const filters = config.filters || {}; 
    const cacheKey = `stream:${userConfStr}:${type}:${id}`;

    if (streamCache.has(cacheKey)) {
        console.log(`🚀 STREAM CACHED: ${id}`);
        return streamCache.get(cacheKey);
    }

    console.log(`⚡ STREAM LIVE (V23 Brain): ${id}`);
    if (!rd || !tmdb) return { streams: [{ title: "⚠️ Configurazione mancante" }] };

    try {
        const metadata = await getMetadata(id, type, tmdb);
        if (!metadata) return { streams: [{ title: "⚠️ Metadata non trovato" }] };

        // --- MULTI-STRATEGY SEARCH ---
        // Costruiamo diverse query per massimizzare i risultati
        let queries = [];
        
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            const e = String(metadata.episode).padStart(2, '0');
            // 1. Titolo ITA + SxxExx (Standard)
            queries.push(`${metadata.title} S${s}E${e}`);
            // 2. Titolo ITA + Stagione Pack (Per i pack completi)
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
            
            // 3. Se il titolo originale è diverso, prova anche quello
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} S${s}E${e}`);
                queries.push(`${metadata.originalTitle} Season ${metadata.season}`);
            }
        } else {
            // Film
            queries.push(`${metadata.title} ${metadata.year}`);
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ${metadata.year}`);
            }
        }

        // Rimuovi duplicati
        queries = [...new Set(queries)];
        console.log(`   🔍 Strategies: ${JSON.stringify(queries)}`);

        // Eseguiamo le ricerche in parallelo su Corsaro e UIndex (i più importanti per ITA)
        // Gli altri (Apibay/TorrentMagnet) cercheranno solo la query principale per non rallentare troppo
        let promises = [];

        // Corsaro & UIndex: cercano TUTTE le query
        queries.forEach(q => {
            promises.push(Corsaro.searchMagnet(q, metadata.year).catch(()=>[]));
            promises.push(UIndex.searchMagnet(q, metadata.year).catch(()=>[]));
        });

        // Globali: cercano solo la PRIMA query (Titolo principale)
        if (!filters.onlyIta) {
            promises.push(Apibay.searchMagnet(queries[0], metadata.year).catch(()=>[]));
            promises.push(TorrentMagnet.searchMagnet(queries[0], metadata.year).catch(()=>[]));
        }

        const resultsArray = await Promise.all(promises);
        let allResults = resultsArray.flat();

        if (allResults.length === 0) return { streams: [{ title: `🚫 Nessun risultato (V23)` }] };

        // DEDUPLICAZIONE
        let uniqueResults = [];
        const magnetSet = new Set();
        for (const item of allResults) {
            const hashMatch = item.magnet.match(/btih:([A-F0-9]{40})/i);
            const key = hashMatch ? hashMatch[1].toUpperCase() : item.magnet;
            if (!magnetSet.has(key)) {
                magnetSet.add(key);
                uniqueResults.push(item);
            }
        }

        // --- INTELLIGENT FILTERING (The Brain) ---
        if (metadata.isSeries) {
            const initialCount = uniqueResults.length;
            uniqueResults = uniqueResults.filter(item => {
                return isExactEpisodeMatch(item.title, metadata.season, metadata.episode);
            });
            console.log(`   🧠 Brain Filter: ${initialCount} -> ${uniqueResults.length} torrents validi per S${metadata.season}E${metadata.episode}`);
        }

        // Filtri Utente Standard
        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) {
            const bad = ['cam', 'dvdscr', 'hdcam', 'telesync', 'tc', 'ts'];
            uniqueResults = uniqueResults.filter(i => !bad.some(q => i.title.toLowerCase().includes(q)));
        }

        uniqueResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
        const topResults = uniqueResults.slice(0, 20); 

        // VERIFICA RD
        let streams = [];
        for (const item of topResults) {
            try {
                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                
                if (streamData && streamData.type === 'ready' && streamData.size < REAL_SIZE_FILTER) continue; 

                const fileTitle = streamData?.filename || item.title;
                const { quality, lang, extraInfo } = extractStreamInfo(fileTitle);
                
                let displayLang = lang.join(" / ");
                if (!displayLang) {
                     if (item.source === "Corsaro" || item.source === "UIndex") displayLang = "ITA 🇮🇹";
                     else displayLang = "MULTI / ENG 🌐";
                }

                let nameTag = `[RD ⚡] ${item.source}`;
                if (!streamData) nameTag = `[RD ⏳] ${item.source}`;
                nameTag += `\n${quality}`;

                let finalSize = streamData?.size ? formatBytes(streamData.size) : (item.size || "?? GB");
                if (!streamData) {
                     if(finalSize.includes("MB") && parseInt(finalSize) < 100) finalSize = "?? GB";
                     if(finalSize.toLowerCase().endsWith("b") && !finalSize.toLowerCase().includes("k")) finalSize = "?? GB";
                }

                let titleStr = `📄 ${fileTitle}\n`;
                titleStr += `💾 ${finalSize}`;
                if (extraInfo) titleStr += ` | ${extraInfo}`;
                titleStr += `\n⚙️ ${item.source}\n`;
                titleStr += `🔊 ${displayLang}`;

                if (streamData) {
                    streams.push({
                        name: nameTag,
                        title: titleStr,
                        url: streamData.url,
                        behaviorHints: { notWebReady: false }
                    });
                } else if (filters.showFake) {
                    streams.push({
                        name: nameTag.replace('⚡', '⚠️'),
                        title: `${titleStr}\n⚠️ Link Diretto (Download Richiesto)`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true }
                    });
                }
                await wait(50); 
            } catch (e) {}
        }

        const finalResponse = streams.length === 0 ? { streams: [{ title: "🚫 Nessun file valido trovato." }] } : { streams };
        streamCache.set(cacheKey, finalResponse);
        return finalResponse;
    } catch (error) {
        console.error("🔥 Errore fatale:", error.message);
        return { streams: [{ title: "Errore Interno Addon" }] };
    }
}

// --- ROUTING ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/:userConf/manifest.json', (req, res) => {
    const config = getConfig(req.params.userConf);
    const m = { ...manifestBase };
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    m.logo = `${protocol}://${host}/logo.png`;
    if (config.tmdb && config.rd) m.behaviorHints = { configurable: true, configurationRequired: false };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(m);
});

app.get('/:userConf/catalog/:type/:id.json', async (req, res) => {
    const result = await generateCatalog(req.params.type, req.params.id, getConfig(req.params.userConf));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=43200');
    res.json(result);
});

app.get('/:userConf/stream/:type/:id.json', async (req, res) => {
    const streams = await generateStream(
        req.params.type, 
        req.params.id.replace('.json', ''), 
        getConfig(req.params.userConf),
        req.params.userConf 
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.json(streams);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon The Brain v23.0.0 avviato su porta ${PORT}!`));
