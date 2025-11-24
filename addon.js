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
    id: "org.community.corsaro-brain-v29",
    version: "29.0.0", 
    name: "Corsaro + Global (V29 ITA HUNTER)",
    description: "🇮🇹 V29: Logica ITA HUNTER. Forza la ricerca di 'Stagione X', 'ITA', 'Pack'. Ottimizzato per trovare tutto ciò che esiste in italiano.",
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

// ==========================================
// 🧠 THE BRAIN: ITALIAN SMART MATCHING (V29)
// ==========================================

const Brain = {
    isEpisodeMatch: (torrentTitle, season, episode) => {
        if (!torrentTitle) return false;
        
        // Normalizzazione aggressiva per l'italiano
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
        const eStr = String(e).padStart(2, '0');

        // 1. CHECK MULTI-STAGIONE (Es: "Stagioni 1-4", "S01-S03")
        // Fondamentale per trovare i pack giganti del Corsaro
        const multiSeasonRegex = /(?:s|stagion[ie]|seasons?)\s*(\d{1,2})\s*(?:a|to|thru|e|-)\s*(?:s|stagion[ie]|seasons?)?\s*(\d{1,2})/i;
        const multiMatch = title.match(multiSeasonRegex);
        if (multiMatch) {
            const startS = parseInt(multiMatch[1]);
            const endS = parseInt(multiMatch[2]);
            if (s >= startS && s <= endS) return true;
        }

        // 2. CHECK STAGIONE SPECIFICA
        // Deve contenere "S01", "Stagione 1", "1 Stagione", "Season 1"
        const seasonPatterns = [
            `s${sStr}`,          // S01
            `s${s} `,            // S1 (con spazio dopo)
            `stagione ${s}`,     // Stagione 1
            `stagione ${sStr}`,  // Stagione 01
            `${s}\\^ stagione`,  // 1^ Stagione
            `season ${s}`,       // Season 1
            `serie completa`,    // Serie Completa
            `complete series`
        ];

        const hasSeason = seasonPatterns.some(p => title.includes(p));
        
        if (!hasSeason) {
            // Ultima spiaggia: se il titolo ha S01E05 tutto attaccato
            if (!new RegExp(`s${sStr}e`, 'i').test(title) && !new RegExp(`${s}x`, 'i').test(title)) {
                return false;
            }
        }

        // 3. CHECK EPISODIO (Esclusione)
        // Se è un pack stagionale (Stagione 1 Completa), NON deve avere "E05" se noi cerchiamo altro.
        // Ma se cerchiamo E01 e il pack non ha numeri, va bene.
        
        // Cerchiamo se c'è un'indicazione di episodio SPECIFICO nel titolo
        const epMatch = title.match(/\b(?:e|ep|episodio|x)\s*(\d{1,3})\b/i);
        
        if (epMatch) {
            const foundEp = parseInt(epMatch[1]);
            // Se c'è scritto un episodio, deve essere quello che cerchiamo
            if (foundEp === e) return true; 
            
            // O deve essere un range che lo include (E01-E10)
            const rangeRegex = /(?:e|x)(\d{1,3})\s*(?:-|al?)\s*(?:e|x)?(\d{1,3})/i;
            const rangeMatch = title.match(rangeRegex);
            if (rangeMatch && e >= parseInt(rangeMatch[1]) && e <= parseInt(rangeMatch[2])) return true;

            return false; // È un episodio diverso
        }

        // Se arriviamo qui: C'è la stagione giusta, e NON c'è un episodio specifico.
        // Quindi è un SEASON PACK o una SERIE COMPLETA. Accettiamo!
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
        // Se non c'è scritto nulla, assumiamo ENG se non proviene da provider italiani
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

        // --- STRATEGIA ITA HUNTER (V29) ---
        if (metadata.isSeries) {
            const s = String(metadata.season).padStart(2, '0');
            
            // 1. TITOLO + ITA (Obbligatorio per UIndex)
            queries.push(`${metadata.title} ITA`);

            // 2. TITOLO + STAGIONE (Specifico per Il Corsaro)
            // Il Corsaro ha titoli tipo "Stranger Things Stagione 1" senza la scritta ITA a volte
            queries.push(`${metadata.title} Stagione ${metadata.season}`);
            queries.push(`${metadata.title} S${s}`);

            // 3. TITOLO + STAGIONI (Plurale, per i mega pack)
            queries.push(`${metadata.title} Stagioni`);

            // 4. TITOLO ORIGINALE (Se diverso)
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
                queries.push(`${metadata.originalTitle} Stagione ${metadata.season}`);
            }
        } else {
            // Film
            queries.push(`${metadata.title} ITA`); // Prima ITA
            queries.push(`${metadata.title} ${metadata.year}`); // Poi generico
            if (metadata.originalTitle && metadata.originalTitle !== metadata.title) {
                queries.push(`${metadata.originalTitle} ITA`);
            }
        }

        queries = [...new Set(queries)];
        console.log(`   🔍 Queries ITA HUNTER: ${JSON.stringify(queries)}`);

        let promises = [];

        // 1. CORSARO & UINDEX: Eseguono TUTTE le query
        // Questo è il segreto: chiedere specificamente "Stagione 1" al Corsaro lo forza a trovarla
        queries.forEach(q => {
            promises.push(Corsaro.searchMagnet(q, searchYear).catch(() => []));
            promises.push(UIndex.searchMagnet(q, searchYear).catch(() => []));
        });

        // 2. GLOBAL (Knaben, etc): Solo query "Pulita" + ITA o Sxx
        // Non vogliamo spazzatura, vogliamo solo se c'è ITA o Multi
        if (!filters.onlyIta) { // Se l'utente accetta anche non ITA, cerchiamo Sxx
            const cleanTitle = cleanSearchQuery(metadata.title);
            let globalQuery = metadata.isSeries ? `${cleanTitle} S${String(metadata.season).padStart(2,'0')}` : `${cleanTitle} ${metadata.year}`;
            
            promises.push(Knaben.searchMagnet(globalQuery, searchYear).catch(() => []));
            promises.push(Apibay.searchMagnet(globalQuery, searchYear).catch(() => []));
            promises.push(TorrentMagnet.searchMagnet(globalQuery, searchYear).catch(() => []));
        } else {
            // Se vuole SOLO ITA, proviamo a chiedere ai globali "Titolo ITA"
            const itaQuery = `${cleanSearchQuery(metadata.title)} ITA`;
            promises.push(Knaben.searchMagnet(itaQuery, searchYear).catch(() => []));
            // Apibay/TorrentMagnet spesso non hanno tag ITA precisi, meglio evitare per non avere falsi positivi
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
            if (hash && !uniqueMap.has(hash)) uniqueMap.set(hash, item);
        }
        let uniqueResults = Array.from(uniqueMap.values());

        // BRAIN FILTERING (Matching Stagione/Episodio)
        if (metadata.isSeries) {
            uniqueResults = uniqueResults.filter(item => 
                Brain.isEpisodeMatch(item.title, metadata.season, metadata.episode)
            );
        }

        if (filters.no4k) uniqueResults = uniqueResults.filter(i => !/2160p|4k|uhd/i.test(i.title));
        if (filters.noCam) uniqueResults = uniqueResults.filter(i => !/cam|dvdscr|telesync/i.test(i.title));

        // Ordinamento: ITA prima di tutto, poi Dimensione
        uniqueResults.sort((a, b) => {
            const infoA = Brain.extractInfo(a.title);
            const infoB = Brain.extractInfo(b.title);
            const itaA = infoA.lang.some(l => l.includes("ITA")) ? 1 : 0;
            const itaB = infoB.lang.some(l => l.includes("ITA")) ? 1 : 0;
            
            if (itaA !== itaB) return itaB - itaA; // ITA in cima
            return (b.sizeBytes || 0) - (a.sizeBytes || 0); // Poi i file più grossi (Pack)
        });
        
        const candidates = uniqueResults.slice(0, 50); 
        let streams = [];

        for (const item of candidates) {
            try {
                // Recuperiamo info lingua PRIMA di chiamare RD
                const info = Brain.extractInfo(item.title);
                const isIta = info.lang.some(l => l.includes("ITA"));

                // Se l'utente vuole SOLO ITA (implicito nella tua richiesta), scartiamo i non-ITA
                // A meno che non sia MULTI
                const isMulti = info.lang.some(l => l.includes("MULTI"));
                if (!isIta && !isMulti && item.source !== "Corsaro") {
                     // Se viene dal Corsaro ci fidiamo che sia ITA anche se non c'è scritto
                     // Altrimenti, se Knaben ci da un file ENG puro, lo saltiamo se siamo in modalità "Solo ITA"
                     // (Assumiamo true per questo caso d'uso)
                     // continue; <--- Scommenta se vuoi essere draconiano
                }

                const streamData = await RD.getStreamLink(config.rd, item.magnet);
                if (streamData && streamData.type === 'ready' && streamData.size < REAL_SIZE_FILTER) continue;

                const fileTitle = streamData?.filename || item.title;
                // Ricalcoliamo info sul file vero (magari il torrent dice ITA ma il file no, o viceversa)
                const finalInfo = Brain.extractInfo(fileTitle); 

                let displayLang = finalInfo.lang.join(" / ");
                if (!displayLang) {
                    if (item.source === "Corsaro") displayLang = "ITA 🇮🇹"; // Corsaro è sempre ITA
                    else if (item.source === "UIndex" && item.title.includes("ITA")) displayLang = "ITA 🇮🇹";
                    else displayLang = "ENG/MULTI ❓";
                }

                let nameTag = `[RD ⚡] ${item.source}\n${finalInfo.quality}`;
                if (!streamData) nameTag = `[RD ⏳] ${item.source}\n${finalInfo.quality}`;

                let titleStr = `${fileTitle}\n`;
                titleStr += `💾 ${streamData?.size ? formatBytes(streamData.size) : (item.size || "??")}\n`;
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
                        title: `${titleStr}\n⚠️ Download Richiesto`,
                        url: item.magnet,
                        behaviorHints: { notWebReady: true }
                    });
                }
                await wait(20); 
            } catch (e) {}
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
            const noRes = { streams: [{ title: "🚫 Nessun risultato ITA (V29)" }] };
            CACHE.streams.set(cacheKey, noRes, 300);
            return res.json(noRes);
        }

        const streams = await StreamService.processResults(rawResults, metadata, config);
        const response = streams.length > 0 ? { streams } : { streams: [{ title: "🚫 Nessun file valido trovato (V29)" }] };

        CACHE.streams.set(cacheKey, response);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(response);
    } catch (error) {
        console.error("🔥 Error:", error.message);
        res.status(500).json({ streams: [{ title: "Errore Interno" }] });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 THE BRAIN V29 - ITA HUNTER - Port ${PORT}`);
});
