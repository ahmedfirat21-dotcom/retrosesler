const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const jwt = require('jsonwebtoken');
const db = require('../services/db');
const {
    requireAuth,
    requireRole,
    pushActivity,
    JWT_SECRET
} = require('../services/shared');
const aiService = require('../services/ai');

// ============ PLAYLIST AND INITIALIZATION ============
let RADIO_PLAYLIST = [];
const DEAD_YT_THRESHOLD = 3;
const DEAD_YT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEAD_YT_IDS = new Map();
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEAD_YT_FILE = path.join(DATA_DIR, 'dead_yt_ids.json');

try {
    if (fs.existsSync(DEAD_YT_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DEAD_YT_FILE, 'utf8'));
        if (Array.isArray(raw)) {
            raw.forEach(item => {
                if (typeof item === 'string') {
                    DEAD_YT_IDS.set(item, { reporters: new Set(), lastFailTs: Date.now() });
                } else if (item && typeof item.ytId === 'string') {
                    const reporters = new Set(Array.isArray(item.reporters) ? item.reporters : []);
                    DEAD_YT_IDS.set(item.ytId, { reporters, lastFailTs: item.lastFailTs || Date.now() });
                }
            });
        }
        const blocked = [...DEAD_YT_IDS.values()].filter(v => v.reporters.size >= DEAD_YT_THRESHOLD).length;
        console.log(`[DJ] ${DEAD_YT_IDS.size} dead-yt kayıt yüklendi (${blocked} BLOCKED, eşik: ${DEAD_YT_THRESHOLD} farklı kullanıcı)`);
    }
} catch (e) { console.error('[DJ] dead-yt load hatası:', e.message); }

async function saveDeadYtIds() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const arr = [...DEAD_YT_IDS.entries()].map(([ytId, v]) => ({
            ytId,
            reporters: [...v.reporters],
            lastFailTs: v.lastFailTs,
        }));
        // Use a simple atomic write helper if possible, or just fs.writeFileSync
        const tempPath = DEAD_YT_FILE + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(arr, null, 2), 'utf8');
        fs.renameSync(tempPath, DEAD_YT_FILE);
    } catch (e) { console.error('[DJ] dead-yt save hatası:', e.message); }
}

// TTL cleanup for dead YT IDs
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [ytId, v] of DEAD_YT_IDS.entries()) {
        if (now - (v.lastFailTs || 0) > DEAD_YT_TTL_MS) {
            DEAD_YT_IDS.delete(ytId);
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`[DJ] TTL temizlik: ${removed} eski ölü ID silindi (${DEAD_YT_IDS.size} kaldı)`);
        saveDeadYtIds();
    }
}, 60 * 60 * 1000);

function isYtDead(ytId) {
    const v = DEAD_YT_IDS.get(ytId);
    return !!v && v.reporters.size >= DEAD_YT_THRESHOLD;
}

try {
    const playlistPath = path.join(__dirname, '..', 'playlist.json');
    RADIO_PLAYLIST = JSON.parse(fs.readFileSync(playlistPath, 'utf8'));
    for (let i = RADIO_PLAYLIST.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [RADIO_PLAYLIST[i], RADIO_PLAYLIST[j]] = [RADIO_PLAYLIST[j], RADIO_PLAYLIST[i]];
    }
    console.log(`[DJ] ${RADIO_PLAYLIST.length} şarkı yüklendi (playlist.json)`);
} catch (e) {
    console.error('[DJ] playlist.json yüklenemedi:', e.message);
    RADIO_PLAYLIST = [{ artist: 'DJ_RetroBot', title: 'Test Yayını', year: 2024, duration: 180, ytId: 'dQw4w9WgXcQ' }];
}

function liveTracks() {
    return RADIO_PLAYLIST.filter(t => !isYtDead(t.ytId));
}

// Stateful radio control variables
let CURRENT_RADIO_SONG = null;
let CURRENT_RADIO_START_TIME = Date.now();
let CURRENT_RADIO_INDEX = 0;

function initRadio() {
    const tracks = liveTracks();
    if (tracks.length > 0) {
        CURRENT_RADIO_INDEX = Math.floor(Math.random() * tracks.length);
        CURRENT_RADIO_SONG = tracks[CURRENT_RADIO_INDEX];
    } else {
        CURRENT_RADIO_SONG = { artist: 'DJ_RetroBot', title: 'Test Yayını', year: 2024, duration: 180, ytId: 'dQw4w9WgXcQ' };
        CURRENT_RADIO_INDEX = 0;
    }
    CURRENT_RADIO_START_TIME = Date.now();
}

