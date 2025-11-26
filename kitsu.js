const axios = require("axios");

// Cache in memoria per evitare di scaricare il JSON gigante ogni volta
let mappingCache = null;

async function kitsuHandler(kitsuID) {
    const kitsuToIMDBurl = "https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/master/static/data/imdb_mapping.json";

    try {
        // Scarica il mapping solo se non è già in cache
        if (!mappingCache) {
            console.log("📥 Scaricamento mapping Kitsu -> IMDB...");
            const response = await axios.get(kitsuToIMDBurl);
            mappingCache = response.data;
        }

        if (mappingCache[kitsuID]) {
            const entry = mappingCache[kitsuID];
            const imdbID = entry.imdb_id;

            // Opzionale: Verifica su IMDB se è una serie o film
            
            let isSeries = false;
            try {
                const imdbResponse = await axios.get(`https://v2.sg.media-imdb.com/suggestion/t/${imdbID}.json`);
                if (imdbResponse.data.d && imdbResponse.data.d[0].q === "TV series") {
                    isSeries = true;
                }
            } catch (e) {
                console.log("⚠️ Errore controllo IMDB:", e.message);
                // Fallback: assumiamo sia serie se ci sono dati di stagione
                if (entry.fromSeason) isSeries = true;
            }

            if (isSeries) {
                return {
                    imdbID: imdbID,
                    season: entry.fromSeason || 1,
                    episodeStart: entry.fromEpisode || 1 // Utile per calcolare l'offset
                };
            } else {
                return { imdbID: imdbID };
            }
        }
    } catch (e) {
        console.log("🔥 Errore Kitsu Handler:", e.message);
    }
    
    return null;
}

module.exports = kitsuHandler;
