const axios = require("axios");

// Endpoint JSON diretto (No Cloudflare)
const API_URL = "https://apibay.org/q.php";

async function searchMagnet(title, year) {
    try {
        const cleanTitle = title.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
        
        // Ricerca solo per titolo
        const query = cleanTitle;
        
        console.log(`\n--- [APIBAY BROAD SEARCH ALL] ---`);
        console.log(`🔎 Query: ${query}`);

        // MODIFICA: cat: 0 = TUTTE le categorie (aumenta le chance di trovare file catalogati male)
        const { data } = await axios.get(API_URL, {
            params: { q: query, cat: 0 }, 
            timeout: 10000
        });

        if (data.length === 0 || data[0].name === 'No results returned') {
            return [];
        }

        let results = [];

        data.forEach(item => {
            const name = item.name;
            const nameUpper = name.toUpperCase();
            
            // --- FILTRO LINGUA ---
            const isItalian = nameUpper.includes("ITA") || 
                              nameUpper.includes("ITALIAN") || 
                              nameUpper.includes("MULTI") || 
                              nameUpper.includes("DUAL");
            
            if (!isItalian) return; 

            // Filtro Anno
            if (year && !name.includes(year)) return;

            // Costruzione Magnet
            const hash = item.info_hash;
            const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
            
            // Dimensione
            const sizeBytes = parseInt(item.size);
            const sizeGB = (sizeBytes / 1073741824).toFixed(2);
            const sizeStr = `${sizeGB} GB`;

            results.push({
                title: name,
                magnet: magnet,
                size: sizeStr,
                sizeBytes: sizeBytes,
                source: "TPB"
            });
        });

        results.sort((a, b) => b.sizeBytes - a.sizeBytes);
        return results;

    } catch (error) {
        console.error("🔥 Errore APIBAY:", error.message);
        return [];
    }
}

module.exports = { searchMagnet };
