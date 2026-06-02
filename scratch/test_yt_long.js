const https = require('https');

function searchYT(query) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
                const ids = [];
                let match;
                while ((match = regex.exec(data)) !== null) {
                    if (!ids.includes(match[1])) ids.push(match[1]);
                }
                resolve(ids.slice(0, 10));
            });
        }).on('error', () => resolve([]));
    });
}

function getVideoTitle(ytId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.title || null);
                } catch {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

async function run() {
    const ids = await searchYT("Athena - Fırtına");
    console.log("Top 10 search result video IDs for 'Athena - Fırtına':", ids);
    for (const id of ids) {
        const title = await getVideoTitle(id);
        console.log(`- ${id}: "${title}"`);
    }
}

run().catch(console.error);
