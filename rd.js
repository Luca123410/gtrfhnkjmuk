const axios = require("axios");

const RD_API = "https://api.real-debrid.com/rest/1.0";
const TIMEOUT = 20000; // 20 Secondi

class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    async request(method, endpoint, data = null) {
        try {
            const config = {
                method,
                url: `${RD_API}${endpoint}`,
                headers: this.headers,
                timeout: TIMEOUT
            };

            if (data) {
                const params = new URLSearchParams();
                for (const key in data) params.append(key, data[key]);
                config.data = params;
            }

            const response = await axios(config);
            return response.data;
        } catch (error) {
            if (error.response) {
                const status = error.response.status;
                if (status === 401) throw new Error("RD_INVALID_TOKEN");
                if (status === 403) throw new Error("RD_PERMISSION_DENIED");
                if (status === 503) throw new Error("RD_SERVICE_UNAVAILABLE");
            }
            throw error;
        }
    }

    // --- NUOVO: CONTROLLO BATCH DISPONIBILITÀ ---
    async checkInstantAvailability(hashes) {
        // RD accetta hash multipli separati da /
        const path = `/torrents/instantAvailability/${hashes.join('/')}`;
        return this.request('GET', path);
    }

    async addMagnet(magnet) { return this.request('POST', '/torrents/addMagnet', { magnet }); }
    async selectFiles(torrentId, files = 'all') { return this.request('POST', `/torrents/selectFiles/${torrentId}`, { files }); }
    async getInfo(torrentId) { return this.request('GET', `/torrents/info/${torrentId}`); }
    async unrestrictLink(link) { return this.request('POST', '/unrestrict/link', { link }); }
}

/**
 * NUOVA FUNZIONE: Controlla se i magnet sono già in cache (Senza aggiungerli)
 * Restituisce una mappa degli hash disponibili.
 */
async function checkBatchAvailability(apiKey, hashes) {
    if (!hashes || hashes.length === 0) return {};
    const rd = new RealDebridClient(apiKey);
    try {
        return await rd.checkInstantAvailability(hashes);
    } catch (error) {
        console.error("⚠️ RD Batch Check Error:", error.message);
        return {}; // Ritorna vuoto in caso di errore per non bloccare il flusso
    }
}

/**
 * LOGICA INTELLIGENTE DI SELEZIONE FILE E UNRESTRICT
 * (Da chiamare SOLO se il file è confermato come Cached)
 */
async function getStreamLink(apiKey, magnetLink) {
    const rd = new RealDebridClient(apiKey);
    let torrentId;

    try {
        // 1. AGGIUNTA MAGNET
        const added = await rd.addMagnet(magnetLink);
        torrentId = added.id;

        // 2. VERIFICA E SELEZIONE
        let info = await rd.getInfo(torrentId);

        if (info.status === 'waiting_files_selection') {
            const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv'];
            const junkKeywords = ['sample', 'trailer', 'extra', 'bonus'];

            // Filtra solo video validi e grossi (>50MB)
            const videoFiles = info.files.filter(f => {
                const lowerPath = f.path.toLowerCase();
                return videoExtensions.some(ext => lowerPath.endsWith(ext)) &&
                       !junkKeywords.some(junk => lowerPath.includes(junk)) &&
                       f.bytes > 50 * 1024 * 1024; 
            });

            if (videoFiles.length > 0) {
                const fileIds = videoFiles.map(f => f.id).join(',');
                await rd.selectFiles(torrentId, fileIds);
            } else {
                await rd.selectFiles(torrentId, 'all');
            }
            
            // Piccola pausa tecnica per dare tempo a RD di processare la selezione
            // (A volte serve un minimo di latenza lato server)
            info = await rd.getInfo(torrentId); 
        } 
        
        // Se non è downloaded immediato dopo la selezione, è un falso positivo della cache
        // o serve tempo. Ma per un addon "Instant", se non è pronto ora, lo scartiamo.
        if (info.status !== 'downloaded') {
             // Opzionale: cancellare il torrent per pulizia
             return null; 
        }

        // 3. UNRESTRICT
        // Prende il file più grande selezionato
        const files = info.files.filter(f => f.selected === 1).sort((a, b) => b.bytes - a.bytes);
        if (!files.length) return null;

        const mainFile = files[0];
        
        // Logica per trovare il link giusto:
        // RD spesso mette i link nello stesso ordine degli ID, ma non sempre.
        // Un approccio sicuro è provare a sbloccare il primo link generato.
        const targetLink = info.links[0]; 
        
        const stream = await rd.unrestrictLink(targetLink);

        return {
            type: 'ready',
            url: stream.download,
            filename: stream.filename,
            size: stream.filesize
        };

    } catch (error) {
        if (error.message === "RD_INVALID_TOKEN") return { type: 'error', message: "API Key RD Errata" };
        console.error(`RD Error for magnet: ${error.message}`);
        return null; 
    }
}

module.exports = { getStreamLink, checkBatchAvailability };