function updateRadioState() {
    if (!CURRENT_RADIO_SONG) {
        initRadio();
        return;
    }

    const now = Date.now();
    const tracks = liveTracks();
    if (tracks.length === 0) return;

    const totalDuration = tracks.reduce((sum, s) => sum + (s.duration || 180), 0);
    let diff = now - CURRENT_RADIO_START_TIME;
    if (diff > totalDuration * 1000) {
        diff = diff % (totalDuration * 1000);
        CURRENT_RADIO_START_TIME = now - diff;
    }

    let elapsed = Math.floor((now - CURRENT_RADIO_START_TIME) / 1000);
    let dur = CURRENT_RADIO_SONG.duration || 180;

    let loopSafety = 0;
    while (elapsed >= dur && loopSafety < 1000) {
        loopSafety++;
        CURRENT_RADIO_START_TIME += dur * 1000;
        elapsed = Math.floor((Date.now() - CURRENT_RADIO_START_TIME) / 1000);

        if (SONG_REQUESTS.length > 0) {
            const nextReq = SONG_REQUESTS.shift();
            saveSongRequests();
            CURRENT_RADIO_SONG = {
                artist: nextReq.artist,
                title: nextReq.title,
                year: nextReq.year || new Date().getFullYear(),
                duration: nextReq.duration || 210,
                ytId: nextReq.ytId,
                requestedBy: nextReq.by
            };
            CURRENT_RADIO_INDEX = -1;
        } else {
            CURRENT_RADIO_INDEX = (CURRENT_RADIO_INDEX + 1) % tracks.length;
            CURRENT_RADIO_SONG = tracks[CURRENT_RADIO_INDEX];
        }
        dur = CURRENT_RADIO_SONG.duration || 180;
    }
}

function getRadioNowPlaying() {
    updateRadioState();
    if (!CURRENT_RADIO_SONG) {
        return { index: 0, song: { artist: 'DJ', title: 'Boş', duration: 0, ytId: '' }, elapsed: 0, remaining: 0, progress: 0, next: null };
    }
    const elapsed = Math.floor((Date.now() - CURRENT_RADIO_START_TIME) / 1000);
    const dur = CURRENT_RADIO_SONG.duration || 180;
    const remaining = Math.max(0, dur - elapsed);
    const progress = Math.min(100, Math.round((elapsed / dur) * 100));

    let nextSong = null;
    if (SONG_REQUESTS.length > 0) {
        nextSong = {
            artist: SONG_REQUESTS[0].artist,
            title: SONG_REQUESTS[0].title,
            year: SONG_REQUESTS[0].year || new Date().getFullYear()
        };
    } else {
        const tracks = liveTracks();
        if (tracks.length > 0) {
            let nextIdx = (CURRENT_RADIO_INDEX + 1) % tracks.length;
            let safety = tracks.length;
            while (safety-- > 0 && tracks[nextIdx] &&
                   tracks[nextIdx].artist === CURRENT_RADIO_SONG.artist &&
                   tracks[nextIdx].title === CURRENT_RADIO_SONG.title) {
                nextIdx = (nextIdx + 1) % tracks.length;
                if (nextIdx === CURRENT_RADIO_INDEX) break;
            }
            nextSong = tracks[nextIdx] || null;
        }
    }

    return {
        index: CURRENT_RADIO_INDEX,
        song: CURRENT_RADIO_SONG,
        elapsed: elapsed,
        remaining: remaining,
        progress: progress,
        next: nextSong
    };
}

// ============ SHOUTBOX / ACTIVITY SYNC ============
let _lastRadioIdx = -1;
function refreshRadioActivity() {
    try {
        const np = getRadioNowPlaying();
        if (np && np.index !== _lastRadioIdx) {
            _lastRadioIdx = np.index;
            const s = np.song;
            const yearStr = s.year ? ` (${s.year})` : '';
            pushActivity(`DJ_RetroBot şimdi "${s.artist} — ${s.title}"${yearStr} çalıyor`, '🎵');
        }
    } catch (e) { console.warn('[RADIO] refreshRadioActivity hatası:', e.message); }
}

