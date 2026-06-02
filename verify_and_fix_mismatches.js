const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');
const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

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

// Simple normalization helper for Turkish characters and spaces
function normalize(str) {
    return (str || '')
        .toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/[^a-z0-9]/g, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    let mismatched = 0;
    console.log(`Verifying ${playlist.length} tracks...`);

    for (let i = 0; i < playlist.length; i++) {
        const s = playlist[i];
        if (!s.ytId) continue;

        const ytTitle = await getVideoTitle(s.ytId);
        
        const cleanYtTitle = normalize(ytTitle);
        const cleanArtist = normalize(s.artist);
        const cleanTitle = normalize(s.title);

        const artistMatch = cleanYtTitle.includes(cleanArtist);
        const titleMatch = cleanYtTitle.includes(cleanTitle);

        if (!ytTitle || (!artistMatch && !titleMatch)) {
            console.log(`[MISMATCH] ${s.artist} - ${s.title} (ytId: ${s.ytId}) -> Youtube Title: "${ytTitle}"`);
            mismatched++;
            
            // Search correct one
            const query = `${s.artist} ${s.title}`;
            const newId = await searchYT(query);
            if (newId && newId !== s.ytId) {
                const newTitle = await getVideoTitle(newId);
                const duration = await getYTDuration(newId);
                
                s.ytId = newId;
                if (duration) s.duration = duration;
                console.log(`   -> FIXED to newId: ${newId} ("${newTitle}", duration: ${duration}s)`);
            } else {
                console.log(`   -> FAILED to find correct match`);
            }
        }

        if ((i + 1) % 10 === 0) {
            fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
        }
        await sleep(250);
    }
    
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log(`\n=== DONE ===`);
    console.log(`Total mismatched: ${mismatched}`);
}

main().catch(console.error);
