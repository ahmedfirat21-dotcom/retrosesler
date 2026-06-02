#!/usr/bin/env node
// Fix playlist.json — replace fake/dead YouTube IDs with real ones
const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, 'playlist.json');
const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

function searchYT(query) {
    return new Promise((resolve, reject) => {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // Find first videoId in the page
                const match = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
                resolve(match ? match[1] : null);
            });
        }).on('error', reject);
    });
}

function checkYT(ytId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
        https.get(url, (res) => {
            resolve(res.statusCode === 200);
        }).on('error', () => resolve(false));
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    let fixed = 0, ok = 0, failed = 0;
    
    for (let i = 0; i < playlist.length; i++) {
        const s = playlist[i];
        process.stdout.write(`[${i+1}/${playlist.length}] ${s.artist} - ${s.title} ... `);
        
        // First check if current ID is valid
        const isOk = await checkYT(s.ytId);
        if (isOk) {
            console.log(`OK (existing: ${s.ytId})`);
            ok++;
            continue;
        }
        
        // Search for real YouTube ID
        const query = `${s.artist} ${s.title} official`;
        const newId = await searchYT(query);
        
        if (newId) {
            // Verify the found ID
            const verified = await checkYT(newId);
            if (verified) {
                s.ytId = newId;
                console.log(`FIXED -> ${newId}`);
                fixed++;
            } else {
                // Try without "official"
                const newId2 = await searchYT(`${s.artist} ${s.title}`);
                if (newId2 && newId2 !== newId) {
                    s.ytId = newId2;
                    console.log(`FIXED (alt) -> ${newId2}`);
                    fixed++;
                } else {
                    console.log(`FAILED (no valid result)`);
                    failed++;
                }
            }
        } else {
            console.log(`FAILED (no results)`);
            failed++;
        }
        
        // Rate limit - 200ms between requests
        await sleep(200);
    }
    
    console.log(`\n=== DONE ===`);
    console.log(`OK: ${ok}, Fixed: ${fixed}, Failed: ${failed}`);
    
    // Save fixed playlist
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log(`Saved to ${PLAYLIST_FILE}`);
}

main().catch(console.error);