setInterval(refreshRadioActivity, 60_000);
setTimeout(refreshRadioActivity, 5_000);

// ============ SONG REQUESTS COOLDOWNS & STATE ============
const SONG_REQUESTS = [];
const SONG_REQ_COOLDOWN = 5 * 60 * 1000;
const _lastReqByNick = new Map();

// Diskten bekleyen istekleri yükle
const SONG_REQ_FILE = path.join(DATA_DIR, 'song_requests.json');
try {
    if (fs.existsSync(SONG_REQ_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SONG_REQ_FILE, 'utf8'));
        if (Array.isArray(raw)) {
            SONG_REQUESTS.push(...raw);
            console.log(`[DJ] ${SONG_REQUESTS.length} bekleyen şarkı isteği diskten yüklendi`);
        }
    }
} catch (e) {
    console.error('[DJ] song_requests load hatası:', e.message);
}

function saveSongRequests() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const tempPath = SONG_REQ_FILE + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(SONG_REQUESTS, null, 2), 'utf8');
        fs.renameSync(tempPath, SONG_REQ_FILE);
    } catch (e) {
        console.error('[DJ] song_requests save hatası:', e.message);
    }
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

async function searchAndVerifyYT(targetArtist, targetTitle) {
    const query = `${targetArtist} ${targetTitle}`;
    console.log(`[RADYO] YouTube araması yapılıyor: "${query}"`);
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    
    const html = await new Promise((resolve) => {
        https.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', () => resolve(''));
    });
    
    const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    let match;
    const videoIds = [];
    while ((match = regex.exec(html)) !== null) {
        const id = match[1];
        if (!videoIds.includes(id)) {
            videoIds.push(id);
        }
        if (videoIds.length >= 5) break;
    }
    
    if (videoIds.length === 0) return null;
    
    const cleanArtist = normalize(targetArtist);
    const cleanTitle = normalize(targetTitle);
    
    for (const id of videoIds) {
        const ytTitle = await getVideoTitle(id);
        if (!ytTitle) continue;
        const cleanYtTitle = normalize(ytTitle);
        const artistMatch = cleanYtTitle.includes(cleanArtist);
        const titleMatch = cleanYtTitle.includes(cleanTitle);
        if (artistMatch && titleMatch) return id;
    }
    
    for (const id of videoIds) {
        const ytTitle = await getVideoTitle(id);
        if (!ytTitle) continue;
        const cleanYtTitle = normalize(ytTitle);
        const titleMatch = cleanYtTitle.includes(cleanTitle);
        if (titleMatch) return id;
    }
    return null;
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

async function resolveSongWithGemini(artist, title) {
    if (!aiService.hasAiService) return null;
    const prompt = `You are a music expert assistant for a Turkish 70s-90s-2000s retro radio platform.
The user requested a song with artist "${artist}" and title "${title}". They might have made typos, written the lyrics instead, or written a description (e.g. "o öpücük şarkısı").

Identify the actual, correct Turkish retro artist name, song title, and the release year of the song.
If you cannot identify any song, return {"success": false}.
If you can, return a JSON object with:
{
  "success": true,
  "artist": "Correct Artist Name",
  "title": "Correct Song Title",
  "year": 1999
}

Return ONLY valid JSON. No markdown, no triple backticks.`;

    try {
        const text = await aiService.generateText({
            prompt: prompt,
            responseMimeType: 'application/json',
            model: 'gemini-2.5-flash-lite'
        });
        if (!text) return null;
        const result = JSON.parse(text.trim());
        if (result.success && result.artist && result.title) {
            return {
                artist: result.artist,
                title: result.title,
                year: parseInt(result.year, 10) || new Date().getFullYear()
            };
        }
    } catch (err) {
        console.warn('[GEMINI-RADIO] Error:', err.message);
    }
    return null;
}

async function resolveSongRequest(artist, title) {
    const tracks = liveTracks();
    let found = tracks.find(t => 
        t.artist.toLowerCase() === artist.toLowerCase() &&
        t.title.toLowerCase() === title.toLowerCase()
    );
    if (found) {
        if (found.year && found.year > 2008) return { error: `Bu şarkı (${found.year}) 2008 sonrasına ait olduğu için nostalji konseptine uymamaktadır.` };
        return { ...found, source: 'playlist' };
    }

    found = tracks.find(t => 
        t.artist.toLowerCase().includes(artist.toLowerCase()) &&
        t.title.toLowerCase().includes(title.toLowerCase())
    );
    if (found) {
        if (found.year && found.year > 2008) return { error: `Bu şarkı (${found.year}) 2008 sonrasına ait olduğu için nostalji konseptine uymamaktadır.` };
        return { ...found, source: 'playlist_fuzzy' };
    }

    const aiResolved = await resolveSongWithGemini(artist, title);
    let targetArtist, targetTitle, targetYear;
    if (aiResolved) {
        targetArtist = aiResolved.artist;
        targetTitle = aiResolved.title;
        targetYear = aiResolved.year;
        if (targetYear > 2008) {
            return { error: `İstediğiniz şarkı (${targetYear}) 2008 sonrasına ait olduğu için nostalji konseptine uymamaktadır.` };
        }
    } else {
        targetArtist = artist.trim();
        targetTitle = title.trim();
        targetYear = 1999;
    }

    let aiFound = tracks.find(t => 
        t.artist.toLowerCase() === targetArtist.toLowerCase() &&
        t.title.toLowerCase() === targetTitle.toLowerCase()
    );
    if (aiFound) {
        if (aiFound.year && aiFound.year > 2008) return { error: `Bu şarkı (${aiFound.year}) 2008 sonrasına ait olduğu için nostalji konseptine uymamaktadır.` };
        return { ...aiFound, source: 'playlist_ai_resolved' };
    }

    const ytId = await searchAndVerifyYT(targetArtist, targetTitle);
    if (ytId) {
        const duration = await getYTDuration(ytId);
        const newSong = {
            artist: targetArtist,
            title: targetTitle,
            year: targetYear,
            ytId: ytId,
            duration: duration && duration > 10 ? duration : 210,
        };
        try {
            RADIO_PLAYLIST.push(newSong);
            const playlistPath = path.join(__dirname, '..', 'playlist.json');
            fs.writeFileSync(playlistPath, JSON.stringify(RADIO_PLAYLIST, null, 4), 'utf8');
            console.log(`[RADYO] AI Yeni Şarkı Entegre Etti: "${newSong.artist} - ${newSong.title}" playlist.json'a eklendi.`);
        } catch (e) {
            console.error('[RADYO-SAVE] Playlist writing error:', e.message);
        }
        return { ...newSong, source: 'youtube_integrated' };
    }
    return { error: `İstediğiniz şarkı ("${targetArtist} - ${targetTitle}") için YouTube'da eşleşen/doğrulanan bir video bulunamadı.` };
}

// ============ API ROUTES ============

// Frontend YT 150/101 hatasında çağrılır → ID'yi blacklist'e ekle
router.post('/radio/dead', express.json(), async (req, res) => {
    const { ytId } = req.body;
    if (!ytId || typeof ytId !== 'string' || ytId.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(ytId)) {
        return res.status(400).json({ success: false, error: 'Geçersiz ytId' });
    }
    let reporter = 'anon';
    try {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            reporter = decoded.nick || 'anon';
        }
    } catch (e) { console.error('[RADIO-DEAD] Reporter JWT doğrulama hatası:', e.message); }
    if (reporter === 'anon') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        reporter = 'ip:' + ip;
    }
    let v = DEAD_YT_IDS.get(ytId);
    if (!v) {
        v = { reporters: new Set(), lastFailTs: Date.now() };
        DEAD_YT_IDS.set(ytId, v);
    }
    const isNew = !v.reporters.has(reporter);
    v.reporters.add(reporter);
    v.lastFailTs = Date.now();
    if (isNew) saveDeadYtIds();
    const count = v.reporters.size;
    const trulyDead = count >= DEAD_YT_THRESHOLD;
    console.log(`[DJ] Fail bildirimi: ${ytId} (${count}/${DEAD_YT_THRESHOLD} reporter, ${trulyDead ? 'BLOCKED' : 'şüpheli'}) by ${reporter}`);
    
    if (trulyDead && CURRENT_RADIO_SONG && CURRENT_RADIO_SONG.ytId === ytId) {
        console.log(`[DJ] Şu an çalan şarkı (${CURRENT_RADIO_SONG.title}) ölü olarak doğrulandı, hemen sıradakine geçiliyor...`);
        CURRENT_RADIO_START_TIME = Date.now() - (CURRENT_RADIO_SONG.duration || 180) * 1000 - 1000;
        updateRadioState();
    }
    res.json({ success: true, reporters: count, blocked: trulyDead, threshold: DEAD_YT_THRESHOLD });
});

