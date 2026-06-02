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

// Hardcoded Case B Corrections (Where video is correct but metadata was shifted/wrong)
const CASE_B_CORRECTIONS = {
    29: { artist: "Ebru Yaşar", year: 2006 },
    45: { artist: "Günay Aksoy", year: 2020 },
    53: { title: "Yakışıklım", year: 2013 },
    82: { artist: "Rafet El Roman", year: 2002 },
    95: { title: "Gitme", year: 1998 },
    105: { artist: "Aslı Güngör", year: 2008 },
    108: { artist: "Özcan Deniz", year: 2004 },
    116: { artist: "Uzi", year: 2022 },
    117: { artist: "Bulutsuzluk Özlemi", year: 2001 },
    123: { artist: "Şenay", year: 1972 },
    122: { title: "Ben Seni Unutmak İçin Sevmedim" },
    139: { artist: "Tarkan", year: 2005 },
    140: { title: "Gönül Sayfam", year: 2001 },
    143: { title: "Zorun Ne Benle Aşk" },
    160: { artist: "Oğuzhan Koç", year: 2017 },
    153: { artist: "Özcan Deniz & Fahriye Evcen", year: 2015 },
    164: { artist: "Gökhan Türkmen", year: 2012 },
    155: { title: "Birtanem" },
    161: { title: "Unut Beni" },
    152: { title: "Sen Giderken" },
    156: { artist: "Kolpa & Deniz Baysal", year: 2016 },
    166: { title: "Aman Ayrılık" },
    170: { title: "Bir Ben Bir Allah Biliyor (ft. Tarkan)", year: 2012 },
    168: { artist: "Soner Arıca", year: 2001 },
    172: { artist: "Sezen Aksu", year: 2002 },
    171: { title: "Bize Yeter", year: 2010 },
    167: { title: "Yitirmeden", year: 2008 },
    174: { artist: "Gülben Ergen & Oğuzhan Koç", year: 2009 },
    165: { title: "Garibim Fukarayım" },
    178: { title: "Medcezir", year: 1993 },
    189: { artist: "Azer Bülbül", year: 2001 },
    193: { title: "Lanet Olsun" },
    192: { artist: "Gökhan Özen", year: 2008 },
    191: { title: "Aşkımız Olay Olacak", year: 2000 },
    184: { title: "Teker Teker" },
    188: { title: "Seviyoraaa" },
    199: { title: "Beni Unutma" },
    205: { title: "Gönlüm Yeşerdi", year: 1999 },
    208: { artist: "Ajda Pekkan", year: 1998 },
    218: { title: "Araba", year: 1996 },
    222: { title: "Korkma Kalbim", year: 2007 },
    211: { title: "Kıyamam Sana", year: 1992 },
    223: { title: "Yak Gel", year: 2009 },
    221: { artist: "Gökhan Tepe", year: 2006 },
    227: { title: "Paranoya", year: 2020 }
};

// Custom Overrides (Where lyrics site typos created completely non-existent tracks)
const CUSTOM_OVERRIDES = {
    185: { artist: "Nev", title: "Mühürlü Kaderim", year: 2004 },
    203: { artist: "Baha", title: "Kutupta Yaz Gibi", year: 1999 },
    206: { artist: "Mirkelam", title: "Tavla", year: 1995 },
    228: { artist: "Athena", title: "Serseri Mayın", year: 2002 }
};

// Case A (Where video ID is wrong, we need to search YouTube for correct one)
const CASE_A_INDEXES = new Set([
    19, 22, 41, 42, 44, 68, 95, 102, 113, 118, 121, 120,
    66, 100, 145, 224 // deleted/private video cases
]);

async function run() {
    console.log("Starting playlist corrections...");
    
    // 1. Apply Custom Overrides
    for (const [idxStr, override] of Object.entries(CUSTOM_OVERRIDES)) {
        const idx = parseInt(idxStr, 10);
        const song = playlist[idx];
        console.log(`[CUSTOM OVERRIDE] Index ${idx}: "${song.artist} - ${song.title}" -> "${override.artist} - ${override.title}"`);
        Object.assign(song, override);
        
        // Search correct video ID
        const query = `${override.artist} - ${override.title}`;
        const newYtId = await searchYT(query);
        if (newYtId) {
            song.ytId = newYtId;
            const duration = await getYTDuration(newYtId);
            if (duration) song.duration = duration;
            console.log(`   -> Found video ID: ${newYtId} (duration: ${duration}s)`);
        } else {
            console.log(`   -> Failed to find video ID for query: ${query}`);
        }
    }
    
    // 2. Apply Case B Corrections (Metadata fixes)
    for (const [idxStr, correction] of Object.entries(CASE_B_CORRECTIONS)) {
        const idx = parseInt(idxStr, 10);
        const song = playlist[idx];
        console.log(`[CASE B CORRECTION] Index ${idx}: "${song.artist} - ${song.title}" -> "${correction.artist || song.artist} - ${correction.title || song.title}"`);
        Object.assign(song, correction);
    }
    
    // 3. Search and Fix Case A Entries (Video ID search and replacement)
    for (const idx of CASE_A_INDEXES) {
        const song = playlist[idx];
        const query = `${song.artist} - ${song.title}`;
        console.log(`[CASE A SEARCH] Index ${idx}: Searching YouTube for "${query}" (current ytId: ${song.ytId})...`);
        const newYtId = await searchYT(query);
        if (newYtId && newYtId !== song.ytId) {
            const ytTitle = await getVideoTitle(newYtId);
            const duration = await getYTDuration(newYtId);
            song.ytId = newYtId;
            if (duration) song.duration = duration;
            console.log(`   -> UPDATED to video ID: ${newYtId} ("${ytTitle}", duration: ${duration}s)`);
        } else {
            console.log(`   -> Already has correct ID or search failed.`);
        }
        await new Promise(r => setTimeout(r, 250)); // rate limiting
    }
    
    // Save updated playlist
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(playlist, null, 4), 'utf8');
    console.log("\nSaved updated playlist.json!");
}

run().catch(console.error);
