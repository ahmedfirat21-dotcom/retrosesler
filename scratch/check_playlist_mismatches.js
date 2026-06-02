const fs = require('fs');
const https = require('https');
const path = require('path');

const PLAYLIST_FILE = path.join(__dirname, '..', 'playlist.json');
if (!fs.existsSync(PLAYLIST_FILE)) {
    console.error('playlist.json not found!');
    process.exit(1);
}

const playlist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));

function getVideoTitle(ytId) {
    return new Promise((resolve) => {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
        const req = https.get(url, (res) => {
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
        });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

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

async function run() {
    console.log(`Checking ${playlist.length} tracks for mismatches...`);
    const results = [];
    
    // Process in batches of 10 to avoid rate limits
    const batchSize = 15;
    for (let i = 0; i < playlist.length; i += batchSize) {
        const batch = playlist.slice(i, i + batchSize);
        const promises = batch.map(async (song, idx) => {
            const globalIdx = i + idx;
            if (!song.ytId) return;
            const ytTitle = await getVideoTitle(song.ytId);
            if (!ytTitle) {
                results.push({ index: globalIdx, song, error: 'Could not fetch YouTube title (private/deleted/timeout)' });
                return;
            }
            
            const cleanYt = normalize(ytTitle);
            const cleanArtist = normalize(song.artist);
            const cleanTitle = normalize(song.title);
            
            const artistMatch = cleanYt.includes(cleanArtist);
            const titleMatch = cleanYt.includes(cleanTitle);
            
            if (!artistMatch || !titleMatch) {
                results.push({
                    index: globalIdx,
                    song,
                    ytTitle,
                    mismatch: {
                        artist: !artistMatch,
                        title: !titleMatch
                    }
                });
            }
        });
        
        await Promise.all(promises);
        console.log(`Progress: ${Math.min(i + batchSize, playlist.length)}/${playlist.length}...`);
        await new Promise(r => setTimeout(r, 200));
    }
    
    console.log('\n=== MISMATCH ANALYSIS RESULTS ===');
    console.log(`Found ${results.length} discrepancies:`);
    console.log(JSON.stringify(results, null, 2));
    
    fs.writeFileSync(path.join(__dirname, 'mismatch_results.json'), JSON.stringify(results, null, 2), 'utf8');
}

run().catch(console.error);
