require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json()); // Moderation API için JSON body parser

// ============ Statik dosya sunumu ============
// index.html, room.html vb. doğrudan sunulur
app.use(express.static(__dirname));

// LiveKit client SDK'yı node_modules'dan sun
app.use('/livekit-sdk', express.static(path.join(__dirname, 'node_modules', 'livekit-client', 'dist')));

// ============ LiveKit Token Endpoint ============
app.get('/getToken', async (req, res) => {
    const { room, identity } = req.query;

    if (!room || !identity) {
        return res.status(400).json({
            error: 'Eksik parametre: room ve identity gerekli',
            usage: '/getToken?room=OdaAdi&identity=KullaniciAdi'
        });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
        return res.status(500).json({
            error: 'LiveKit API bilgileri .env dosyasında tanımlı değil'
        });
    }

    try {
        const token = new AccessToken(apiKey, apiSecret, {
            identity: identity,
            name: identity,
            ttl: '6h',
        });

        token.addGrant({
            roomJoin: true,
            room: room,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
        });

        const jwt = await token.toJwt();

        res.json({
            token: jwt,
            url: process.env.LIVEKIT_URL || 'ws://localhost:7880',
            room: room,
            identity: identity
        });
    } catch (err) {
        console.error('Token oluşturma hatası:', err);
        res.status(500).json({ error: 'Token oluşturulamadı: ' + err.message });
    }
});

// ============ Oda Tanımları ============
const ROOM_DEFS = [
    { name: 'Genel Sohbet', max: 200, icon: '💬', category: 'free', badge: 'hot', desc: 'Her konuda serbest sohbet — yeni arkadaşlıklar burada başlıyor!' },
    { name: 'VIP Lounge', max: 50, icon: '👑', category: 'vip', badge: 'vip', desc: 'Sadece VIP üyelere özel — premium sohbet deneyimi' },
    { name: 'Müzik Odası', max: 100, icon: '🎵', category: 'music', badge: 'music', desc: "DJ'ler çalıyor! İstek parça bırak, birlikte dinleyelim 🎧" },
    { name: 'Kamera Odası 1', max: 30, icon: '📹', category: 'cam', badge: 'cam', desc: 'Yüz yüze sohbet — kameranı aç, tanışalım!' },
    { name: 'Gece Kulübü', max: 50, icon: '🌙', category: 'hot', badge: null, desc: 'Gece kuşları burada — eğlence durmuyor!' },
    { name: 'VIP Gold', max: 30, icon: '💎', category: 'vip', badge: 'vip-new', desc: 'Yepyeni VIP Gold oda — HD ses, özel efektler, sınırsız ayrıcalık!' },
    { name: 'Rock & Metal', max: 60, icon: '🎸', category: 'music', badge: 'music', desc: 'Ağır riffler, klasik rock — sahnede sen varsın! 🤘' },
    { name: 'Kamera Odası 2', max: 30, icon: '🎥', category: 'cam', badge: 'cam', desc: 'Serbest kamera odası — gel, sohbete katıl!' },
    { name: 'Nostalji Köşesi', max: 80, icon: '📻', category: 'free', badge: 'new', desc: "2000'lerin altın çağını yeniden yaşa — eski günleri konuşalım!" },
];

// ============ LiveKit Room Service ============
function getRoomServiceClient() {
    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) return null;
    // wss:// → https:// for REST API
    const httpUrl = url.replace('wss://', 'https://').replace('ws://', 'http://');
    return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}

// Cache: oda verileri 5sn aralıklarla güncellenir
let roomCache = { data: null, ts: 0 };
const CACHE_TTL = 5000; // 5 saniye

async function fetchRoomData() {
    const now = Date.now();
    if (roomCache.data && (now - roomCache.ts) < CACHE_TTL) {
        return roomCache.data;
    }

    const svc = getRoomServiceClient();
    if (!svc) {
        // LiveKit bağlantısı yoksa boş veri döndür
        return ROOM_DEFS.map(r => ({ ...r, participants: 0, users: [] }));
    }

    try {
        const liveRooms = await svc.listRooms();
        const liveMap = new Map();

        // Her odanın katılımcılarını çek
        for (const lr of liveRooms) {
            try {
                const participants = await svc.listParticipants(lr.name);
                liveMap.set(lr.name, {
                    count: lr.numParticipants,
                    users: participants.map(p => p.identity)
                });
            } catch (e) {
                liveMap.set(lr.name, { count: lr.numParticipants, users: [] });
            }
        }

        // Oda tanımlarını LiveKit verileriyle birleştir
        const result = ROOM_DEFS.map(def => {
            const live = liveMap.get(def.name) || { count: 0, users: [] };
            return {
                name: def.name,
                max: def.max,
                icon: def.icon,
                category: def.category,
                badge: def.badge,
                desc: def.desc,
                participants: live.count,
                users: live.users,
                isFull: live.count >= def.max
            };
        });

        roomCache = { data: result, ts: now };
        return result;
    } catch (err) {
        console.error('[API] LiveKit oda verisi alınamadı:', err.message);
        // Hata durumunda eski cache'i döndür veya boş veri
        return roomCache.data || ROOM_DEFS.map(r => ({ ...r, participants: 0, users: [] }));
    }
}