// Admin: Dead YT listesini temizle
router.post('/admin/radio/clear-dead-yt', requireAuth, requireRole('admin'), async (req, res) => {
    const before = DEAD_YT_IDS.size;
    DEAD_YT_IDS.clear();
    saveDeadYtIds();
    console.log(`[DJ] Admin dead-list reset: ${before} → 0 (by ${req.user.nick})`);
    res.json({ success: true, cleared: before });
});

// Get radio queue
router.get('/radio/queue', async (req, res) => {
    res.json({ success: true, queue: SONG_REQUESTS.slice(0, 10) });
});

// Request song
router.post('/radio/request', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler şarkı isteyemez — önce kayıt ol.' });
    }
    const { artist, title } = req.body;
    if (!artist || !title || !artist.trim() || !title.trim()) {
        return res.status(400).json({ success: false, error: 'artist ve title gerekli' });
    }
    const last = _lastReqByNick.get(req.user.nick) || 0;
    if (Date.now() - last < SONG_REQ_COOLDOWN) {
        const remainSec = Math.ceil((SONG_REQ_COOLDOWN - (Date.now() - last)) / 1000);
        return res.status(429).json({ success: false, error: `Bir sonraki istek için ${Math.ceil(remainSec / 60)} dakika bekle.` });
    }

    const cleanArtist = artist.trim().slice(0, 60);
    const cleanTitle = title.trim().slice(0, 100);

    const resolved = await resolveSongRequest(cleanArtist, cleanTitle);
    if (!resolved) return res.status(404).json({ success: false, error: 'İstediğiniz şarkı YouTube\'da veya listede bulunamadı.' });
    if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });

    const reqItem = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        by: req.user.nick,
        artist: resolved.artist,
        title: resolved.title,
        year: resolved.year,
        duration: resolved.duration,
        ytId: resolved.ytId,
        ts: Date.now(),
    };

    SONG_REQUESTS.push(reqItem);
    if (SONG_REQUESTS.length > 50) SONG_REQUESTS.splice(0, SONG_REQUESTS.length - 50);
    saveSongRequests();
    _lastReqByNick.set(req.user.nick, Date.now());

    console.log(`[RADYO] Talep Çözümlendi: ${req.user.nick} → ${resolved.artist} - ${resolved.title}`);
    try { pushActivity(`${req.user.nick} şarkı istedi: "${resolved.artist} — ${resolved.title}"`, '🎵'); } catch (e) { console.warn('[RADYO] pushActivity hatası:', e.message); }
    
    res.json({ success: true, request: reqItem, queueLength: SONG_REQUESTS.length });
});

