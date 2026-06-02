const https = require('https');

function getYTDuration(ytId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/watch?v=${ytId}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // Try schema.org meta tag: <meta itemprop="duration" content="PT3M12S">
                const match = data.match(/<meta itemprop="duration" content="([^"]+)">/);
                if (match) {
                    const durationStr = match[1]; // e.g. "PT3M12S"
                    // Parse ISO 8601 duration
                    const durationMatches = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                    if (durationMatches) {
                        const hours = parseInt(durationMatches[1] || 0, 10);
                        const minutes = parseInt(durationMatches[2] || 0, 10);
                        const seconds = parseInt(durationMatches[3] || 0, 10);
                        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
                        resolve(totalSeconds);
                        return;
                    }
                }
                
                // Try fallback: "approxDurationMs":"..."
                const matchMs = data.match(/"approxDurationMs":"(\d+)"/);
                if (matchMs) {
                    resolve(Math.round(parseInt(matchMs[1], 10) / 1000));
                    return;
                }
                
                resolve(null);
            });
        }).on('error', () => resolve(null));
    });
}

async function test() {
    const id = '4TWR90KJl84'; // Tarkan - Şımarık
    console.log(`Fetching duration for ${id}...`);
    const duration = await getYTDuration(id);
    console.log(`Duration: ${duration} seconds`);
}

test();
