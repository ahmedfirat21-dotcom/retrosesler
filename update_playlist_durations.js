const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');
const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

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
                
                // Fallback: approxDurationMs
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    let updated = 0, unchanged = 0, failed = 0;
    
    console.log(`Starting duration update for ${playlist.length} songs...`);
    
    for (let i = 0; i < playlist.length; i++) {
        const s = playlist[i];
        if (!s.ytId) {
            console.log(`[${i+1}/${playlist.length}] ${s.artist} - ${s.title} : NO YT ID`);
            failed++;
            continue;
        }
        
        process.stdout.write(`[${i+1}/${playlist.length}] ${s.artist} - ${s.title} (${s.ytId}) ... `);
        
        const realDuration = await getYTDuration(s.ytId);
        if (realDuration && realDuration > 10) {
            if (s.duration !== realDuration) {
                console.log(`UPDATED: ${s.duration}s -> ${realDuration}s`);
                s.duration = realDuration;
                updated++;
            } else {
                console.log(`OK (${realDuration}s)`);
                unchanged++;
            }
        } else {
            console.log(`FAILED (realDuration: ${realDuration})`);
            failed++;
        }
        
        // Save every 10 updates so we don't lose progress if interrupted
        if ((updated + failed) % 10 === 0) {
            fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
        }
        
        await sleep(250); // Be gentle to YT
    }
    
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log(`\n=== DURATION UPDATE DONE ===`);
    console.log(`Updated: ${updated}, Unchanged: ${unchanged}, Failed: ${failed}`);
}

main().catch(console.error);