// ============ API Endpoints ============
app.get('/api/rooms', async (req, res) => {
    try {
        const rooms = await fetchRoomData();
        const totalOnline = rooms.reduce((sum, r) => sum + r.participants, 0);
        // Tüm kullanıcıları topla (sidebar için)
        const allUsers = rooms.flatMap(r => r.users);
        res.json({ rooms, totalOnline, allUsers });
    } catch (err) {
        console.error('[API] /api/rooms hatası:', err);
        res.status(500).json({ error: 'Oda verisi alınamadı' });
    }
});

// ============ Moderasyon: Admin Doğrulama ============
function checkAdmin(req, res) {
    const adminSecret = process.env.ADMIN_SECRET || 'retro2024admin';
    const token = req.headers['x-admin-token'] || req.body?.adminToken;
    if (token !== adminSecret) {
        res.status(403).json({ error: 'Yetkisiz erişim' });
        return false;
    }
    return true;
}

// ============ Moderasyon: Kullanıcı At ============
app.post('/api/kick', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { room, identity, reason } = req.body;
    if (!room || !identity) {
        return res.status(400).json({ error: 'room ve identity gerekli' });
    }
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ error: 'LiveKit bağlantısı yok' });
    try {
        await svc.removeParticipant(room, identity);
        console.log(`[MOD] ${identity} odadan atıldı: ${room} (Sebep: ${reason || 'belirtilmedi'})`);
        roomCache.ts = 0; // Cache'i invalidate et
        res.json({ success: true, message: `${identity} odadan atıldı` });
    } catch (err) {
        console.error('[MOD] Kick hatası:', err.message);
        res.status(500).json({ error: 'Kullanıcı atılamadı: ' + err.message });
    }
});

// ============ Moderasyon: Kullanıcı Sustur ============
app.post('/api/mute', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { room, identity, trackSid } = req.body;
    if (!room || !identity) {
        return res.status(400).json({ error: 'room ve identity gerekli' });
    }
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ error: 'LiveKit bağlantısı yok' });
    try {
        // Kullanıcının tüm audio track'lerini bul ve sustur
        const participants = await svc.listParticipants(room);
        const target = participants.find(p => p.identity === identity);
        if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

        for (const track of target.tracks) {
            if (track.type === 1) { // AUDIO
                await svc.mutePublishedTrack(room, identity, track.sid, true);
            }
        }
        console.log(`[MOD] ${identity} susturuldu: ${room}`);
        roomCache.ts = 0;
        res.json({ success: true, message: `${identity} susturuldu` });
    } catch (err) {
        console.error('[MOD] Mute hatası:', err.message);
        res.status(500).json({ error: 'Susturma başarısız: ' + err.message });
    }
});

// ============ Küfür Filtresi Kelime Listesi ============
const PROFANITY_LIST = [
    'amk', 'aq', 'oç', 'orospu', 'piç', 'sik', 'yarrak', 'göt',
    'meme', 'am', 'taşak', 'ibne', 'pezevenk', 'kahpe', 'puşt',
    'gavat', 'dangalak', 'gerizekalı', 'salak', 'aptal', 'mal',
    'fuck', 'shit', 'bitch', 'ass', 'dick', 'pussy'
];

app.get('/api/profanity', (req, res) => {
    res.json({ words: PROFANITY_LIST });
});

// ============ Admin Login Doğrulama ============
app.post('/api/admin/verify', (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET || 'retro2024admin';
    const { token } = req.body;
    if (token === adminSecret) {
        res.json({ success: true, role: 'admin' });
    } else {
        res.status(403).json({ success: false, error: 'Yanlış şifre' });
    }
});

// ============ Sağlık kontrolü ============
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        livekit_url: process.env.LIVEKIT_URL,
        api_key_set: !!process.env.LIVEKIT_API_KEY,
        api_secret_set: !!process.env.LIVEKIT_API_SECRET
    });
});

// ============ Kullanıcı Deposu (JSON) ============
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'retrosesler_jwt_secret_2024';

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

function loadUsers() {
    ensureDataDir();
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch { return []; }
}

