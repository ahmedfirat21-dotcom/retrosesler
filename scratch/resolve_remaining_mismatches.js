const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, '..', 'playlist.json');
const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

// Helper to search YouTube
function searchYT(query) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                resolve(match ? match[1] : null);
            });
        }).on('error', () => resolve(null));
    });
}

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

// Final Custom Overrides
const REMAINING_OVERRIDES = {
    22: { artist: "Serdar Ortaç", title: "Mesafe", year: 2006 },
    42: { artist: "Athena", title: "Öpücük", year: 2002 },
    44: { artist: "Athena", title: "Yalan", year: 2004 },
    102: { artist: "Feridun Düzağaç", title: "Alev Alev", year: 2003 },
    120: { artist: "Nilüfer", title: "Caddelerde Rüzgar", year: 1990 }
};

// All remaining indexes that need YouTube video search and replacement
const REMAINING_SEARCH_INDEXES = [
    22, 42, 44, 102, 120, // the ones we just overrode
    19, 41, 68, 95, 113, 118, 121, // mismatches
    66, 100, 145, 224 // deleted/private videos
];

async function run() {
    console.log("Starting remaining playlist corrections...");
    
    // Apply final overrides
    for (const [idxStr, override] of Object.entries(REMAINING_OVERRIDES)) {
        const idx = parseInt(idxStr, 10);
        const song = playlist[idx];
        console.log(`[OVERRIDE] Index ${idx}: "${song.artist} - ${song.title}" -> "${override.artist} - ${override.title}"`);
        Object.assign(song, override);
    }
    
    // Search and update video IDs
    for (const idx of REMAINING_SEARCH_INDEXES) {
        const song = playlist[idx];
        const query = `${song.artist} - ${song.title}`;
        console.log(`[SEARCH] Index ${idx}: Searching YouTube for "${query}" (current ID: ${song.ytId})...`);
        const newYtId = await searchYT(query);
        if (newYtId) {
            const title = await getVideoTitle(newYtId);
            const duration = await getYTDuration(newYtId);
            song.ytId = newYtId;
            if (duration) song.duration = duration;
            console.log(`   -> UPDATED to new ID: ${newYtId} ("${title}", duration: ${duration}s)`);
        } else {
            console.log(`   -> Search failed for query: "${query}"`);
        }
        await new Promise(r => setTimeout(r, 300)); // rate limit protection
    }
    
    // Save updated playlist
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log("\nSuccessfully updated playlist.json!");
}

run().catch(console.error);
