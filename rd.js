const axios = require("axios");

const RD_TIMEOUT = 60000; 

async function rdRequest(method, url, token, data = null) {
    try {
        const config = {
            method,
            url,
            headers: { Authorization: `Bearer ${token}` },
            timeout: RD_TIMEOUT
        };
        if (data) config.data = data;
        const response = await axios(config);
        return response.data;
    } catch (error) {
        if (method === 'POST' && url.includes('addMagnet') && error.response?.status === 400) return null;
        throw error;
    }
}

const RD = {
    // --- NUOVA FUNZIONE PER VELOCITÀ ---
    checkInstantAvailability: async (token, hashes) => {
        try {
            // RD API vuole gli hash uniti da /
            const hashString = hashes.join('/');
            const url = `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashString}`;
            const data = await rdRequest('GET', url, token);
            return data || {};
        } catch (e) {
            console.log("⚠️ Instant Check Error:", e.message);
            return {};
        }
    },

    getStreamLink: async (token, magnet) => {
        try {
            const addUrl = "https://api.real-debrid.com/rest/1.0/torrents/addMagnet";
            const body = new URLSearchParams();
            body.append("magnet", magnet);
            
            const addRes = await rdRequest('POST', addUrl, token, body);
            if (!addRes || !addRes.id) throw new Error("Add Failed");
            const torrentId = addRes.id;

            let info = await rdRequest('GET', `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, token);
            
            if (info.status === 'waiting_files_selection') {
                const selUrl = `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`;
                const selBody = new URLSearchParams();
                selBody.append("files", "all");
                await rdRequest('POST', selUrl, token, selBody);
                info = await rdRequest('GET', `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, token);
            }

            if (info.status === 'downloaded' && info.links && info.links.length > 0) {
                // Prende il file più grande
                const videoFiles = info.files.filter(f => f.selected && f.bytes > 10 * 1024 * 1024);
                // Logica semplice: prendiamo il primo link sbloccabile
                const linkToUnrestrict = info.links[0]; 

                const unrestrictUrl = "https://api.real-debrid.com/rest/1.0/unrestrict/link";
                const unResBody = new URLSearchParams();
                unResBody.append("link", linkToUnrestrict);
                
                const unrestrictRes = await rdRequest('POST', unrestrictUrl, token, unResBody);

                return {
                    type: 'ready',
                    url: unrestrictRes.download,
                    filename: unrestrictRes.filename,
                    size: unrestrictRes.filesize
                };
            }
            return null;
        } catch (e) { throw e; }
    }
};

module.exports = RD;