function saveUsers(users) {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// ============ Kayıt (Register) ============
app.post('/api/register', (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) {
        return res.status(400).json({ success: false, error: 'Nick ve şifre gerekli' });
    }
    if (nick.length < 2 || nick.length > 20) {
        return res.status(400).json({ success: false, error: 'Nick 2-20 karakter olmalı' });
    }
    if (password.length < 4) {
        return res.status(400).json({ success: false, error: 'Şifre en az 4 karakter olmalı' });
    }

    const users = loadUsers();
    const exists = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
    if (exists) {
        return res.status(409).json({ success: false, error: 'Bu nick zaten alınmış' });
    }

    const user = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        nick: nick,
        password: hashPassword(password),
        role: 'user',
        createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Yeni kayıt: ${nick}`);
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// ============ Giriş (Login) ============
app.post('/api/login', (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) {
        return res.status(400).json({ success: false, error: 'Nick ve şifre gerekli' });
    }

    const users = loadUsers();
    const user = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ success: false, error: 'Nick veya şifre yanlış' });
    }

    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Giriş: ${nick}`);
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// ============ Oturum Kontrolü (Me) — profil bilgileri dahil ============
app.get('/api/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        const users = loadUsers();
        const user = users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        res.json({
            success: true, nick: user.nick, role: user.role, id: user.id,
            avatar: user.avatar || 'default', bio: user.bio || '',
            createdAt: user.createdAt
        });
    } catch {
        res.status(401).json({ success: false, error: 'Geçersiz token' });
    }
});

// ============ Profil Güncelleme ============
const AVATAR_LIST = [
    'default', 'retro_tv', 'cassette', 'gameboy', 'floppy', 'headphones',
    'sunglasses', 'rocket', 'star', 'crown', 'diamond', 'fire',
    'robot', 'alien', 'ghost', 'ninja', 'wizard', 'pirate',
    'cat', 'dog', 'unicorn', 'phoenix'
];

app.post('/api/profile', requireAuth, (req, res) => {
    const { avatar, bio } = req.body;
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    if (avatar && AVATAR_LIST.includes(avatar)) user.avatar = avatar;
    if (bio !== undefined) user.bio = String(bio).substring(0, 60);

    saveUsers(users);
    console.log(`[PROFILE] ${user.nick} profil güncelledi`);
    res.json({ success: true, avatar: user.avatar, bio: user.bio });
});

// ============ Herkese Açık Profil Bilgisi ============
app.get('/api/profile/:nick', (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.nick.toLowerCase() === req.params.nick.toLowerCase());
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    res.json({
        success: true, nick: user.nick, role: user.role,
        avatar: user.avatar || 'default', bio: user.bio || '',
        createdAt: user.createdAt
    });
});

// ============ BAN SİSTEMİ ============
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const LOCKS_FILE = path.join(DATA_DIR, 'locks.json');

function loadBans() {
    ensureDataDir();
    if (!fs.existsSync(BANS_FILE)) fs.writeFileSync(BANS_FILE, '[]', 'utf8');
    try { return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')); } catch { return []; }
}
function saveBans(bans) {
    ensureDataDir();
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2), 'utf8');
}
function loadLocks() {
    ensureDataDir();
    if (!fs.existsSync(LOCKS_FILE)) fs.writeFileSync(LOCKS_FILE, '{}', 'utf8');
    try { return JSON.parse(fs.readFileSync(LOCKS_FILE, 'utf8')); } catch { return {}; }
}
function saveLocks(locks) {
    ensureDataDir();
    fs.writeFileSync(LOCKS_FILE, JSON.stringify(locks, null, 2), 'utf8');
}
function isUserBanned(nick) {
    const bans = loadBans();
    const now = new Date();
    return bans.find(b => b.nick.toLowerCase() === nick.toLowerCase() && (!b.expiresAt || new Date(b.expiresAt) > now));
}

// ============ JWT AUTH MIDDLEWARE ============
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Geçersiz token' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
        }
        next();
    };
}

// ============ BAN KONTROLÜ (Token isterken) ============
const originalGetToken = app._router.stack.find(r => r.route && r.route.path === '/getToken');

// Ban kontrolü middleware — token isteyen kullanıcıyı kontrol et
app.use('/getToken', (req, res, next) => {
    const identity = req.query.identity;
    if (identity) {
        const ban = isUserBanned(identity);
        if (ban) {
            return res.status(403).json({
                error: 'Yasaklandınız',
                reason: ban.reason || 'Kural ihlali',
                expiresAt: ban.expiresAt || 'Süresiz'
            });
        }
    }
    next();
});

// ============ ODA KİLİT KONTROLÜ ============
app.get('/api/room/status', (req, res) => {
    const { room } = req.query;
    if (!room) return res.status(400).json({ error: 'room parametresi gerekli' });
    const locks = loadLocks();
    res.json({
        room,
        locked: !!locks[room],
        lockedBy: locks[room]?.lockedBy || null,
        lockedAt: locks[room]?.lockedAt || null
    });
});

