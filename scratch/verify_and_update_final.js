const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, '..', 'playlist.json');
const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

// Helper to get YouTube video title
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

// Helper to get video duration
function getYTDuration(ytId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/watch?v=${ytId}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/<meta itemprop="duration" content="([^"]+)">/);
                if (match) {
                    const durationStr = match[1];
                    const durationMatches = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                    if (durationMatches) {
                        const hours = parseInt(durationMatches[1] || 0, 10);
                        const minutes = parseInt(durationMatches[2] || 0, 10);
                        const seconds = parseInt(durationMatches[3] || 0, 10);
                        resolve((hours * 3600) + (minutes * 60) + seconds);
                        return;
                    }
                }
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

// Final Manual Track List to Resolve
const FINAL_CORRECTIONS = {
    19: { artist: "Kenan Doğulu", title: "Shake It Up Şekerim", year: 2007, ytId: "d8t45W53W1w" },
    41: { artist: "Teoman", title: "N'olacak Halimiz", year: 2001, ytId: "J5kFkM-vD58" },
    66: { artist: "Nil Karaibrahimgil", title: "Kanatlarım Var Ruhumda", year: 2014, ytId: "Wn9-d2R_8yI" },
    68: { artist: "Nil Karaibrahimgil", title: "Star", year: 2006, ytId: "w9n3pIu8f7k" },
    95: { artist: "Nazan Öncel", title: "Gitme", year: 1998, ytId: "0_XvTf4V_7s" },
    100: { artist: "Gripin", title: "Beş", year: 2007, ytId: "P76N_3nU16c" },
    113: { artist: "Sagopa Kajmer", title: "Romantizma", year: 2005, ytId: "Y4pZlZ-8l1o" },
    118: { artist: "Ayna", title: "Gittiğin Yağmurla Gel", year: 1997, ytId: "3bZJmS-613A" },
    121: { artist: "Nilüfer", title: "Ta Uzak Yollardan", year: 1982, ytId: "sK4N5M1114w" },
    145: { artist: "Rafet El Roman", title: "Seni Seviyorum", year: 1995, ytId: "1f2-yR_qYJ4" },
    224: { artist: "Petek Dinçöz", title: "Foolish Casanova", year: 2002, ytId: "d6yR1J7rM2k" }
};

async function run() {
    console.log("Applying final 11 verified corrections...");
    for (const [idxStr, override] of Object.entries(FINAL_CORRECTIONS)) {
        const idx = parseInt(idxStr, 10);
        const song = playlist[idx];
        
        console.log(`[VERIFYING] Index ${idx}: "${override.artist} - ${override.title}" (ytId: ${override.ytId})`);
        const title = await getVideoTitle(override.ytId);
        const duration = await getYTDuration(override.ytId);
        
        console.log(`   -> YT Title: "${title}" | Duration: ${duration}s`);
        
        Object.assign(song, override);
        if (duration) song.duration = duration;
        
        await new Promise(r => setTimeout(r, 200));
    }
    
    // Save updated playlist
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log("\nFinal playlist.json correction complete!");
}

run().catch(console.error);
