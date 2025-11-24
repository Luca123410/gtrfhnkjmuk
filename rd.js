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
            }
            throw error;
        }
    }

    async addMagnet(magnet) { return this.request('POST', '/torrents/addMagnet', { magnet }); }
    async selectFiles(torrentId, files = 'all') { return this.request('POST', `/torrents/selectFiles/${torrentId}`, { files }); }
    async getInfo(torrentId) { return this.request('GET', `/torrents/info/${torrentId}`); }
    async unrestrictLink(link) { return this.request('POST', '/unrestrict/link', { link }); }
}

/**
 * LOGICA INTELLIGENTE DI SELEZIONE FILE
 */
async function getStreamLink(apiKey, magnetLink) {
    const rd = new RealDebridClient(apiKey);
    let torrentId;

    try {
        // 1. AGGIUNTA MAGNET
        const added = await rd.addMagnet(magnetLink);
        torrentId = added.id;

        // 2. VERIFICA INIZIALE
        let info = await rd.getInfo(torrentId);

        // 3. GESTIONE SELEZIONE FILE (Logica "Pro" rubata dallo script avanzato)
        if (info.status === 'waiting_files_selection') {
            const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv'];
            const junkKeywords = ['sample', 'trailer', 'extra', 'bonus'];

            // Filtra solo i file video validi e non "junk"
            const videoFiles = info.files.filter(f => {
                const lowerPath = f.path.toLowerCase();
                return videoExtensions.some(ext => lowerPath.endsWith(ext)) &&
                       !junkKeywords.some(junk => lowerPath.includes(junk)) &&
                       f.bytes > 50 * 1024 * 1024; // > 50MB
            });

            if (videoFiles.length > 0) {
                // Seleziona TUTTI i file video (utile per le serie pack)
                const fileIds = videoFiles.map(f => f.id).join(',');
                await rd.selectFiles(torrentId, fileIds);
            } else {
                // Fallback: Seleziona tutto se non riconosce video
                await rd.selectFiles(torrentId, 'all');
            }
            
            // Rileggi info dopo selezione
            info = await rd.getInfo(torrentId);
        } else if (info.status === 'magnet_conversion') {
            // Se sta ancora convertendo, proviamo a forzare la selezione 'all' per velocizzare
            try { await rd.selectFiles(torrentId, 'all'); } catch(e) {}
        }

        // 4. CONTROLLO FINALE E UNRESTRICT
        if (info.status === 'downloaded') {
            // Ordina i file per dimensione (il più grande è il film/episodio principale)
            const files = info.files.filter(f => f.selected === 1).sort((a, b) => b.bytes - a.bytes);
            const mainFile = files[0];

            // Trova il link corrispondente
            // RD non mappa 1:1 file e link, ma di solito l'ordine è preservato.
            // Fallback sicuro: sblocca il primo link disponibile
            let targetLink = info.links[0];
            
            const stream = await rd.unrestrictLink(targetLink);

            return {
                type: 'ready',
                url: stream.download,
                filename: stream.filename,
                size: stream.filesize
            };
        } 
        else {
            return { 
                type: 'downloading', 
                progress: parseFloat(info.progress || 0) 
            };
        }

    } catch (error) {
        if (error.message === "RD_INVALID_TOKEN") return { type: 'error', message: "API Key RD Errata" };
        return null; 
    }
}

module.exports = { getStreamLink };