// ============ ADMIN API ============

// Kullanıcı listesi
app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
    const users = loadUsers().map(u => ({
        id: u.id,
        nick: u.nick,
        role: u.role,
        createdAt: u.createdAt
    }));
    res.json({ success: true, users });
});

// Rol değiştir
app.post('/api/admin/users/role', requireAuth, requireRole('admin'), (req, res) => {
    const { userId, role } = req.body;
    if (!userId || !['user', 'mod', 'admin'].includes(role)) {
        return res.status(400).json({ success: false, error: 'userId ve geçerli role gerekli (user/mod/admin)' });
    }
    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    user.role = role;
    saveUsers(users);
    console.log(`[ADMIN] Rol değişikliği: ${user.nick} → ${role}`);
    res.json({ success: true, nick: user.nick, role });
});

// Ban listesi
app.get('/api/admin/bans', requireAuth, requireRole('admin', 'mod'), (req, res) => {
    const bans = loadBans();
    res.json({ success: true, bans });
});

// Ban ekle
app.post('/api/admin/ban', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { nick, reason, duration } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli' });

    let expiresAt = null;
    if (duration && duration > 0) {
        expiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString(); // dakika cinsinden
    }

    const bans = loadBans();
    // Zaten banlı mı?
    const existing = bans.findIndex(b => b.nick.toLowerCase() === nick.toLowerCase());
    if (existing >= 0) bans.splice(existing, 1);

    bans.push({
        nick,
        reason: reason || 'Kural ihlali',
        bannedBy: req.user.nick,
        bannedAt: new Date().toISOString(),
        expiresAt
    });
    saveBans(bans);

    // LiveKit'ten de at (tüm odalardan)
    try {
        const livekitRooms = await svc.listRooms();
        for (const room of livekitRooms) {
            try { await svc.removeParticipant(room.name, nick); } catch { }
        }
    } catch { }

    console.log(`[ADMIN] Ban: ${nick} by ${req.user.nick} — ${reason || 'sebep yok'}`);
    res.json({ success: true, message: `${nick} yasaklandı` });
});

// Ban kaldır
app.post('/api/admin/unban', requireAuth, requireRole('admin', 'mod'), (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli' });

    const bans = loadBans();
    const idx = bans.findIndex(b => b.nick.toLowerCase() === nick.toLowerCase());
    if (idx < 0) return res.status(404).json({ success: false, error: 'Ban kaydı bulunamadı' });

    bans.splice(idx, 1);
    saveBans(bans);
    console.log(`[ADMIN] Unban: ${nick} by ${req.user.nick}`);
    res.json({ success: true, message: `${nick} yasağı kaldırıldı` });
});

// Oda kilitle
app.post('/api/admin/room/lock', requireAuth, requireRole('admin', 'mod'), (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'room gerekli' });
    const locks = loadLocks();
    locks[room] = { lockedBy: req.user.nick, lockedAt: new Date().toISOString() };
    saveLocks(locks);
    console.log(`[ADMIN] Oda kilitlendi: ${room} by ${req.user.nick}`);
    res.json({ success: true, message: `${room} kilitlendi` });
});

// Oda kilidini aç
app.post('/api/admin/room/unlock', requireAuth, requireRole('admin', 'mod'), (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'room gerekli' });
    const locks = loadLocks();
    delete locks[room];
    saveLocks(locks);
    console.log(`[ADMIN] Oda kilidi açıldı: ${room} by ${req.user.nick}`);
    res.json({ success: true, message: `${room} kilidi açıldı` });
});

// İstatistikler
app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res) => {
    const users = loadUsers();
    const bans = loadBans();
    const locks = loadLocks();
    let totalOnline = 0;
    try {
        const rooms = await svc.listRooms();
        rooms.forEach(r => totalOnline += r.numParticipants);
    } catch { }
    res.json({
        success: true,
        totalUsers: users.length,
        totalBans: bans.length,
        lockedRooms: Object.keys(locks).length,
        totalOnline
    });
});

// ============ Sunucu başlat ============
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   🎙️  RetroSesler.com — Sunucu Aktif     ║');
    console.log('  ╠══════════════════════════════════════════╣');
    console.log(`  ║   🌐  http://${HOST}:${PORT}                  ║`);
    console.log(`  ║   🔑  LiveKit: ${process.env.LIVEKIT_URL ? '✅' : '❌'}  API: ${process.env.LIVEKIT_API_KEY ? '✅' : '❌'}             ║`);
    console.log(`  ║   🌍  ENV: ${process.env.NODE_ENV || 'development'}                    ║`);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
});