// Now playing
router.get('/radio/now-playing', async (req, res) => {
    const np = getRadioNowPlaying();
    res.json({
        success: true,
        current: {
            artist: np.song.artist,
            title: np.song.title,
            year: np.song.year,
            duration: np.song.duration,
            elapsed: np.elapsed,
            remaining: np.remaining,
            progress: np.progress,
            ytId: np.song.ytId || '',
            searchQuery: np.song.artist + ' - ' + np.song.title
        },
        next: np.next ? { artist: np.next.artist, title: np.next.title, year: np.next.year } : null,
        trackIndex: np.index,
        totalTracks: RADIO_PLAYLIST.length,
        dj: 'DJ_RetroBot'
    });
});

// Playlist
router.get('/radio/playlist', async (req, res) => {
    const totalSeconds = RADIO_PLAYLIST.reduce((s, t) => s + (t.duration || 0), 0);
    res.json({
        success: true,
        tracks: RADIO_PLAYLIST.map((s, i) => ({
            index: i, artist: s.artist, title: s.title, year: s.year,
            duration: Math.floor(s.duration / 60) + ':' + (s.duration % 60).toString().padStart(2, '0')
        })),
        total: RADIO_PLAYLIST.length,
        totalDuration: Math.floor(totalSeconds / 60) + ' dakika'
    });
});

module.exports = {
    router,
    getRadioNowPlaying
};
