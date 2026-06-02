const path = require('path');
const fs = require('fs');

// Mock shared services
const radioModule = require('../routes/radio');
const getRadioNowPlaying = radioModule.getRadioNowPlaying;

const playlistPath = path.join(__dirname, '..', 'playlist.json');
const RADIO_PLAYLIST = JSON.parse(fs.readFileSync(playlistPath, 'utf8'));

function isYtDead(ytId) { return false; }
function liveTracks() {
    return RADIO_PLAYLIST.filter(t => !isYtDead(t.ytId));
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

async function resolveSongRequest(artist, title) {
    const tracks = liveTracks();
    let found = tracks.find(t => 
        t.artist.toLowerCase() === artist.toLowerCase() &&
        t.title.toLowerCase() === title.toLowerCase()
    );
    if (found) {
        return { ...found, source: 'playlist' };
    }

    found = tracks.find(t => 
        t.artist.toLowerCase().includes(artist.toLowerCase()) &&
        t.title.toLowerCase().includes(title.toLowerCase())
    ) || tracks.find(t =>
        t.artist.toLowerCase().includes(artist.toLowerCase())
    );
    if (found) {
        return { ...found, source: 'playlist_fuzzy' };
    }
    return null;
}

async function run() {
    const res = await resolveSongRequest("İbrahim Tatlıses", "Ayağında Kundura");
    console.log("Resolved result:", res);
}

run().catch(console.error);
