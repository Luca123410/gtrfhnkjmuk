const axios = require("axios");
const cheerio = require("cheerio"); // <-- npm i cheerio

const API_URL = "https://apibay.org/q.php";
const BASE_1337X = "https://1337x.to"; // se ti dà Cloudflare cambia in https://1337x.st o https://1337x.is o https://1337x.gd (funzionano quasi sempre)

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.ds.is:6969/announce",
    "udp://retracker.lanta-net.ru:2710/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://ipv4.tracker.harry.lu:80/announce"
];

async function searchTPB(title, year) {
    try {
        const cleanTitle = title
            .replace(/[:"'’]/g, "")
            .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        let baseQuery = cleanTitle;
        if (year) baseQuery += ` ${year}`;

        const italianKeywords = [
            "ITA", "Italian", "Italiano", "sub ita", "sub-ita", "subs ita", "subforced",
            "AC3 ITA", "DTS ITA", "MULTI", "DUAL", "MD", "FORCED ITA", "iTA-GRX",
            "CiNEFiLE", "NovaRip", "MeM", "robbyrs", "iDN_CreW", "PsO"
        ];

        const queries = [
            baseQuery,
            ...italianKeywords.map(k => `${baseQuery} ${k}`)
        ].slice(0, 15); // max 15 query parallele, basta e avanza

        const requests = queries.map(q =>
            axios.get(API_URL, {
                params: { q, cat: 200 },
                timeout: 12000
            }).catch(() => ({ data: [] }))
        );

        const responses = await Promise.all(requests);

        const resultsMap = new Map();

        for (const res of responses) {
            const data = res.data;
            if (!Array.isArray(data) || data.length === 0 || data[0]?.name === "No results returned") continue;

            for (const item of data) {
                if (item.info_hash === "0000000000000000000000000000000000000000") continue;

                const name = item.name;
                const nameUpper = name.toUpperCase();

                const isItalian = /ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB.?ITA|FORCED|AC3.ITA|DTS.ITA|CiNEFiLE|NovaRip|MeM|robbyrs|iDN_CreW/i.test(nameUpper);
                if (!isItalian) continue;

                if (year) {
                    const y = parseInt(year);
                    if (![y - 1, y, y + 1].some(ay => name.includes(ay))) continue;
                }

                const hash = item.info_hash.toUpperCase();
                const seeders = parseInt(item.seeders || "0");

                const sizeBytes = parseInt(item.size);
                let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`;
                TRACKERS.forEach(tr => magnet += `&tr=${encodeURIComponent(tr)}`);

                if (resultsMap.has(hash)) {
                    if (seeders > resultsMap.get(hash).seeders) {
                        resultsMap.get(hash).seeders = seeders;
                        resultsMap.get(hash).magnet = magnet;
                    }
                    continue;
                }

                resultsMap.set(hash, {
                    title: name,
                    magnet,
                    size: (sizeBytes / 1073741824).toFixed(2) + " GB",
                    sizeBytes,
                    seeders,
                    source: "TPB"
                });
            }
        }

        return Array.from(resultsMap.values());

    } catch (error) {
        console.error("Errore TPB:", error.message);
        return [];
    }
}

async function search1337x(title, year) {
    const cleanTitle = title
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    let baseQuery = cleanTitle;
    if (year) baseQuery += ` ${year}`;

    const italianKeywords = [
        "ITA", "Italian", "Italiano", "sub ita", "sub-ita", "subs ita", "subforced",
        "AC3 ITA", "DTS ITA", "MULTI", "DUAL", "MD", "FORCED ITA",
        "CiNEFiLE", "NovaRip", "MeM", "robbyrs", "iDN_CreW", "PsO", "BadAss"
    ];

    const queries = [
        baseQuery,
        ...italianKeywords.map(k => `${baseQuery} ${k}`)
    ];

    const candidatesMap = new Map(); // key = torrentPath

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    };

    for (const q of queries) {
        try {
            const url = `${BASE_1337X}/category-search/${encodeURIComponent(q)}/Movies/1/`;
            const { data } = await axios.get(url, { timeout: 15000, headers }).catch(() => ({ data: "" }));
            if (!data) continue;

            const $ = cheerio.load(data);
            const rows = $("table.table-list tbody tr");

            if (rows.length === 0) continue;

            rows.each((i, row) => {
                const tds = $(row).find("td");
                const nameLink = tds.eq(0).find("a").eq(1);
                if (!nameLink.length) return;

                const name = nameLink.text().trim();
                const torrentPath = nameLink.attr("href");
                if (!torrentPath || !torrentPath.startsWith("/torrent/")) return;

                const seeders = parseInt(tds.eq(1).text().replace(/,/g, ""), 10) || 0;

                const sizeText = tds.eq(4).text().replace(/,/g, "").trim();
                const sizeMatch = sizeText.match(/([\d.]+)\s*(GiB|MiB|GB|MB)/i);
                let sizeBytes = 0;
                if (sizeMatch) {
                    const num = parseFloat(sizeMatch[1]);
                    const unit = sizeMatch[2].toUpperCase();
                    sizeBytes = unit.includes("G") ? num * 1073741824 : num * 1048576;
                }

                const nameUpper = name.toUpperCase();
                const isItalian = /ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB.?ITA|FORCED|AC3.ITA|DTS.ITA|CiNEFiLE|NovaRip|MeM|robbyrs|iDN_CreW/i.test(nameUpper);
                if (!isItalian) return;

                if (year) {
                    const y = parseInt(year);
                    if (![y - 1, y, y + 1].some(ay => name.includes(ay))) return;
                }

                if (candidatesMap.has(torrentPath)) {
                    if (seeders > candidatesMap.get(torrentPath).seeders) {
                        candidatesMap.get(torrentPath).seeders = seeders;
                    }
                    return;
                }

                candidatesMap.set(torrentPath, {
                    name,
                    torrentUrl: `${BASE_1337X}${torrentPath}`,
                    seeders,
                    sizeBytes
                });
            });
        } catch (e) { /* silent */ }
    }

    // Prendi i migliori (max 60 richieste magnet, più che sufficienti)
    const candidates = Array.from(candidatesMap.values())
        .sort((a, b) => b.seeders - a.seeders)
        .slice(0, 60);

    const magnetPromises = candidates.map(async (cand) => {
        try {
            const { data } = await axios.get(cand.torrentUrl, { timeout: 10000, headers });
            const $ = cheerio.load(data);
            const magnet = $("a[href^=\"magnet:?\"]").first().attr("href");
            if (!magnet) return null;

            const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
            if (!hashMatch) return null;

            const hash = hashMatch[1].toUpperCase();
            let fullMagnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(cand.name)}`;
            TRACKERS.forEach(tr => fullMagnet += `&tr=${encodeURIComponent(tr)}`);

            return {
                title: cand.name,
                magnet: fullMagnet,
                size: (cand.sizeBytes / 1073741824).toFixed(2) + " GB",
                sizeBytes: cand.sizeBytes,
                seeders: cand.seeders,
                source: "1337x"
            };
        } catch (e) {
            return null;
        }
    });

    const results = (await Promise.all(magnetPromises)).filter(Boolean);
    return results;
}

async function searchMagnet(title, year) {
    console.log(`\n--- [ULTIMATE ITA SEARCH: TPB + 1337x] ${title} ${year || ""} ---`);

    const [tpbResults, xResults] = await Promise.all([
        searchTPB(title, year),
        search1337x(title, year)
    ]);

    console.log(`TPB: ${tpbResults.length} risultati`);
    console.log(`1337x: ${xResults.length} risultati`);

    const finalMap = new Map();

    const add = (r) => {
        const hashMatch = r.magnet.match(/btih:([A-F0-9]{40})/i);
        if (!hashMatch) return;
        
        const hash = hashMatch[1];
        const key = hash.toUpperCase();
        if (finalMap.has(key)) {
            const ex = finalMap.get(key);
            if (r.seeders > ex.seeders) {
                ex.seeders = r.seeders;
                ex.source = "TPB+1337x";
            }
        } else {
            finalMap.set(key, r);
        }
    };

    tpbResults.forEach(add);
    xResults.forEach(add);

    const finalResults = Array.from(finalMap.values())
        .sort((a, b) => b.seeders - a.seeders || b.sizeBytes - a.sizeBytes)
        .slice(0, 6); // ⭐ LIMITATO AI PRIMI 5 RISULTATI

    console.log(`TOTALE UNICI con seeders massimi: ${finalResults.length} (limitato a 5)`);

    return finalResults;
}

module.exports = { searchMagnet };
