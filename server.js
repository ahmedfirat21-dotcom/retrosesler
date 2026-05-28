require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken, RoomServiceClient, TrackSource } = require('livekit-server-sdk');
// String → TrackSource enum çevirici (AccessToken VideoGrant + updateParticipant için)
const SOURCE_MAP = { microphone: TrackSource.MICROPHONE, camera: TrackSource.CAMERA, screen_share: TrackSource.SCREEN_SHARE };
function toTrackSources(sources) {
    if (!Array.isArray(sources)) return [];
    return sources.map(s => typeof s === 'string' ? (SOURCE_MAP[s] ?? s) : s).filter(s => s !== undefined);
}
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const Moderation = require('./services/moderation');
const nodemailer = require('nodemailer');

const path = require('path');

// ============ MAIL TRANSPORT (Şifre sıfırlama vb.) ============
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM env'den okunur.
// Yoksa email gönderilmez, sadece console.log'a yazılır (development mode).
let _mailTransporter = null;
function getMailTransporter() {
    if (_mailTransporter !== null) return _mailTransporter;
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
        console.warn('[MAIL] SMTP yapılandırması yok — emailler console\'a yazılacak (dev mode).');
        _mailTransporter = 'dev';
        return 'dev';
    }
    _mailTransporter = nodemailer.createTransport({
        host,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true' || parseInt(process.env.SMTP_PORT) === 465,
        auth: { user, pass },
    });
    console.log(`[MAIL] SMTP transport hazır: ${host}`);
    return _mailTransporter;
}
async function sendMail({ to, subject, text, html }) {
    const t = getMailTransporter();
    const from = process.env.MAIL_FROM || 'RetroSesler <noreply@retrosesler.com>';
    if (t === 'dev') {
        console.log('═════════════ DEV MAIL ═════════════');
        console.log('TO:', to);
        console.log('SUBJECT:', subject);
        console.log('TEXT:', text);
        console.log('════════════════════════════════════');
        return { dev: true };
    }
    return await t.sendMail({ from, to, subject, text, html });
}

const app = express();
app.set('trust proxy', 1); // Nginx arkasında — rate-limit doğru IP görsün
// ★ GÜVENLİK FIX (28 May 2026): CORS origin kısıtlaması — eskiden tamamen açıktı,
// herhangi bir siteden API çağrılabiliyordu. Artık sadece retrosesler.com ve localhost.
const ALLOWED_ORIGINS = [
    'https://retrosesler.com',
    'https://www.retrosesler.com',
    'http://localhost:3000',
    'http://localhost:5173',
];
app.use(cors({
    origin: (origin, cb) => {
        // origin undefined = same-origin veya non-browser (curl, server) — izin ver
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error('CORS: Bu origin izinli değil'));
    },
    credentials: true,
}));
app.use(express.json({ limit: '2mb' })); // Moderation API + audio/image rapor için 2MB

// ============ Rate Limit (brute force + spam koruması) ============
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 dakika
    max: 8,                   // IP başına 8 deneme / 5 dakika (login + register + google + guest)
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Çok fazla deneme — 5 dakika sonra tekrar dene.' },
});
const dmLimiter = rateLimit({
    windowMs: 60 * 1000,      // 1 dakika
    max: 20,                  // IP başına 20 DM / dakika
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'DM gönderme limiti — bir dakika bekle.' },
});
const kornaLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,                   // dakikada 3 korna
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Korna spam — biraz bekle.' },
});

// ============ Yeni Rate Limiters (Codex tavsiyesi #1 — abuse koruması) ============
const chatModerateLimiter = rateLimit({
    windowMs: 10 * 1000,      // 10 saniye
    max: 8,                   // 8 mesaj / 10sn = ~50 msg/dk üst sınırı (insan hızı yeterli)
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: true, blocked: true, safe: false, action: 'rate_limit', reason: 'Çok hızlı yazıyorsun, biraz yavaşla.' },
});
const stageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,                  // el-kaldırma + grant + revoke + kuyruk işlemleri dakikada 15
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Sahne işlemleri için biraz bekle.' },
});
const camLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,                  // kamera grant/revoke dakikada 10
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Kamera işlemleri için biraz bekle.' },
});
const roomCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 saat
    max: 5,                   // saatte 5 yeni oda (kullanıcı başına aktif 2 zaten limit)
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Saatte en fazla 5 yeni oda açabilirsin.' },
});
const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 15,                  // saatte 15 rapor (manuel checkReportRate ayrıca 10 + per-target var)
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Saatte rapor limiti aşıldı.' },
});
const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,                  // saatte 30 davet
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Davet limiti aşıldı.' },
});
const nickChangeLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 saat
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Nick değiştirme — günde en fazla 3 kez.' },
});
const passwordAccessLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 dakika
    max: 8,                   // IP başına 8 yanlış şifre denemesi / 10 dk (brute-force koruması)
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Çok fazla yanlış şifre — 10 dakika bekle.' },
});

// ============ Statik dosya sunumu ============
// .html uzantılı dosyalara doğrudan erişimi engelle (index.html hariç - root'ta sunulur)
app.get('*.html', (req, res, next) => {
    if (req.path === '/index.html') return res.redirect('/');
    return res.status(404).send('Sayfa bulunamadı');
});
// Temiz URL rotaları
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/giris', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));
app.get('/sifre-sifirla', (req, res) => res.sendFile(path.join(__dirname, 'sifre-sifirla.html')));
app.get('/oda', (req, res) => res.sendFile(path.join(__dirname, 'room.html')));
app.get('/yonetim-r3tro', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
// Yasal + bilgi sayfaları
app.get('/hakkimizda', (req, res) => res.sendFile(path.join(__dirname, 'hakkimizda.html')));
app.get('/gizlilik', (req, res) => res.sendFile(path.join(__dirname, 'gizlilik.html')));
app.get('/kullanim-sartlari', (req, res) => res.sendFile(path.join(__dirname, 'kullanim-sartlari.html')));
// Profil sayfası — /u/:nick → profil.html (içeride JS nick'i parse eder)
app.get('/u/:nick', (req, res) => res.sendFile(path.join(__dirname, 'profil.html')));
// ============ STATİK DOSYA SUNUMU — ALLOW-LIST MODELİ ============
// ★ FIX (29 May 2026): ESKİ DURUM: express.static(__dirname) tüm proje kökünü açıyor,
// deny-list middleware ile hassas dosyalar engelleniyor (kırılgan — yeni dosya eklenmesi
// unutulursa ifşa riski). YENİ DURUM: Sadece bilinen güvenli dizinler serve ediliyor.
// Proje kökündeki hiçbir dosya (server.js, .env, *.db, data/ vb.) erişilemez.
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
    maxAge: '7d',       // statik varlıklar cache'lenebilir
    etag: true,
}));
// LiveKit client SDK'yı node_modules'dan sun
app.use('/livekit-sdk', express.static(path.join(__dirname, 'node_modules', 'livekit-client', 'dist')));

// ============ Health Check (Docker + Monitoring) ============
// ★ FIX (28 May 2026): docker-compose.yml healthcheck /health bekliyor ama endpoint yoktu.
// Container sürekli 'unhealthy' işaretleniyordu.
app.get('/health', async (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
        version: '2.0.0',
    });
});

// ============ LiveKit Token Endpoint ============
// JWT zorunlu — identity URL'den DEĞİL, JWT'den çekilir (kimlik hırsızlığı koruması).
// Hem kayıtlı hem misafir kullanıcı JWT alıyor (/api/login, /api/register, /api/auth/google, /api/auth/guest).
// ★ FIX (29 May 2026): /getToken → /api/token taşındı (API namespace tutarlılığı)
app.get('/getToken', (req, res) => res.redirect(307, '/api/token?' + new URLSearchParams(req.query).toString()));
app.get('/api/token', async (req, res) => {
    const { room, ac } = req.query;
    if (!room) {
        return res.status(400).json({ success: false, error: 'Eksik parametre: room gerekli' });
    }

    // ============ JWT DOĞRULAMA ============
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Oturum yok — önce giriş yap.' });
    }
    let identity, userRole;
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        identity = decoded.nick;
        userRole = decoded.role || 'user';
    } catch {
        return res.status(401).json({ success: false, error: 'Oturum geçersiz — tekrar giriş yap.' });
    }
    if (!identity) {
        return res.status(401).json({ success: false, error: 'JWT içinde nick yok.' });
    }

    // ============ BAN KONTROLÜ ============
    try {
        const ban = await isUserBanned(identity);
        if (ban) {
            return res.status(403).json({
                error: 'Yasaklandınız',
                reason: ban.reason || 'Kural ihlali',
                expiresAt: ban.expiresAt || 'Süresiz',
            });
        }
    } catch (e) { console.error('[GET_TOKEN] Ban kontrolü hatası:', e); }

    // ============ ODA-BAZINDA HOST-KICK BAN KONTROLÜ ============
    // Host birini odadan attıysa 1 saat boyunca aynı odaya tekrar giremesin
    {
        const ban = isRoomBanned(room, identity);
        const userRoomDef = (await loadUserRooms()).find(r => r.name === room);
        const isStaffOrHost = userRole === 'admin' || userRole === 'mod' || (userRoomDef && isRoomHost(userRoomDef, identity));
        // Extended ban kontrolü (24h/perm) — persistent
        const extBan = getExtendedBan(room, identity);
        const activeBan = extBan || ban;
        if (activeBan && !isStaffOrHost) {
            const isExt = !!extBan;
            let label = '~1 saat';
            if (isExt) {
                if (!extBan.until) label = 'kalıcı';
                else label = Math.ceil((extBan.until - Date.now()) / (60 * 60 * 1000)) + ' saat';
            } else {
                const minsLeft = Math.max(1, Math.ceil((ROOM_BAN_TTL_MS - (Date.now() - ban.ts)) / 60000));
                label = '~' + minsLeft + ' dk';
            }
            return res.status(403).json({
                error: `Bu odanın yönetimi seni uzaklaştırdı (${label}).${activeBan.reason ? ' Sebep: ' + activeBan.reason : ''}`,
                access: 'host_kick', reason: activeBan.reason || '',
            });
        }
    }

    // ============ ODA KİLİDİ KONTROLÜ ============
    // Codex bulgu #3: Admin oda kilitlediyse /lock endpoint çalışıyor ama /getToken kontrol etmiyordu.
    // Kilitli odaya direkt URL ile girmeye çalışırsa admin/mod hariç engellensin.
    try {
        const locks = await loadLocks();
        if (locks && locks[room]) {
            const isAdminOrMod = userRole === 'admin' || userRole === 'mod';
            if (!isAdminOrMod) {
                return res.status(403).json({
                    error: `Bu oda yöneticiler tarafından geçici olarak kilitlendi. (Kilitleyen: ${locks[room].lockedBy || 'admin'})`,
                    access: 'room_locked',
                });
            }
        }
    } catch (e) { console.error('[GET_TOKEN] Oda kilidi kontrolü hatası:', e); }

    // ============ +18 ODA YAŞ KONTROLÜ ============
    // Üye odası is_18_plus=true ise giren kullanıcı 18+ olmalı (host/admin bile değil — herkes)
    try {
        const userRoom = (await loadUserRooms()).find(r => r.name === room);
        if (userRoom?.is_18_plus) {
            const u = (await loadUsers()).find(u => u.nick.toLowerCase() === identity.toLowerCase());
            if (!isAdult(u?.birthYear)) {
                return res.status(403).json({
                    error: 'Bu oda +18 — yaş doğrulamak için profil ayarlarından doğum yılını gir veya 18 yaşından küçüksen giremezsin.',
                    access: 'adult_only',
                });
            }
        }
    } catch (e) { console.error('[GET_TOKEN] +18 yaş kontrolü hatası:', e); }

    // ============ ÖZEL ODA ERİŞİM KONTROLÜ ============
    try {
        const userRoom = (await loadUserRooms()).find(r => r.name === room);
        if (userRoom && userRoom.access && userRoom.access !== 'public') {
            const isHost = isRoomHost(userRoom, identity);  // host VEYA co-host bypass
            const isAdminOrMod = userRole === 'admin' || userRole === 'mod';
            if (!isHost && !isAdminOrMod) {
                if (userRoom.access === 'password') {
                    if (!ac) {
                        return res.status(403).json({ success: false, error: 'Şifreli oda — önce şifreyi gir.', access: 'password' });
                    }
                    try {
                        const decoded = jwt.verify(ac, JWT_SECRET);
                        if (decoded.kind !== 'room-access' || decoded.room !== room || decoded.nick.toLowerCase() !== identity.toLowerCase()) {
                            return res.status(403).json({ success: false, error: 'Erişim tokenı geçersiz.', access: 'password' });
                        }
                    } catch {
                        return res.status(403).json({ success: false, error: 'Erişim tokenı süresi dolmuş — şifreyi tekrar gir.', access: 'password' });
                    }
                } else if (userRoom.access === 'invite') {
                    const allowed = (userRoom.invitedNicks || []).some(n => n.toLowerCase() === identity.toLowerCase());
                    if (!allowed) {
                        return res.status(403).json({ success: false, error: 'Bu odaya davetli değilsin.', access: 'invite' });
                    }
                } else if (userRoom.access === 'friends') {
                    const hostFriends = (await getFriendsOf(userRoom.hostId)).map(n => n.toLowerCase());
                    if (!hostFriends.includes(identity.toLowerCase())) {
                        return res.status(403).json({ success: false, error: 'Sadece host\'un arkadaşları girebilir.', access: 'friends' });
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[ROOM] Erişim kontrolü hatası:', err.message);
        return res.status(500).json({ success: false, error: 'Erişim kontrolü yapılamadı.' });
    }

    // Aktivite feed — yeni katılım
    try {
        if (typeof pushActivity === 'function') {
            pushActivity(`${identity} → ${room} odasına katıldı`, '🚪');
        }
    } catch (e) { console.warn('[GET_TOKEN] pushActivity hatası:', e.message); }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
        return res.status(500).json({ success: false, error: 'LiveKit API bilgileri .env dosyasında tanımlı değil' });
    }

    // ============ DİNLEYİCİ/KONUŞMACI KARARI ============
    // mic_policy + rol bazlı canPublish:
    //   - mic_policy=open    → herkes konuşmacı (canPublish=true)
    //   - mic_policy=request → varsayılan dinleyici, sadece host/admin/mod otomatik konuşmacı
    //   - mic_policy=invite_only → sadece host/admin/mod konuşmacı
    let canPublish = false;
    let stageEntryReason = 'dinleyici';
    try {
        const roomDef = await findRoomDef(room);
        const policy = roomDef?.mic_policy || 'request';
        const isHostOfRoom = roomDef ? isRoomHost(roomDef, identity) : false;  // host VEYA co-host
        const isStaffRole = userRole === 'admin' || userRole === 'mod';
        if (policy === 'open') {
            canPublish = true;
            stageEntryReason = 'open_policy';
        } else if (isHostOfRoom || isStaffRole) {
            canPublish = true;
            stageEntryReason = isHostOfRoom ? 'host' : 'mod_role';
        }
        // Konuşmacı ise stage state'e ekle (UI senkronu için)
        if (canPublish && roomDef) {
            const stage = getRoomStage(room);
            if (!stage.speakers[identity]) {
                stage.speakers[identity] = { ts: Date.now(), lastSpeakTs: Date.now(), type: 'mic' };
                _persistStages();
                console.log(`[STAGE] ${identity} otomatik sahnede başladı (${stageEntryReason}): ${room}`);
            }
        }
    } catch (err) {
        console.warn('[TOKEN] mic_policy karar hatası:', err.message);
    }

    try {
        // Codex tavsiyesi #5: TTL 6h → 2h. Ban/kick sonrası eski token davranışı kısalır.
        // 1h yerine 2h seçildi — kullanıcı 1 saat içinde token expire olup deneyim bozulmasın diye dengeli.
        // (Çoğu kullanıcı 2h içinde odadan çıkar ve yeniden /getToken alır.)
        const token = new AccessToken(apiKey, apiSecret, {
            identity, name: identity, ttl: '2h',
        });
        // Sahnede başlayan kullanıcıya SADECE mikrofon izni — kamera için ayrıca /cam-grant gerekir
        // (cam_policy + max_cameras backend tarafında orada enforce edilir)
        // NOT: canPublishSources LiveKit TrackSource enum array bekler (string array DEĞİL)
        token.addGrant({
            roomJoin: true, room,
            canPublish,                                                   // dinleyici = false, konuşmacı = true
            canPublishSources: canPublish ? toTrackSources(['microphone']) : [], // mic-only — camera ayrı izin
            canSubscribe: true,
            canPublishData: true,                                          // chat için her zaman açık
        });
        const jwtTok = await token.toJwt();
        res.json({
            token: jwtTok,
            url: process.env.LIVEKIT_URL || 'ws://localhost:7880',
            room, identity,
            can_publish: canPublish,
            role_in_room: stageEntryReason,
        });
    } catch (err) {
        console.error('Token oluşturma hatası:', err);
        res.status(500).json({ success: false, error: 'Token oluşturulamadı: ' + err.message });
    }
});

// ============ Üye Oda Sistemi (Clubhouse tarzı) ============
// Üye yarattığı odalar — disk'te (yeniden başlatma sonrası kayıp olmasın)
const USER_ROOMS_FILE = path.join(__dirname, 'data', 'user_rooms.json');
async function loadUserRooms() {
    try {
        try { await fs.promises.access(USER_ROOMS_FILE); } catch { return []; }
        return JSON.parse(await fs.promises.readFile(USER_ROOMS_FILE, 'utf8'));
    } catch { return []; }
}
async function saveUserRooms(rooms) {
    try {
        await ensureDataDir();
        await atomicWriteJson(USER_ROOMS_FILE, rooms);
    } catch (e) { console.error('[USER_ROOMS] save fail:', e.message); }
}

// Bir kullanıcı odanın yetkili'si mi (host VEYA co-host listede)
// roomDef üye odası ise coHosts[] kontrolü; sistem odasında sadece def.host
function isRoomHost(roomDef, nick) {
    if (!roomDef || !nick) return false;
    const lo = nick.toLowerCase();
    if (roomDef.host && roomDef.host.toLowerCase() === lo) return true;
    if (Array.isArray(roomDef.coHosts) && roomDef.coHosts.some(n => (n || '').toLowerCase() === lo)) return true;
    return false;
}

// Oda-bazlı geçici ban listesi (host-kick + admin-kick ile eklenir, 1 saat sonra expire)
// Map<roomName, Map<nickLower, { ts, by, reason }>>
// PERSIST: data/room_bans.json — restart sonrası ban'lar kaybolmasın (Codex bulgu #6).
const _roomBans = new Map();
const ROOM_BAN_TTL_MS = 60 * 60 * 1000;
const ROOM_BANS_FILE = path.join(__dirname, 'data', 'room_bans.json');
// Init — disk'ten yükle (TTL geçenler atılır)
(() => {
    try {
        if (!fs.existsSync(ROOM_BANS_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ROOM_BANS_FILE, 'utf8'));
        const now = Date.now();
        for (const [roomName, entries] of Object.entries(raw || {})) {
            const m = new Map();
            for (const [nick, v] of Object.entries(entries || {})) {
                if (v && (now - v.ts) < ROOM_BAN_TTL_MS) m.set(nick, v);
            }
            if (m.size) _roomBans.set(roomName, m);
        }
        console.log(`[ROOM_BANS] ${_roomBans.size} oda ban listesi disk'ten yüklendi`);
    } catch (e) { console.warn('[ROOM_BANS] load fail:', e.message); }
})();
function _persistRoomBans() {
    try {
        if (_persistRoomBans._t) return; // debounce 2sn
        _persistRoomBans._t = setTimeout(async () => {
            _persistRoomBans._t = null;
            const out = {};
            for (const [roomName, m] of _roomBans.entries()) {
                if (!m.size) continue;
                out[roomName] = Object.fromEntries(m.entries());
            }
            try { await ensureDataDir(); } catch (e) { console.warn('[ROOM_BANS] ensureDataDir hatası:', e.message); }
            try { await atomicWriteJson(ROOM_BANS_FILE, out); } catch (e) { console.warn('[ROOM_BANS] save fail:', e.message); }
        }, 2000);
    } catch (e) { console.error('[ROOM_BANS] persistRoomBans hatası:', e); }
}
function isRoomBanned(roomName, nick) {
    const m = _roomBans.get(roomName);
    if (!m) return null;
    const v = m.get((nick || '').toLowerCase());
    if (!v) return null;
    if (Date.now() - v.ts > ROOM_BAN_TTL_MS) { m.delete((nick || '').toLowerCase()); _persistRoomBans(); return null; }
    return v;
}
function addRoomBan(roomName, nick, by, reason) {
    let m = _roomBans.get(roomName);
    if (!m) { m = new Map(); _roomBans.set(roomName, m); }
    m.set((nick || '').toLowerCase(), { ts: Date.now(), by, reason: reason || '' });
    _persistRoomBans();
}
function clearRoomBans(roomName) { _roomBans.delete(roomName); _persistRoomBans(); }

// ============ ODA TEMALARI (görsel palet) ============
// Her tema body[data-theme] üzerinden CSS variable override eder.
// classic = mevcut Win2000 mavi · sakir = Şakir'in Kahvesi (kırmızı/sarı/koyu) · gece = Gece Kulübü neon · pera = Pera Cafe krem/altın
const VALID_ROOM_THEMES = new Set(['classic', 'sakir']);

// ============ ODA KAMERA MODU OVERRIDE ============
// Kullanıcı oda yararken kategoriden bağımsız kamera kontrolü:
//   camera    → herkes kamera (cam_policy=speakers_only, max_cameras=8)
//   host_only → sadece host kamera (cam_policy=mod_only, max_cameras=2)
//   none      → kamerasız oda (max_cameras=0)
function applyCamMode(roomDef, mode) {
    if (mode === 'camera') {
        roomDef.cam_policy = 'speakers_only';
        roomDef.max_cameras = 8;
    } else if (mode === 'host_only') {
        roomDef.cam_policy = 'mod_only';
        roomDef.max_cameras = 2;
    } else if (mode === 'none') {
        roomDef.cam_policy = 'mod_only';   // önemsiz; max_cameras=0 → buton zaten görünmez
        roomDef.max_cameras = 0;
    }
}

// Yaş hesapla (birthYear → kullanıcı yaşı; eksikse null)
function calcAge(birthYear) {
    if (!birthYear || isNaN(birthYear)) return null;
    return new Date().getFullYear() - parseInt(birthYear);
}
function isAdult(birthYear) {
    const a = calcAge(birthYear);
    return a !== null && a >= 18;
}

// ============ MODERASYON AUDIT LOG ============
// Her host/admin kararı kaydedilir (kim/ne zaman/hangi odada/hangi kullanıcıya/neden).
// Son 1000 kayıt tutulur — daha eskisi append sırasında atılır.
// Admin paneli "Moderasyon Geçmişi" sekmesi GET /api/admin/mod-log ile okur.
const MOD_LOG_FILE = path.join(__dirname, 'data', 'mod_log.json');
const MOD_LOG_MAX = 1000;
let _modLog = (() => {
    try { return JSON.parse(fs.readFileSync(MOD_LOG_FILE, 'utf8')) || []; } catch { return []; }
})();
async function saveModLog() {
    try {
        await fs.promises.mkdir(path.dirname(MOD_LOG_FILE), { recursive: true });
        await atomicWriteJson(MOD_LOG_FILE, _modLog);
    } catch (e) { console.warn('[MOD-LOG] save fail:', e.message); }
}
function pushModLog({ action, room, by, target, reason, details }) {
    if (!action || !by) return;
    _modLog.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        action,                          // 'host-kick' | 'co-host-add' | 'co-host-remove' | 'settings-changed' | 'grant-stage' | 'revoke-stage' | 'admin-kick' | 'admin-mute' | 'admin-ban' | 'admin-room-delete'
        room: room || null,
        by,                              // moderator nick
        target: target || null,          // hedef nick (yoksa null)
        reason: reason ? String(reason).slice(0, 200) : '',
        details: details || null,        // ek bilgi (settings diff, mute süresi vb.)
    });
    if (_modLog.length > MOD_LOG_MAX) _modLog.length = MOD_LOG_MAX;
    // Sık çağrı için debounce: 2sn'de bir yaz
    if (!pushModLog._t) pushModLog._t = setTimeout(async () => { pushModLog._t = null; await saveModLog(); }, 2000);
}

// Oda kategorileri (frontend modal için aynı set) — VIP/premium yok, ücretsiz platform
const ROOM_CATEGORIES = {
    free:  { label: 'Sohbet',   icon: '💬', cap: 'mic',     defaultBadge: null },
    music: { label: 'Müzik',    icon: '🎵', cap: 'mic+dj',  defaultBadge: 'music' },
    cam:   { label: 'Kamera',   icon: '📹', cap: 'mic+cam', defaultBadge: 'cam' },
    hot:   { label: 'Gece',     icon: '🌙', cap: 'mic',     defaultBadge: null },
    book:  { label: 'Edebiyat', icon: '📚', cap: 'mic',     defaultBadge: 'new' },
    game:  { label: 'Oyun',     icon: '🎮', cap: 'mic',     defaultBadge: null },
};

// ============ Oda Tanımları (Sistem odaları — kalıcı JSON) ============
// data/system_rooms.json içinde yaşar — admin panelinden CRUD yapılır, restart hayatta kalır.
// İlk açılışta yoksa varsayılan setiyle başlatılır.
const SYSTEM_ROOMS_FILE = path.join(__dirname, 'data', 'system_rooms.json');
// Default oda ayarları — kategori bazlı matris
// mic_policy: 'open' = direkt mic aç | 'request' = söz iste | 'invite_only' = sadece host davet eder
// cam_policy: 'all' = herkes açar | 'speakers_only' = sahnede olanlar | 'mod_only' = sadece host/mod
// Kullanıcı dostu "kontrollü rahatlık" felsefesi (27 May revizyon):
// - Tüm odalarda mic_policy='request' (söz iste zorunlu)
// - cam: kamera odasında da serbest değil → speakers_only
// - Müzik odası 2 kamera (DJ + 1 mod) — 0 değil
// - auto_stage TRUE ama backend kontrolü: mod yoksa çalışır
const ROOM_PRESETS = {
    free:  { max_speakers: 6, max_cameras: 4,  mic_policy: 'request', cam_policy: 'speakers_only', auto_stage: true, speaker_time_limit: 300, silence_kick_seconds: 120, ai_level: 'standard' },
    music: { max_speakers: 4, max_cameras: 2,  mic_policy: 'request', cam_policy: 'mod_only',      auto_stage: true, speaker_time_limit: 0,   silence_kick_seconds: 0,   ai_level: 'standard' },
    cam:   { max_speakers: 8, max_cameras: 12, mic_policy: 'request', cam_policy: 'speakers_only', auto_stage: true, speaker_time_limit: 0,   silence_kick_seconds: 0,   ai_level: 'standard' },
    hot:   { max_speakers: 6, max_cameras: 6,  mic_policy: 'request', cam_policy: 'speakers_only', auto_stage: true, speaker_time_limit: 300, silence_kick_seconds: 120, ai_level: 'standard' },
    book:  { max_speakers: 4, max_cameras: 0,  mic_policy: 'request', cam_policy: 'mod_only',      auto_stage: true, speaker_time_limit: 600, silence_kick_seconds: 0,   ai_level: 'strict'   },
    game:  { max_speakers: 6, max_cameras: 4,  mic_policy: 'request', cam_policy: 'speakers_only', auto_stage: true, speaker_time_limit: 0,   silence_kick_seconds: 180, ai_level: 'standard' },
};
function applyPreset(room) {
    const preset = ROOM_PRESETS[room.category] || ROOM_PRESETS.free;
    // Sadece yoksa default ekle (varolan ayarları ezme)
    for (const key in preset) {
        if (room[key] === undefined) room[key] = preset[key];
    }
    return room;
}

const DEFAULT_SYSTEM_ROOMS = [
    applyPreset({ name: 'Genel Sohbet', max: 200, icon: '💬', category: 'free', badge: 'hot', desc: 'Her konuda serbest sohbet — yeni arkadaşlıklar burada başlıyor!' }),
    applyPreset({ name: 'Müzik Odası', max: 100, icon: '🎵', category: 'music', badge: 'music', desc: "DJ'ler çalıyor! İstek parça bırak, birlikte dinleyelim 🎧" }),
    applyPreset({ name: 'Kamera Odası 1', max: 30, icon: '📹', category: 'cam', badge: 'cam', desc: 'Yüz yüze sohbet — kameranı aç, tanışalım!' }),
    applyPreset({ name: 'Gece Kulübü', max: 50, icon: '🌙', category: 'hot', badge: null, desc: 'Gece kuşları burada — eğlence durmuyor!' }),
    applyPreset({ name: 'Rock & Metal', max: 60, icon: '🎸', category: 'music', badge: 'music', desc: 'Ağır riffler, klasik rock — sahnede sen varsın! 🤘', speaker_time_limit: 600 }),
    applyPreset({ name: 'Kamera Odası 2', max: 30, icon: '🎥', category: 'cam', badge: 'cam', desc: 'Serbest kamera odası — gel, sohbete katıl!' }),
    applyPreset({ name: 'Nostalji Köşesi', max: 80, icon: '📻', category: 'free', badge: 'new', desc: "2000'lerin altın çağını yeniden yaşa — eski günleri konuşalım!", max_speakers: 4 }),
];
async function loadSystemRooms() {
    try {
        await fs.promises.mkdir(path.dirname(SYSTEM_ROOMS_FILE), { recursive: true });
        try { await fs.promises.access(SYSTEM_ROOMS_FILE); } catch {
            await fs.promises.writeFile(SYSTEM_ROOMS_FILE, JSON.stringify(DEFAULT_SYSTEM_ROOMS, null, 2), 'utf8');
            console.log('[SYSTEM_ROOMS] İlk açılış — system_rooms.json oluşturuldu');
            return [...DEFAULT_SYSTEM_ROOMS];
        }
        const rooms = JSON.parse(await fs.promises.readFile(SYSTEM_ROOMS_FILE, 'utf8'));
        // MIGRATION: eski oda kayıtlarına yeni ayar field'larını lazy ekle
        let migrated = 0;
        rooms.forEach(r => {
            const before = JSON.stringify(r);
            applyPreset(r);
            if (JSON.stringify(r) !== before) migrated++;
        });
        // BIR-KERELIK FIX (27 May 2026): Nostalji Köşesi max_speakers kod niyetiyle senkron.
        // Eski seed'de free preset'inden 6 atanmış kalmış; istenen değer 4.
        const nostalji = rooms.find(r => r.name === 'Nostalji Köşesi');
        if (nostalji && nostalji.max_speakers !== 4) {
            console.log(`[SYSTEM_ROOMS] Nostalji Köşesi max_speakers ${nostalji.max_speakers} → 4 (kod niyetiyle senkron)`);
            nostalji.max_speakers = 4;
            migrated++;
        }
        if (migrated > 0) {
            console.log(`[SYSTEM_ROOMS] ${migrated} oda yeni ayar şemasıyla güncellendi`);
            try { await atomicWriteJson(SYSTEM_ROOMS_FILE, rooms); } catch (e) { console.error('[SYSTEM_ROOMS] migration write hatası:', e.message); }
        }
        return rooms;
    } catch (err) {
        console.error('[SYSTEM_ROOMS] load fail, defaults kullanılıyor:', err.message);
        return [...DEFAULT_SYSTEM_ROOMS];
    }
}
async function saveSystemRooms(rooms) {
    try {
        await fs.promises.mkdir(path.dirname(SYSTEM_ROOMS_FILE), { recursive: true });
        await atomicWriteJson(SYSTEM_ROOMS_FILE, rooms);
    } catch (e) {
        console.error('[SYSTEM_ROOMS] save fail:', e.message);
    }
}
let ROOM_DEFS = [...DEFAULT_SYSTEM_ROOMS];
(async () => { ROOM_DEFS = await loadSystemRooms(); })();

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

    // Üye odalarını sisteme dahil et
    const userRooms = await loadUserRooms();
    const allDefs = [
        ...ROOM_DEFS.map(d => ({ ...d, isUserRoom: false })),
        ...userRooms.map(d => ({ ...d, isUserRoom: true })),
    ];

    const svc = getRoomServiceClient();
    if (!svc) {
        return allDefs.map(r => ({ ...r, participants: 0, users: [] }));
    }

    try {
        const liveRooms = await svc.listRooms();
        const liveMap = new Map();

        // ★ PERFORMANS FIX (28 May 2026): Her odanın katılımcılarını PARALEL çek.
        // Eski hali seri for-loop idi → 20 oda × ~200ms = 4sn bekleme.
        // Promise.all ile paralel → toplam ~200-400ms.
        await Promise.all(liveRooms.map(async (lr) => {
            try {
                const participants = await svc.listParticipants(lr.name);
                liveMap.set(lr.name, {
                    count: lr.numParticipants,
                    users: participants.map(p => p.identity)
                });
            } catch (e) {
                liveMap.set(lr.name, { count: lr.numParticipants, users: [] });
            }
        }));

        // Oda tanımlarını LiveKit verileriyle birleştir
        const result = allDefs.map(def => {
            const live = liveMap.get(def.name) || { count: 0, users: [] };
            return {
                name: def.name,
                max: def.max,
                icon: def.icon,
                category: def.category,
                badge: def.badge,
                desc: def.desc,
                isUserRoom: def.isUserRoom || false,
                host: def.host || null,
                createdAt: def.createdAt || null,
                participants: live.count,
                users: live.users,
                isFull: live.count >= def.max,
                access: def.access || 'public',                  // public/password/invite/friends
                // passwordHash ve invitedNicks ASLA leak etme — sadece access mode
                theme: def.theme || 'classic',                  // oda görsel teması (classic/sakir/gece/pera)
                // Oda kuralları (lobby kartında küçük ikon olarak gösterilir)
                settings: {
                    max_speakers: (def.max_speakers ?? 6),
                    max_cameras: def.max_cameras || 0,
                    mic_policy: def.mic_policy || 'request',
                    cam_policy: def.cam_policy || 'speakers_only',
                },
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

// ============ Cold-start Botlar (RUH widget'ları) ============
// Sürekli online görünen "ev sahibi" botlar — oda boş izlenimini kırar.
// LiveKit'e gerçek bağlanmıyor; sadece /api/rooms response'da synthetic users.
//
// ŞARTLI: Bir odada toplam GERÇEK kullanıcı sayısı BOT_HIDE_THRESHOLD'a ulaşırsa
// botlar O ODADA gizlenir — gerçek kullanıcı yeteri kadar varsa sahte bot
// fazlalık yapmasın. Hâlâ "DJ_RetroBot" Müzik Odası'nda radyonun sembolü olarak
// kalır (cold-start dışında bile mantıklı: AI host gibi davranıyor).
const HOUSE_BOTS = [
    { nick: 'DJ_RetroBot', room: 'Müzik Odası', role: 'host', emoji: '🎧', alwaysShow: true /* radyo sembolü */ },
    { nick: 'RetroHost',   room: 'Genel Sohbet', role: 'host', emoji: '🎙️', alwaysShow: false },
    { nick: 'NostaljiAna', room: 'Nostalji Köşesi', role: 'host', emoji: '📻', alwaysShow: false },
];
const BOT_HIDE_THRESHOLD = 3; // 3+ gerçek kullanıcı varsa "alwaysShow:false" botlar gizlenir

// ============ Aktivite Feed (in-memory ring buffer) ============
const ACTIVITY_FEED = [];
const ACTIVITY_MAX = 12;
function pushActivity(text, icon) {
    ACTIVITY_FEED.unshift({ text, icon: icon || '•', ts: Date.now() });
    if (ACTIVITY_FEED.length > ACTIVITY_MAX) ACTIVITY_FEED.pop();
}
// Açılışta sahte mesaj yok — gerçek kullanıcı aktivitesi feed'i doldursun.
// Eskiden 3 hardcoded mesaj vardı, gerçekçi olmayan bir doluluk hissi yaratıyordu.

// Şarkı değişimini takip et — değişince aktivite ekle
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
// İlk çağrı + periyodik (1dk) — getRadioNowPlaying playlist yüklendikten sonra çalışacak,
// setInterval ile en geç 60sn'de bir şarkı değişimi yakalanır.
setInterval(refreshRadioActivity, 60_000);
// İlk tetik 5sn sonra (playlist init garantile)
setTimeout(refreshRadioActivity, 5_000);

// ============ API Endpoints ============
app.get('/api/rooms', async (req, res) => {
    try {
        const baseRooms = await fetchRoomData();
        // ÖNEMLİ: fetchRoomData 5sn cache'liyor; bot inject'i CACHE'i mutate ETMESİN.
        // Her response için yeni dizi + yeni users array klonu üret.
        const rooms = baseRooms.map(r => ({
            ...r,
            users: Array.isArray(r.users) ? [...r.users] : [],
        }));
        // House bot'ları her odaya inject et — ŞARTLI:
        // Gerçek kullanıcı 3+ olunca alwaysShow:false olanları gizle.
        for (const room of rooms) {
            const realCount = room.participants || 0;
            const allBots = HOUSE_BOTS.filter(b => b.room === room.name);
            const visibleBots = realCount >= BOT_HIDE_THRESHOLD
                ? allBots.filter(b => b.alwaysShow)
                : allBots;
            if (visibleBots.length) {
                room.users = [...visibleBots.map(b => b.nick), ...room.users];
                room.participants = realCount + visibleBots.length;
                room.hasBot = true;
            }
        }
        const totalOnline = rooms.reduce((sum, r) => sum + r.participants, 0);
        const allUsers = rooms.flatMap(r => r.users);
        res.json({ rooms, totalOnline, allUsers });
    } catch (err) {
        console.error('[API] /api/rooms hatası:', err);
        res.status(500).json({ success: false, error: 'Oda verisi alınamadı' });
    }
});

// Son aktivite feed (anasayfa sidebar widget'ı için)
app.get('/api/activity', async (req, res) => {
    res.json({ success: true, items: ACTIVITY_FEED });
});

// ============ DISCOVER (Keşfet sekmesi) ============
// Trending rooms (en kalabalık), yeni üyeler (son 24sa), aktif hostlar (çok oda açan).
// Misafirler de görebilir; auth opsiyonel.
app.get('/api/discover', async (req, res) => {
    try {
        // 1) Trend Odalar — en kalabalık ilk 5 (gerçek participant sayısına göre)
        const baseRooms = await fetchRoomData();
        const trending = baseRooms
            .slice()
            .sort((a, b) => (b.participants || 0) - (a.participants || 0))
            .slice(0, 5)
            .map(r => ({
                name: r.name, icon: r.icon || '💬',
                category: r.category || 'free',
                participants: r.participants || 0,
                max: r.max || 50,
                host: r.host || null,
                desc: r.desc || '',
            }));

        // 2) Yeni Üyeler — son 24sa kayıt (max 10)
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const users = await loadUsers();
        const newUsers = users
            .filter(u => u.createdAt && new Date(u.createdAt).getTime() > dayAgo)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10)
            .map(u => ({
                nick: u.nick,
                createdAt: u.createdAt,
                avatar: u.avatar || null,
                bio: (u.bio || '').slice(0, 60),
            }));

        // 3) Aktif Hostlar — en çok oda açan ilk 6
        const userRooms = await loadUserRooms();
        const hostStats = {};
        for (const r of userRooms) {
            if (!r.host) continue;
            hostStats[r.host] = hostStats[r.host] || { nick: r.host, roomCount: 0, totalCapacity: 0 };
            hostStats[r.host].roomCount++;
            hostStats[r.host].totalCapacity += (r.max || 0);
        }
        const topHosts = Object.values(hostStats)
            .sort((a, b) => b.roomCount - a.roomCount)
            .slice(0, 6);

        res.json({ success: true, trending, newUsers, topHosts });
    } catch (err) {
        console.error('[API] /api/discover hatası:', err);
        res.status(500).json({ success: false, error: 'Keşfet verisi alınamadı' });
    }
});

// ============ AI / Otomatik Moderasyon ============
// Frontend chat send sonrası paralel çağırır.
// Suç tespit edilirse → RetroModBot Data Channel broadcast (LiveKit room)
const MOD_BOT_IDENTITY = 'RetroModBot';
async function broadcastModBot(roomName, msg) {
    const svc = getRoomServiceClient();
    if (!svc) return;
    try {
        const payload = Buffer.from(JSON.stringify({
            type: 'mod_bot',
            from: MOD_BOT_IDENTITY,
            text: msg,
            ts: Date.now(),
        }));
        // LiveKit Server SDK — odadaki herkese reliable data gönder
        await svc.sendData(roomName, payload, /* DataPacket_Kind.RELIABLE */ 0);
    } catch (err) {
        console.warn('[Moderation] Bot broadcast hatası:', err.message);
    }
}

// AI moderasyon — LiveKit kick + bans.json yazımı
async function aiKickFromRoom(room, nick, reason) {
    const svc = getRoomServiceClient();
    if (!svc) return;
    try {
        await svc.removeParticipant(room, nick);
        console.log(`[AI-MOD] ${nick} kick from ${room} — ${reason}`);
    } catch (err) {
        console.warn('[AI-MOD] kick hatası:', err.message);
    }
}
async function aiBanUser(nick, durationMs, reason, category) {
    // bans.json'a yaz
    try {
        const bans = (typeof loadBans === 'function') ? loadBans() : [];
        const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
        const idx = bans.findIndex(b => b.nick && b.nick.toLowerCase() === nick.toLowerCase());
        if (idx >= 0) bans.splice(idx, 1);
        bans.push({
            nick,
            reason: `[AI:${category || 'auto'}] ${reason || 'Otomatik moderasyon'}`,
            bannedBy: 'RetroModBot',
            bannedAt: new Date().toISOString(),
            expiresAt,
        });
        await saveBans(bans);
        console.log(`[AI-MOD] BAN ${nick} — exp=${expiresAt || 'PERM'} — ${reason}`);
        // Bildirim — banlanan kişiye
        pushNotificationByNick(nick, 'ban_warn', {
            title: `⛔ Yasaklandın`,
            body: `Sebep: ${reason || 'Kural ihlali'}${expiresAt ? ' — Bitiş: ' + new Date(expiresAt).toLocaleString('tr-TR') : ' — Kalıcı yasak'}`,
            link: null,
            from: 'RetroModBot',
        });
    } catch (err) {
        console.warn('[AI-MOD] ban yazım hatası:', err.message);
    }
    // Tüm odalardan at
    const svc = getRoomServiceClient();
    if (svc) {
        try {
            const live = await svc.listRooms();
            for (const r of live) {
                try { await svc.removeParticipant(r.name, nick); } catch (e) { console.error('[AI-MOD] removeParticipant hatası:', r.name, e.message); }
            }
        } catch (e) { console.error('[AI-MOD] listRooms hatası:', e.message); }
    }
}

app.post('/api/chat/moderate', chatModerateLimiter, requireAuth, async (req, res) => {
    const { room, text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'text gerekli' });
    const nick = req.user.nick;
    // Host chat-mute kontrolü — sustur edilmişse mesaj engellenir
    if (room) {
        const mute = isChatMuted(room, nick);
        if (mute) {
            const minsLeft = mute.until ? Math.ceil((mute.until - Date.now()) / 60000) : null;
            return res.json({
                success: true, blocked: true, safe: false,
                action: 'silenced',
                reason: `Host seni ${minsLeft ? minsLeft + ' dk daha ' : ''}susturdu.${mute.reason ? ' Sebep: ' + mute.reason : ''}`,
            });
        }
    }
    // Odaya özgü AI seviyesi (admin panelden ayarlanır): off | standard | strict
    const roomDef = room ? await findRoomDef(room) : null;
    const aiLevel = roomDef?.ai_level || 'standard';
    const result = await Moderation.moderateMessage({ nick, text, room, aiLevel });

    // Codex tavsiyesi #3: Önleyici moderasyon — küfür/spam/taci içeren mesaj ODAYA HİÇ GİTMESİN.
    // Frontend bu response'taki `blocked: true`'yu görünce publishData yapmaz, kullanıcıya toast gösterir.
    // 'gentle_warn' (CAPS lock gibi non-içerik uyarı) ve safe=true mesajlar geçer.
    const BLOCK_ACTIONS = new Set(['silenced', 'warn', 'final_warn', 'mute_5m', 'mute_15m', 'mute_1h', 'kick', 'ban_24h', 'ban_perm']);
    const blocked = !result.safe && BLOCK_ACTIONS.has(result.action);

    // Otomatik aksiyon — odaya RetroModBot mesajı + gerçek enforce
    if (!result.safe) {
        switch (result.action) {
            case 'silenced':
                // sessiz — zaten muted
                break;
            case 'gentle_warn':
                // Caps lock — sadece frontend toast
                break;
            case 'warn':
                if (room) broadcastModBot(room, `⚠️ @${nick} dikkat — ${result.reason} (uyarı ${result.strikes}/3)`);
                break;
            case 'final_warn':
                if (room) broadcastModBot(room, `⚠️ @${nick} SON UYARI — bir daha olursa susturma. (${result.reason})`);
                break;
            case 'mute_5m':
                if (room) broadcastModBot(room, `🔇 @${nick} 5 dakika susturuldu — tekrar uyarıldı.`);
                break;
            case 'mute_15m':
                if (room) broadcastModBot(room, `🔇 @${nick} 15 dakika susturuldu. (${result.reason})`);
                break;
            case 'mute_1h':
                if (room) broadcastModBot(room, `🔇 @${nick} 1 saat susturuldu — ağır kural ihlali. (${result.reason})`);
                break;
            case 'kick':
                if (room) {
                    broadcastModBot(room, `🚪 @${nick} odadan çıkarıldı — ${result.reason}`);
                    // 1sn bekle → kullanıcı toast'ı görsün, sonra at
                    setTimeout(() => aiKickFromRoom(room, nick, result.reason), 1000);
                }
                break;
            case 'ban_24h':
                if (room) broadcastModBot(room, `⛔ @${nick} 24 saat yasaklandı — ${result.reason}`);
                setTimeout(() => aiBanUser(nick, 24 * 60 * 60 * 1000, result.reason, result.category), 1000);
                break;
            case 'ban_perm':
                if (room) broadcastModBot(room, `⛔ @${nick} kalıcı olarak yasaklandı — ${result.reason}`);
                setTimeout(() => aiBanUser(nick, null, result.reason, result.category), 1000);
                break;
        }
    }
    res.json({ success: true, ...result, blocked });
});

// ============ Kullanıcı Raporu (🚨 Bildir — ses + kamera analizi) ============
// Rate-limit: kullanıcı başına saatte 10 rapor, aynı hedefe 5 dakikada 1 rapor
const _reportHistory = new Map(); // reporterNick → [{ts, target}]
// Son 100 rapor — admin görsün diye
// PERSIST: data/reports.json — restart-safe (Codex bulgu #7)
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.json');
const _reportLog = (() => {
    try {
        if (!fs.existsSync(REPORTS_FILE)) return [];
        return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')) || [];
    } catch { return []; }
})();
function _persistReportLog() {
    try {
        if (_persistReportLog._t) return; // debounce 2sn
        _persistReportLog._t = setTimeout(async () => {
            _persistReportLog._t = null;
            try { await ensureDataDir(); } catch (e) { console.warn('[REPORTS] ensureDataDir hatası:', e.message); }
            try { await atomicWriteJson(REPORTS_FILE, _reportLog); } catch (e) { console.warn('[REPORTS] save fail:', e.message); }
        }, 2000);
    } catch (e) { console.error('[REPORTS] persistReports hatası:', e); }
}
function checkReportRate(reporter, target) {
    const now = Date.now();
    const hist = (_reportHistory.get(reporter) || []).filter(r => now - r.ts < 60 * 60 * 1000);
    if (hist.length >= 10) return { ok: false, reason: 'Saatte en fazla 10 rapor yapabilirsin.' };
    const recentSame = hist.find(r => r.target === target && now - r.ts < 5 * 60 * 1000);
    if (recentSame) return { ok: false, reason: 'Aynı kişiyi 5 dakikada 1 kez bildirebilirsin.' };
    hist.push({ ts: now, target });
    _reportHistory.set(reporter, hist);
    return { ok: true };
}

// AI moderasyon — rapor sonucu aksiyon uygula (kick/ban/mute)
async function applyReportAction(target, room, aiResult) {
    if (!aiResult || aiResult.action === 'none' || aiResult.action === 'warn') return;
    const reason = aiResult.reason || 'AI moderasyon';
    const transcript = aiResult.transcript ? ` ("${aiResult.transcript.slice(0, 60)}")` : '';
    switch (aiResult.action) {
        case 'mute_15m':
            Moderation.forceMute(target, 'mute_15m');
            if (room) broadcastModBot(room, `🔇 @${target} 15 dakika susturuldu — ${reason}${transcript}`);
            break;
        case 'mute_1h':
            Moderation.forceMute(target, 'mute_1h');
            if (room) broadcastModBot(room, `🔇 @${target} 1 saat susturuldu — ${reason}${transcript}`);
            break;
        case 'kick':
            if (room) {
                broadcastModBot(room, `🚪 @${target} odadan çıkarıldı — ${reason}${transcript}`);
                setTimeout(() => aiKickFromRoom(room, target, reason), 1000);
            }
            break;
        case 'ban_24h':
            if (room) broadcastModBot(room, `⛔ @${target} 24 saat yasaklandı — ${reason}${transcript}`);
            setTimeout(() => aiBanUser(target, 24 * 60 * 60 * 1000, reason, aiResult.category), 1000);
            break;
        case 'ban_perm':
            if (room) broadcastModBot(room, `⛔ @${target} kalıcı yasaklandı — ${reason}${transcript}`);
            setTimeout(() => aiBanUser(target, null, reason, aiResult.category), 1000);
            break;
    }
}

app.post('/api/report-user', reportLimiter, requireAuth, async (req, res) => {
    const reporter = req.user.nick;
    const { reported, room, reason, audio, audioMime, image, imageMime } = req.body;
    if (!reported || typeof reported !== 'string') {
        return res.status(400).json({ success: false, error: 'reported (kullanıcı nick) gerekli.' });
    }
    if (reported.toLowerCase() === reporter.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini bildiremezsin.' });
    }
    if (!audio && !image) {
        return res.status(400).json({ success: false, error: 'Ses veya görüntü kanıtı gerekli.' });
    }
    // Rate limit
    const rl = checkReportRate(reporter, reported);
    if (!rl.ok) {
        return res.status(429).json({ success: false, error: rl.reason });
    }
    // Boyut kontrolü — base64 string olarak gelir
    const audioSize = audio ? audio.length : 0;
    const imageSize = image ? image.length : 0;
    if (audioSize > 1_500_000 || imageSize > 1_000_000) {
        return res.status(413).json({ success: false, error: 'Kanıt boyutu çok büyük.' });
    }

    console.log(`[REPORT] ${reporter} → ${reported} (sebep: ${reason || 'belirtilmedi'}, ses:${audioSize}B, görsel:${imageSize}B)`);

    // Gemini multimodal analiz
    const aiResult = await Moderation.analyzeReport({
        audioB64: audio || null,
        audioMime: audioMime || 'audio/webm',
        imageB64: image || null,
        imageMime: imageMime || 'image/jpeg',
        reporter,
        reported,
        reason,
    });

    // Logla — admin paneli görür
    _reportLog.unshift({
        ts: new Date().toISOString(),
        reporter, reported, room, reason,
        ai: aiResult ? { action: aiResult.action, severity: aiResult.severity, reason: aiResult.reason, category: aiResult.category, transcript: aiResult.transcript } : null,
    });
    if (_reportLog.length > 100) _reportLog.length = 100;
    _persistReportLog();

    // Aksiyon uygula
    if (aiResult && !aiResult.safe) {
        await applyReportAction(reported, room, aiResult);
    }

    res.json({
        success: true,
        action: aiResult?.action || 'none',
        severity: aiResult?.severity || 0,
        reason: aiResult?.reason || 'AI temiz buldu',
        transcript: aiResult?.transcript || '',
    });
});

// Admin: son raporlar (auditing için)
app.get('/api/admin/reports', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    res.json({ success: true, reports: _reportLog });
});

// Admin: tüm üye odaları (user_rooms) — host bilgisiyle birlikte
app.get('/api/admin/user-rooms', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const rooms = (await loadUserRooms()).map(({ passwordHash, ...r }) => r); // hash leak etme
    res.json({ success: true, rooms });
});

// Admin: bir üye odasını zorla sil (her hangi bir host odasını silebilir)
app.delete('/api/admin/user-rooms/:name', requireAuth, requireRole('admin'), async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const rooms = await loadUserRooms();
    const idx = rooms.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı' });
    const room = rooms[idx];
    rooms.splice(idx, 1);
    await saveUserRooms(rooms);
    roomCache.ts = 0;
    const svc = getRoomServiceClient();
    if (svc) { svc.deleteRoom(name).catch((e) => { console.warn('[ADMIN] deleteRoom hatası:', name, e.message); }); }
    console.log(`[ADMIN] Üye odası zorla silindi: ${name} (host: ${room.host}, by ${req.user.nick})`);
    pushModLog({ action: 'admin-room-delete', room: name, by: req.user.nick, target: room.host || null, details: { type: 'user-room' } });
    res.json({ success: true });
});

// Admin: bir odadaki canlı katılımcı listesi (kick için)
app.get('/api/admin/room/:name/participants', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    try {
        const parts = await svc.listParticipants(name);
        res.json({
            success: true,
            room: name,
            participants: parts.map(p => ({
                identity: p.identity,
                name: p.name,
                state: p.state,
                joinedAt: p.joinedAt ? new Date(Number(p.joinedAt) * 1000).toISOString() : null,
                audioTracks: p.tracks.filter(t => t.type === 1).length,
                videoTracks: p.tracks.filter(t => t.type === 2).length,
                isPublisher: p.permission?.canPublish || false,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: tek raporu sil (gözden geçirilmiş olanları temizlemek için)
app.delete('/api/admin/reports/:index', requireAuth, requireRole('admin'), async (req, res) => {
    const i = parseInt(req.params.index);
    if (isNaN(i) || i < 0 || i >= _reportLog.length) {
        return res.status(404).json({ success: false, error: 'Rapor yok' });
    }
    _reportLog.splice(i, 1);
    _persistReportLog();
    res.json({ success: true });
});

// ============ Üye Oda Oluşturma (Clubhouse tarzı) ============
// Kategoriler frontend'e bilgi olsun diye
app.get('/api/rooms/categories', async (req, res) => {
    res.json({ success: true, categories: ROOM_CATEGORIES });
});

// Yeni oda oluştur — auth gerektirir, misafir HARİÇ
app.post('/api/rooms/create', roomCreateLimiter, requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler oda açamaz — önce kayıt ol.' });
    }
    const { name, category, max, desc, access, password, invitedNicks, is_18_plus, theme, cam_mode } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 40) {
        return res.status(400).json({ success: false, error: 'Oda adı 3-40 karakter olmalı.' });
    }
    const cleanName = name.trim();
    if (!ROOM_CATEGORIES[category]) {
        return res.status(400).json({ success: false, error: 'Geçersiz kategori.' });
    }
    const maxNum = parseInt(max);
    if (isNaN(maxNum) || maxNum < 4 || maxNum > 50) {
        return res.status(400).json({ success: false, error: 'Kapasite 4-50 arası olmalı.' });
    }
    // Access mode kontrolü
    const validAccess = ['public', 'password', 'invite', 'friends'];
    const accessMode = validAccess.includes(access) ? access : 'public';
    let passwordHash = null;
    let invitedList = [];
    if (accessMode === 'password') {
        if (!password || typeof password !== 'string' || password.length < 3 || password.length > 32) {
            return res.status(400).json({ success: false, error: 'Şifre 3-32 karakter olmalı.' });
        }
        passwordHash = await bcrypt.hash(password, 10);
    } else if (accessMode === 'invite') {
        if (!Array.isArray(invitedNicks) || invitedNicks.length === 0) {
            return res.status(400).json({ success: false, error: 'Davetli mod için en az 1 nick gerekli.' });
        }
        // Nick'leri temizle + lowercase + duplicate çıkar — max 30
        invitedList = [...new Set(invitedNicks
            .filter(n => typeof n === 'string')
            .map(n => n.trim().toLowerCase())
            .filter(n => n.length >= 2 && n.length <= 30)
        )].slice(0, 30);
        if (invitedList.length === 0) {
            return res.status(400).json({ success: false, error: 'Geçerli nick listesi gerekli.' });
        }
    }
    // 'friends' modu için ekstra param gerekmez — host'un friends.json listesi kullanılır

    // Aynı isimde varsa
    const existing = ROOM_DEFS.find(r => r.name.toLowerCase() === cleanName.toLowerCase())
                  || (await loadUserRooms()).find(r => r.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
        return res.status(409).json({ success: false, error: 'Bu isimde oda zaten var.' });
    }
    // Bir kullanıcı aynı anda en fazla 2 aktif oda
    const myActive = (await loadUserRooms()).filter(r => r.hostId === req.user.id).length;
    if (myActive >= 2) {
        return res.status(429).json({ success: false, error: 'En fazla 2 aktif oda — bir önceki odanı kapat.' });
    }
    // +18 oda açıyor → host'un kendisi de 18+ olmalı
    if (is_18_plus) {
        const hostUser = (await loadUsers()).find(u => u.id === req.user.id);
        if (!isAdult(hostUser?.birthYear)) {
            return res.status(403).json({ success: false, error: '+18 oda açabilmek için 18 yaşından büyük olmalısın.' });
        }
    }
    const cat = ROOM_CATEGORIES[category];
    const safeTheme = (theme && VALID_ROOM_THEMES.has(theme)) ? theme : 'classic';
    const newRoom = applyPreset({
        name: cleanName,
        max: maxNum,
        icon: cat.icon,
        category,
        badge: cat.defaultBadge || 'new',
        desc: (desc || `${req.user.nick} odası — ${cat.label.toLowerCase()}`).slice(0, 120),
        host: req.user.nick,
        hostId: req.user.id,
        createdAt: new Date().toISOString(),
        access: accessMode,                     // 'public' | 'password' | 'invite' | 'friends'
        passwordHash,                            // null veya bcrypt hash
        invitedNicks: invitedList,               // lowercase nick listesi (invite modu için)
        coHosts: [],                             // host'un atadığı yardımcı mod nick'leri (max 2)
        is_18_plus: !!is_18_plus,                // +18 oda işareti (yetişkin içerik / yaş guard)
        theme: safeTheme,                        // görsel tema slug
    });
    // Kamera modu override — kullanıcı kategori preset'inden farklı isterse
    if (cam_mode && ['camera','host_only','none'].includes(cam_mode)) {
        applyCamMode(newRoom, cam_mode);
    }
    const rooms = await loadUserRooms();
    rooms.push(newRoom);
    await saveUserRooms(rooms);
    roomCache.ts = 0; // cache invalidate
    const accessLabel = { public: 'açık', password: '🔒 şifreli', invite: '📨 davetli', friends: '👥 arkadaşlar' }[accessMode];
    console.log(`[ROOM] Üye oda açıldı: ${cleanName} (host: ${req.user.nick}, ${accessLabel})`);
    try { pushActivity(`${req.user.nick} yeni oda açtı: ${cat.icon} ${cleanName}`, '🚪'); } catch (e) { console.warn('[ROOM] pushActivity hatası:', e.message); }
    // Client'a passwordHash dönme — sadece access mode dön
    const { passwordHash: _, ...safeRoom } = newRoom;
    res.json({ success: true, room: safeRoom });
});

// Üye odasını kapat (sadece host)
app.delete('/api/rooms/:name', requireAuth, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const rooms = await loadUserRooms();
    const idx = rooms.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı.' });
    const room = rooms[idx];
    if (room.hostId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Bu oda senin değil.' });
    }
    rooms.splice(idx, 1);
    await saveUserRooms(rooms);
    roomCache.ts = 0;
    clearRoomBans(name);  // oda gitti, ban listesi de gitsin
    // LiveKit odasını da temizle
    const svc = getRoomServiceClient();
    if (svc) { svc.deleteRoom(name).catch((e) => { console.warn('[ROOM] deleteRoom hatası:', name, e.message); }); }
    console.log(`[ROOM] Oda kapatıldı: ${name}`);
    res.json({ success: true });
});

// ============ HOST MODERASYON: At + Co-host + Ayar düzenleme ============
// #1 Host-Kick: host VEYA co-host VEYA admin/mod birini odadan 1 saatliğine atar
app.post('/api/room/:name/host-kick', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity, reason } = req.body || {};
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) {
        return res.status(403).json({ success: false, error: 'Sadece oda host\'u veya admin atabilir.' });
    }
    // Kendini atamak yasak
    if (identity.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini atamazsın.' });
    }
    // Host'u co-host atayamaz
    if (def.host && def.host.toLowerCase() === identity.toLowerCase() && !isStaff) {
        return res.status(403).json({ success: false, error: 'Host\'u atamazsın.' });
    }
    // Stage'den de çıkar
    const stage = getRoomStage(roomName);
    if (stage.speakers[identity]) {
        delete stage.speakers[identity];
        _persistStages();
        try { await updateLiveKitPermission(roomName, identity, false); } catch (e) { console.error('[HOST-KICK] updateLiveKitPermission hatası:', e.message); }
    }
    // LiveKit'ten at
    const svc = getRoomServiceClient();
    if (svc) {
        try { await svc.removeParticipant(roomName, identity); } catch (e) { /* kullanıcı zaten yoksa OK */ }
    }
    // Ban listesi (1 saat)
    addRoomBan(roomName, identity, req.user.nick, String(reason || '').slice(0, 100));
    pushModLog({ action: 'host-kick', room: roomName, by: req.user.nick, target: identity, reason });
    console.log(`[HOST-KICK] ${identity} 1 saatliğine atıldı: ${roomName} (by ${req.user.nick}, sebep: ${reason || '-'})`);
    // Atılana bildirim (cihazda görmesi için)
    try {
        const u = (await loadUsers()).find(x => x.nick.toLowerCase() === identity.toLowerCase());
        if (u) await pushNotification(u.id, 'room_kick', {
            title: `🚪 Odadan çıkarıldın`,
            body: `"${roomName}" odasının yönetimi seni 1 saatliğine uzaklaştırdı.${reason ? ' Sebep: ' + reason : ''}`,
            from: req.user.nick,
        });
    } catch (e) { console.error('[HOST-KICK] Bildirim gönderme hatası:', e.message); }
    res.json({ success: true, banUntilTs: Date.now() + ROOM_BAN_TTL_MS });
});

// #3 Co-host atama (sadece HOST yapabilir, max 2 co-host)
app.post('/api/room/:name/co-host', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { nick, action } = req.body || {};
    if (!nick || !['add', 'remove'].includes(action)) {
        return res.status(400).json({ success: false, error: 'nick ve action (add/remove) gerekli' });
    }
    const rooms = await loadUserRooms();
    const idx = rooms.findIndex(r => r.name === roomName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Üye odası değil' });
    const room = rooms[idx];
    // Sadece ASIL host (co-host bile değil) atayabilir
    if (room.hostId !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Sadece oda kurucusu co-host atayabilir.' });
    }
    if (!Array.isArray(room.coHosts)) room.coHosts = [];
    const targetLc = nick.toLowerCase();
    if (targetLc === (room.host || '').toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Host zaten kendisi, co-host atayamazsın.' });
    }
    if (action === 'add') {
        if (room.coHosts.some(n => (n || '').toLowerCase() === targetLc)) {
            return res.status(409).json({ success: false, error: 'Zaten co-host.' });
        }
        if (room.coHosts.length >= 2) {
            return res.status(429).json({ success: false, error: 'En fazla 2 co-host atayabilirsin.' });
        }
        room.coHosts.push(nick);
        try {
            const u = (await loadUsers()).find(x => x.nick.toLowerCase() === targetLc);
            if (u) await pushNotification(u.id, 'system', {
                title: '👑 Co-host yapıldın',
                body: `"${roomName}" odasında ${req.user.nick} seni yardımcı yönetici (co-host) yaptı.`,
                link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(nick),
                from: req.user.nick,
            });
        } catch (e) { console.error('[CO-HOST] Bildirim gönderme hatası:', e.message); }
    } else {
        const i = room.coHosts.findIndex(n => (n || '').toLowerCase() === targetLc);
        if (i < 0) return res.status(404).json({ success: false, error: 'Co-host değil.' });
        room.coHosts.splice(i, 1);
    }
    await saveUserRooms(rooms);
    roomCache.ts = 0;
    pushModLog({ action: action === 'add' ? 'co-host-add' : 'co-host-remove', room: roomName, by: req.user.nick, target: nick });
    console.log(`[CO-HOST] ${action}: ${nick} (oda: ${roomName}, by ${req.user.nick})`);
    res.json({ success: true, coHosts: room.coHosts });
});

// ============ HOST MODERASYON YETKİLERİ (Clubhouse modeli) ============
// Sahnedeki/dinleyicideki kullanıcılar için: chat-mute, mesaj sil, süreli ban, mute-all, lock

// CHAT MUTE — Kullanıcının yazı yazmasını engelle (kalıcı kayıt, restart-safe)
// data/room_chat_mutes.json: { "roomName::nickLower": { ts, by, reason, until?(timestamp) } }
// DATA_DIR aşağıda tanımlı (const, hoist olmaz) — yolu lazy hesapla
function chatMutesFile() { return path.join(__dirname, 'data', 'room_chat_mutes.json'); }
const _chatMutes = new Map();
let _chatMutesLoaded = false;
function _loadChatMutesOnce() {
    if (_chatMutesLoaded) return;
    _chatMutesLoaded = true;
    try {
        const f = chatMutesFile();
        if (!fs.existsSync(f)) return;
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const now = Date.now();
        for (const [key, v] of Object.entries(raw || {})) {
            if (v && (!v.until || v.until > now)) _chatMutes.set(key, v);
        }
    } catch { /* yoksay */ }
}
function _persistChatMutes() {
    if (_persistChatMutes._t) return;
    _persistChatMutes._t = setTimeout(async () => {
        _persistChatMutes._t = null;
        try {
            if (typeof ensureDataDir === 'function') await ensureDataDir();
            await atomicWriteJson(chatMutesFile(), Object.fromEntries(_chatMutes.entries()));
        } catch (e) { console.warn('[CHAT-MUTE] save fail:', e.message); }
    }, 1500);
}
function _chatMuteKey(room, nick) { return room + '::' + (nick || '').toLowerCase(); }

// EXTENDED ROOM BAN (24h / kalıcı) — restart-safe ayrı persist
// data/room_extended_bans.json — _roomBans 1h sabit TTL kullanıyor, daha uzun süreler için ayrı katman
function extBansFile() { return path.join(__dirname, 'data', 'room_extended_bans.json'); }
const _extendedBans = new Map();
let _extendedBansLoaded = false;
function _loadExtendedBansOnce() {
    if (_extendedBansLoaded) return;
    _extendedBansLoaded = true;
    try {
        const f = extBansFile();
        if (!fs.existsSync(f)) return;
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const now = Date.now();
        for (const [key, v] of Object.entries(raw || {})) {
            if (v && (!v.until || v.until > now)) _extendedBans.set(key, v);
        }
        console.log(`[EXT-BAN] ${_extendedBans.size} kayıt yüklendi`);
    } catch { /* yoksay */ }
}
function _persistExtendedBans() {
    if (_persistExtendedBans._t) return;
    _persistExtendedBans._t = setTimeout(async () => {
        _persistExtendedBans._t = null;
        try {
            if (typeof ensureDataDir === 'function') await ensureDataDir();
            await atomicWriteJson(extBansFile(), Object.fromEntries(_extendedBans.entries()));
        } catch (e) { console.warn('[EXT-BAN] save fail:', e.message); }
    }, 1500);
}
function getExtendedBan(room, nick) {
    _loadExtendedBansOnce();
    const k = _chatMuteKey(room, nick);
    const v = _extendedBans.get(k);
    if (!v) return null;
    if (v.until && v.until < Date.now()) {
        _extendedBans.delete(k);
        _persistExtendedBans();
        return null;
    }
    return v;
}
function isChatMuted(room, nick) {
    _loadChatMutesOnce();
    const v = _chatMutes.get(_chatMuteKey(room, nick));
    if (!v) return null;
    if (v.until && v.until < Date.now()) {
        _chatMutes.delete(_chatMuteKey(room, nick));
        _persistChatMutes();
        return null;
    }
    return v;
}

// POST /api/room/:name/chat-mute — host yazı susturma
app.post('/api/room/:name/chat-mute', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { nick, durationMin, reason } = req.body || {};
    if (!nick) return res.status(400).json({ success: false, error: 'nick gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini susturamazsın' });
    }
    if (def.host && def.host.toLowerCase() === nick.toLowerCase() && !isStaff) {
        return res.status(403).json({ success: false, error: 'Host\'u susturamazsın' });
    }
    const dur = Number(durationMin);
    const until = (dur > 0 && dur < 24 * 60) ? (Date.now() + dur * 60 * 1000) : null;
    _chatMutes.set(_chatMuteKey(roomName, nick), {
        ts: Date.now(), by: req.user.nick, reason: String(reason || '').slice(0, 100), until,
    });
    _persistChatMutes();
    pushModLog({ action: 'chat-mute', room: roomName, by: req.user.nick, target: nick, reason, details: { durationMin: dur || 'perm' } });
    // Realtime broadcast — herkes UI'da kullanıcıyı muted göstersin
    broadcastModBot(roomName, `🔇 @${nick} sohbet susturuldu (${dur ? dur + ' dk' : 'süresiz'}). Sebep: ${reason || 'belirtilmedi'}`);
    // Doğrudan kullanıcıya data channel mesaj — composer disable için
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const payload = Buffer.from(JSON.stringify({ type: 'chat_mute', target: nick, until, by: req.user.nick, reason }));
            await svc.sendData(roomName, payload, 0);
        }
    } catch (e) { console.error('[CHAT-MUTE] sendData hatası:', e.message); }
    res.json({ success: true, until });
});

// DELETE /api/room/:name/chat-mute/:nick — susturmayı kaldır
app.delete('/api/room/:name/chat-mute/:nick', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const nick = decodeURIComponent(req.params.nick);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    _chatMutes.delete(_chatMuteKey(roomName, nick));
    _persistChatMutes();
    pushModLog({ action: 'chat-unmute', room: roomName, by: req.user.nick, target: nick });
    broadcastModBot(roomName, `🔊 @${nick} sohbet susturması kaldırıldı.`);
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const payload = Buffer.from(JSON.stringify({ type: 'chat_unmute', target: nick, by: req.user.nick }));
            await svc.sendData(roomName, payload, 0);
        }
    } catch (e) { console.error('[CHAT-UNMUTE] sendData hatası:', e.message); }
    res.json({ success: true });
});

// DELETE /api/room/:name/message — chat mesajını sil (broadcast — clients UI'dan kaldırır)
app.delete('/api/room/:name/message', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { msgId, msgFrom, msgText } = req.body || {};
    if (!msgId) return res.status(400).json({ success: false, error: 'msgId gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    pushModLog({
        action: 'message-delete', room: roomName, by: req.user.nick, target: msgFrom || null,
        details: { msgId, preview: String(msgText || '').slice(0, 60) },
    });
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const payload = Buffer.from(JSON.stringify({ type: 'msg_delete', msgId, by: req.user.nick }));
            await svc.sendData(roomName, payload, 0);
        }
    } catch (e) { console.error('[MSG-DELETE] sendData hatası:', e.message); }
    res.json({ success: true });
});

// GET /api/room/:name/host-bans — bu odadaki aktif yasakları + chat-mute'ları listele
app.get('/api/room/:name/host-bans', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });

    const now = Date.now();
    // 1) Hızlı kick (1 saat) bans — _roomBans = Map<roomName, Map<nick, banObj>>
    const bans = [];
    _loadExtendedBansOnce();
    const roomBansMap = _roomBans.get(roomName);
    if (roomBansMap) {
        for (const [nick, val] of roomBansMap.entries()) {
            if (now - val.ts > ROOM_BAN_TTL_MS) continue;
            bans.push({
                nick, type: 'kick',
                duration: '1h',
                by: val.by || 'system',
                reason: val.reason || '',
                until: val.ts + ROOM_BAN_TTL_MS,
                createdAt: val.ts || null,
            });
        }
    }
    // 2) Extended bans (24h / perm) — key formatı "room::nick"
    for (const [key, val] of _extendedBans.entries()) {
        if (!key.startsWith(roomName + '::')) continue;
        if (val.until && val.until < now) continue;
        const nick = key.split('::')[1];
        // Aynı nick zaten kick listesinde varsa skip
        if (bans.find(b => b.nick.toLowerCase() === nick.toLowerCase())) continue;
        bans.push({
            nick, type: 'ban',
            duration: val.until ? '24h' : 'perm',
            by: val.by || 'host',
            reason: val.reason || '',
            until: val.until || null,
            createdAt: val.ts || null,
        });
    }
    // 3) Chat-mutes
    const chatMutes = [];
    _loadChatMutesOnce();
    for (const [key, val] of _chatMutes.entries()) {
        if (!key.startsWith(roomName + '::')) continue;
        if (val.until && val.until < now) continue;
        const nick = key.split('::')[1];
        chatMutes.push({
            nick,
            by: val.by || 'host',
            reason: val.reason || '',
            until: val.until || null,
            createdAt: val.ts || null,
        });
    }
    res.json({ success: true, bans, chatMutes });
});

// DELETE /api/room/:name/host-ban/:nick — yasağı kaldır (kick + extended ban'i siler)
app.delete('/api/room/:name/host-ban/:nick', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const nick = decodeURIComponent(req.params.nick);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    const nickLower = nick.toLowerCase();
    const key = roomName + '::' + nickLower;
    let removed = false;
    // 1h kick — _roomBans Map<room, Map<nick, val>>
    const roomBansMap = _roomBans.get(roomName);
    if (roomBansMap && roomBansMap.delete(nickLower)) { _persistRoomBans(); removed = true; }
    // Extended ban — _extendedBans Map<room::nick, val>
    _loadExtendedBansOnce();
    if (_extendedBans.delete(key)) { _persistExtendedBans(); removed = true; }
    if (removed) {
        pushModLog({ action: 'host-unban', room: roomName, by: req.user.nick, target: nick });
        broadcastModBot(roomName, `✅ @${nick} yasağı kaldırıldı (host: ${req.user.nick}).`);
    }
    res.json({ success: true, removed });
});

// POST /api/room/:name/host-ban — host süreli ban (durations: '1h' | '24h' | 'perm')
const HOST_BAN_DURATIONS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, 'perm': null };
app.post('/api/room/:name/host-ban', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { nick, duration, reason } = req.body || {};
    if (!nick) return res.status(400).json({ success: false, error: 'nick gerekli' });
    if (!(duration in HOST_BAN_DURATIONS)) return res.status(400).json({ success: false, error: 'duration: 1h|24h|perm' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini banlayamazsın' });
    }
    if (def.host && def.host.toLowerCase() === nick.toLowerCase() && !isStaff) {
        return res.status(403).json({ success: false, error: 'Host\'u banlayamazsın' });
    }
    // Stage'den çıkar + odadan at
    const stage = getRoomStage(roomName);
    if (stage.speakers[nick]) { delete stage.speakers[nick]; _persistStages(); try { await updateLiveKitPermission(roomName, nick, false); } catch (e) { console.error('[HOST-BAN] updateLiveKitPermission hatası:', e.message); } }
    const svc = getRoomServiceClient();
    if (svc) try { await svc.removeParticipant(roomName, nick); } catch (e) { console.error('[HOST-BAN] removeParticipant hatası:', e.message); }
    // Ban: 1h zaten _roomBans Map'te. Daha uzun süre için ban'a custom TTL eklemek lazım.
    // Şimdilik _roomBans + ek "extended" file (ileride birleştirilebilir)
    const ms = HOST_BAN_DURATIONS[duration];
    addRoomBan(roomName, nick, req.user.nick, reason);
    // Extended ban (24h/perm) için ayrı persist — restart-safe
    if (duration !== '1h') {
        _loadExtendedBansOnce();
        _extendedBans.set(_chatMuteKey(roomName, nick), {
            ts: Date.now(), by: req.user.nick, reason, until: ms ? Date.now() + ms : null,
        });
        _persistExtendedBans();
    }
    pushModLog({ action: 'host-ban', room: roomName, by: req.user.nick, target: nick, reason, details: { duration } });
    broadcastModBot(roomName, `⛔ @${nick} banlandı (${duration === 'perm' ? 'kalıcı' : duration}). Sebep: ${reason || 'belirtilmedi'}`);
    res.json({ success: true, duration, until: ms ? Date.now() + ms : null });
});

// POST /api/room/:name/mute-all — Tüm konuşmacıları sustur (Clubhouse "mute all")
app.post('/api/room/:name/mute-all', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    const stage = getRoomStage(roomName);
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    let muted = 0;
    for (const identity of Object.keys(stage.speakers || {})) {
        if (identity.toLowerCase() === req.user.nick.toLowerCase()) continue; // kendini hariç tut
        try {
            const parts = await svc.listParticipants(roomName);
            const p = parts.find(x => x.identity === identity);
            if (p) {
                for (const track of p.tracks) {
                    if (track.type === 1) await svc.mutePublishedTrack(roomName, identity, track.sid, true);
                }
                muted++;
            }
        } catch (e) { /* skip */ }
    }
    pushModLog({ action: 'mute-all', room: roomName, by: req.user.nick, details: { count: muted } });
    broadcastModBot(roomName, `🔇 Host tüm konuşmacıları sustur. (${muted} kişi)`);
    res.json({ success: true, muted });
});

// POST /api/room/:name/host-lock — Host oda kilidi (admin değil de host'a da açık)
app.post('/api/room/:name/host-lock', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { locked } = req.body || {};
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    try {
        const locks = await loadLocks();
        if (locked) {
            locks[roomName] = { lockedBy: req.user.nick, lockedAt: new Date().toISOString() };
        } else {
            delete locks[roomName];
        }
        await saveLocks(locks);
        pushModLog({ action: locked ? 'host-lock' : 'host-unlock', room: roomName, by: req.user.nick });
        broadcastModBot(roomName, locked ? `🔒 Oda kilitlendi (yeni kimse giremez)` : `🔓 Oda kilidi kaldırıldı`);
        res.json({ success: true, locked: !!locked });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/room/:name/chat-mutes — host bu odada kimleri susturdu listesi
app.get('/api/room/:name/chat-mutes', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    const prefix = roomName + '::';
    const list = [];
    const now = Date.now();
    for (const [key, v] of _chatMutes.entries()) {
        if (!key.startsWith(prefix)) continue;
        if (v.until && v.until < now) continue;
        list.push({ nick: key.slice(prefix.length), ...v });
    }
    res.json({ success: true, mutes: list });
});

// #2 Host kendi odasının ayarlarını düzenler (mic_policy, cam_policy, max_speakers/cameras, ai_level, access, desc)
const VALID_MIC_POL_USER = ['open', 'request', 'invite_only'];
const VALID_CAM_POL_USER = ['speakers_only', 'mod_only'];
const VALID_AI_USER = ['off', 'standard', 'strict'];
app.put('/api/rooms/:name/settings', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const rooms = await loadUserRooms();
    const idx = rooms.findIndex(r => r.name === roomName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Üye odası değil ya da bulunamadı' });
    const room = rooms[idx];
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    // Sadece kurucu (asıl host) veya admin/mod
    if (room.hostId !== req.user.id && !isStaff) {
        return res.status(403).json({ success: false, error: 'Sadece oda kurucusu ayarları değiştirebilir.' });
    }
    const {
        desc, mic_policy, cam_policy, max_speakers, max_cameras,
        speaker_time_limit, silence_kick_seconds, ai_level,
        access, password,    // access mode + yeni şifre (password modunda)
        theme, cam_mode,     // görsel tema slug + kamera modu override
    } = req.body || {};
    // Enum validations
    if (mic_policy && !VALID_MIC_POL_USER.includes(mic_policy)) return res.status(400).json({ success: false, error: 'Geçersiz mic_policy' });
    if (cam_policy && !VALID_CAM_POL_USER.includes(cam_policy)) return res.status(400).json({ success: false, error: 'Geçersiz cam_policy' });
    if (ai_level && !VALID_AI_USER.includes(ai_level)) return res.status(400).json({ success: false, error: 'Geçersiz ai_level' });
    if (access && !['public', 'password', 'invite', 'friends'].includes(access)) return res.status(400).json({ success: false, error: 'Geçersiz access' });
    if (theme && !VALID_ROOM_THEMES.has(theme)) return res.status(400).json({ success: false, error: 'Geçersiz tema' });
    // Numeric clamps — kötüye kullanım koruması
    const clampInt = (v, min, max, fallback) => {
        const n = parseInt(v);
        if (isNaN(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    };
    if (desc !== undefined) room.desc = String(desc || '').slice(0, 120);
    if (mic_policy) room.mic_policy = mic_policy;
    if (cam_policy) room.cam_policy = cam_policy;
    if (max_speakers !== undefined) room.max_speakers = clampInt(max_speakers, 0, 12, room.max_speakers ?? 6);
    if (max_cameras !== undefined) room.max_cameras = clampInt(max_cameras, 0, 12, room.max_cameras ?? 0);
    if (speaker_time_limit !== undefined) room.speaker_time_limit = clampInt(speaker_time_limit, 0, 3600, room.speaker_time_limit ?? 0);
    if (silence_kick_seconds !== undefined) room.silence_kick_seconds = clampInt(silence_kick_seconds, 0, 3600, room.silence_kick_seconds ?? 0);
    if (ai_level) room.ai_level = ai_level;
    if (theme) room.theme = theme;
    if (cam_mode && ['camera','host_only','none'].includes(cam_mode)) applyCamMode(room, cam_mode);
    if (access) {
        room.access = access;
        if (access === 'password') {
            if (password && typeof password === 'string' && password.length >= 3 && password.length <= 32) {
                room.passwordHash = await bcrypt.hash(password, 10);
            } else if (!room.passwordHash) {
                return res.status(400).json({ success: false, error: 'Şifre 3-32 karakter olmalı (yeni access:password için zorunlu)' });
            }
        }
    }
    await saveUserRooms(rooms);
    roomCache.ts = 0;
    // Hangi alanlar değişti — log + broadcast için
    const changedFields = ['desc','mic_policy','cam_policy','max_speakers','max_cameras','speaker_time_limit','silence_kick_seconds','ai_level','access','theme','cam_mode']
        .filter(k => req.body && req.body[k] !== undefined);
    pushModLog({ action: 'settings-changed', room: roomName, by: req.user.nick, details: { changed: changedFields } });
    console.log(`[HOST-SETTINGS] ${roomName} ayarları güncellendi (by ${req.user.nick}) — alanlar: ${changedFields.join(', ')}`);
    // Realtime: tüm katılımcılara yeni ayarları yay → client'lar refreshStageState çağırır
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const { passwordHash: _, ...safeRoom } = room;
            const payload = Buffer.from(JSON.stringify({
                type: 'settings_changed',
                room: safeRoom,
                changed: changedFields,
                by: req.user.nick,
            }));
            await svc.sendData(roomName, payload, 0);
        }
        // Chat mesajı — kullanıcılar değişiklikten haberdar olsun
        const labelMap = {
            desc: 'açıklama', mic_policy: 'mikrofon', cam_policy: 'kamera politikası',
            max_speakers: 'max konuşmacı', max_cameras: 'max kamera',
            speaker_time_limit: 'konuşma süresi', silence_kick_seconds: 'sessizlik indirme',
            ai_level: 'AI seviyesi', access: 'erişim modu',
            theme: 'tema', cam_mode: 'kamera modu',
        };
        const labels = changedFields.map(f => labelMap[f] || f).join(', ');
        if (changedFields.length) broadcastModBot(roomName, `⚙️ Host (${req.user.nick}) oda ayarlarını değiştirdi: ${labels}.`);
    } catch (e) { /* sessizce geç — kaydet zaten oldu */ }
    const { passwordHash, ...safe } = room;
    res.json({ success: true, room: safe });
});

// Üye odalarını listele
app.get('/api/rooms/mine', requireAuth, async (req, res) => {
    const rooms = (await loadUserRooms()).filter(r => r.hostId === req.user.id);
    // passwordHash leak etme
    const safe = rooms.map(({ passwordHash, ...r }) => r);
    res.json({ success: true, rooms: safe });
});

// ============ ARKADAŞLIK SİSTEMİ ============
// DATA_DIR aşağıda tanımlı (const, hoist olmaz) — yolu lazy hesapla
function friendsFile() { return path.join(DATA_DIR, 'friends.json'); }
async function loadFriends() {
    await ensureDataDir();
    const f = friendsFile();
    try { await fs.promises.access(f); } catch { await fs.promises.writeFile(f, '{}', 'utf8'); }
    try { return JSON.parse(await fs.promises.readFile(f, 'utf8')); } catch { return {}; }
}
async function saveFriends(data) {
    await ensureDataDir();
    await atomicWriteJson(friendsFile(), data);
}
async function getFriendsOf(userId) {
    const all = await loadFriends();
    return all[userId] || [];
}

// ============ KİŞİSEL GÜVENLİK: ENGELLİ (BLOCK) LİSTESİ ============
// Codex D paketi: kullanıcı başına engellediği nick'ler — DM'i engeller, profil ziyareti çift taraflı saklar.
// data/blocks.json formatı: { "userId": ["blockedNickLower1", "blockedNickLower2"], ... }
function blocksFile() { return path.join(DATA_DIR, 'blocks.json'); }
async function loadBlocks() {
    await ensureDataDir();
    const f = blocksFile();
    try { await fs.promises.access(f); } catch { await fs.promises.writeFile(f, '{}', 'utf8'); }
    try { return JSON.parse(await fs.promises.readFile(f, 'utf8')); } catch { return {}; }
}
async function saveBlocks(data) {
    await ensureDataDir();
    await atomicWriteJson(blocksFile(), data);
}
async function getBlocksOf(userId) {
    const all = await loadBlocks();
    return all[userId] || [];
}
// A, B'yi engellemiş mi? (A'nın userId'si, B'nin nick'i)
async function hasBlocked(byUserId, targetNick) {
    if (!byUserId || !targetNick) return false;
    const list = await getBlocksOf(byUserId);
    return list.some(n => n.toLowerCase() === targetNick.toLowerCase());
}
// A, B birbirini engellemiş mi? (DM iki yönü kapanır)
// byUser, targetNick, ve users array'inden targetUserId hesaplanır.
async function isMutuallyOrEitherBlocked(usersByNick, fromUser, toUserNick) {
    const toUser = usersByNick(toUserNick);
    if (!toUser) return false;
    // From, to'yu engellediyse from kendi mesajını göndermek istemez
    if (await hasBlocked(fromUser.id, toUser.nick)) return { blocked: true, by: 'self' };
    // To, from'u engellediyse from'un mesajı kabul edilmez
    if (await hasBlocked(toUser.id, fromUser.nick)) return { blocked: true, by: 'target' };
    return { blocked: false };
}

// ============ ARKADAŞLIK İSTEĞİ SİSTEMİ ============
// data/friend_requests.json — düz dizi: [{ id, fromId, fromNick, toId, toNick, ts, status }, ...]
// status: 'pending' | 'accepted' | 'rejected' | 'canceled'
// Çift taraflı arkadaşlık: kabul edilince HEM A'nın listesine B, HEM B'nin listesine A eklenir.
function frFile() { return path.join(DATA_DIR, 'friend_requests.json'); }
async function loadFR() {
    try {
        const f = frFile();
        try { await fs.promises.access(f); } catch { await ensureDataDir(); await fs.promises.writeFile(f, '[]', 'utf8'); return []; }
        return JSON.parse(await fs.promises.readFile(f, 'utf8'));
    } catch { return []; }
}
async function saveFR(arr) {
    try { await ensureDataDir(); await atomicWriteJson(frFile(), arr); }
    catch (e) { console.error('[FR] save fail:', e.message); }
}
async function areFriends(idA, idB, nickA, nickB) {
    const all = await loadFriends();
    const listA = all[idA] || [];
    return listA.some(n => n.toLowerCase() === String(nickB).toLowerCase());
}
async function addMutualFriend(idA, nickA, idB, nickB) {
    const all = await loadFriends();
    if (!all[idA]) all[idA] = [];
    if (!all[idB]) all[idB] = [];
    if (!all[idA].some(n => n.toLowerCase() === nickB.toLowerCase())) all[idA].push(nickB);
    if (!all[idB].some(n => n.toLowerCase() === nickA.toLowerCase())) all[idB].push(nickA);
    await saveFriends(all);
}
async function removeMutualFriend(idA, nickA, idB, nickB) {
    const all = await loadFriends();
    if (all[idA]) all[idA] = all[idA].filter(n => n.toLowerCase() !== nickB.toLowerCase());
    if (all[idB]) all[idB] = all[idB].filter(n => n.toLowerCase() !== nickA.toLowerCase());
    await saveFriends(all);
}

// Arkadaş listesi (kendi)
app.get('/api/friends/list', requireAuth, async (req, res) => {
    const friends = await getFriendsOf(req.user.id);
    res.json({ success: true, friends });
});

// İstek gönder (eskiden add idi — artık karşılıklı onay zorunlu)
// Eğer karşı taraf zaten sana istek atmışsa otomatik kabul edilir (handshake)
app.post('/api/friends/request', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler arkadaş isteği gönderemez.' });
    }
    const { nick } = req.body;
    if (!nick || typeof nick !== 'string' || nick.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Geçerli nick gerekli.' });
    }
    const target = nick.trim();
    if (target.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendine istek atamazsın.' });
    }
    const users = await loadUsers();
    const targetUser = users.find(u => u.nick.toLowerCase() === target.toLowerCase());
    if (!targetUser) return res.status(404).json({ success: false, error: 'Bu nick ile kayıtlı kullanıcı yok.' });

    // Zaten arkadaşsa
    if (areFriends(req.user.id, targetUser.id, req.user.nick, targetUser.nick)) {
        return res.status(409).json({ success: false, error: 'Zaten arkadaşsınız.' });
    }
    // Arkadaş listesi sınırı
    const myFriends = await getFriendsOf(req.user.id);
    if (myFriends.length >= 100) return res.status(429).json({ success: false, error: 'En fazla 100 arkadaşın olabilir.' });

    const requests = await loadFR();
    // Pending istek var mı (her iki yönde)
    const existingOut = requests.find(r => r.fromId === req.user.id && r.toId === targetUser.id && r.status === 'pending');
    if (existingOut) {
        return res.status(409).json({ success: false, error: 'Zaten bu kullanıcıya bekleyen isteğin var.' });
    }
    const existingIn = requests.find(r => r.fromId === targetUser.id && r.toId === req.user.id && r.status === 'pending');
    if (existingIn) {
        // Karşı taraftan zaten istek geldi — otomatik kabul (handshake)
        existingIn.status = 'accepted';
        existingIn.acceptedAt = Date.now();
        await saveFR(requests);
        addMutualFriend(req.user.id, req.user.nick, targetUser.id, targetUser.nick);
        // Karşı tarafa "istek kabul edildi" bildirimi
        pushNotification(targetUser.id, 'friend_add', {
            title: `🤝 ${req.user.nick} arkadaşlık isteğini kabul etti!`,
            body: `Artık arkadaşsınız.`,
            link: '/u/' + encodeURIComponent(req.user.nick),
            from: req.user.nick,
        });
        return res.json({ success: true, auto_accepted: true, message: `Karşı taraftan istek zaten vardı — otomatik kabul edildi, artık arkadaşsınız!` });
    }
    // Yeni istek oluştur
    const newReq = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        fromId: req.user.id,
        fromNick: req.user.nick,
        toId: targetUser.id,
        toNick: targetUser.nick,
        ts: Date.now(),
        status: 'pending',
    };
    requests.push(newReq);
    // Disk şişmesin — en eski 'accepted' / 'rejected' / 'canceled' istekleri 90 gün sonra sil
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const cleaned = requests.filter(r => r.status === 'pending' || r.ts > cutoff);
    await saveFR(cleaned);
    console.log(`[FR] İstek: ${req.user.nick} → ${targetUser.nick}`);
    // Bildirim — alıcıya
    pushNotification(targetUser.id, 'friend_add', {
        title: `👥 ${req.user.nick} sana arkadaşlık isteği gönderdi`,
        body: 'Profilinden Kabul Et / Reddet seçeneklerini görebilirsin.',
        link: '/u/' + encodeURIComponent(req.user.nick),
        from: req.user.nick,
    });
    res.json({ success: true, request: newReq });
});

// Bekleyen istekler — { incoming: [...], outgoing: [...] }
app.get('/api/friends/requests', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.json({ success: true, incoming: [], outgoing: [] });
    const requests = await loadFR();
    const incoming = requests.filter(r => r.toId === req.user.id && r.status === 'pending');
    const outgoing = requests.filter(r => r.fromId === req.user.id && r.status === 'pending');
    res.json({ success: true, incoming, outgoing });
});

// İstek kabul et (alıcı)
app.post('/api/friends/requests/:id/accept', requireAuth, async (req, res) => {
    const requests = await loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.toId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'accepted';
    r.acceptedAt = Date.now();
    await saveFR(requests);
    addMutualFriend(r.fromId, r.fromNick, r.toId, r.toNick);
    console.log(`[FR] Kabul: ${r.fromNick} ↔ ${r.toNick}`);
    // Bildirim — istek gönderene
    pushNotification(r.fromId, 'friend_add', {
        title: `🤝 ${r.toNick} arkadaşlık isteğini kabul etti!`,
        body: 'Artık arkadaşsınız.',
        link: '/u/' + encodeURIComponent(r.toNick),
        from: r.toNick,
    });
    res.json({ success: true });
});

// İstek reddet (alıcı)
app.post('/api/friends/requests/:id/reject', requireAuth, async (req, res) => {
    const requests = await loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.toId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'rejected';
    r.rejectedAt = Date.now();
    await saveFR(requests);
    console.log(`[FR] Red: ${r.fromNick} → ${r.toNick}`);
    res.json({ success: true });
    // Gönderene bildirim göndermiyoruz — psikolojik (incinme yok)
});

// İstek geri çek (gönderen)
app.delete('/api/friends/requests/:id', requireAuth, async (req, res) => {
    const requests = await loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.fromId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'canceled';
    r.canceledAt = Date.now();
    await saveFR(requests);
    res.json({ success: true });
});

// Arkadaş sil — KARŞILIKLI çıkar
app.post('/api/friends/remove', requireAuth, async (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli.' });
    const users = await loadUsers();
    const targetUser = users.find(u => u.nick.toLowerCase() === String(nick).toLowerCase());
    const list = await getFriendsOf(req.user.id);
    if (!list.some(f => f.toLowerCase() === String(nick).toLowerCase())) {
        return res.status(404).json({ success: false, error: 'Bu kullanıcı arkadaşın değil.' });
    }
    if (targetUser) {
        removeMutualFriend(req.user.id, req.user.nick, targetUser.id, targetUser.nick);
    } else {
        // Hedef silinmiş olabilir — sadece kendi listenden çıkar
        const all = loadFriends();
        all[req.user.id] = (all[req.user.id] || []).filter(f => f.toLowerCase() !== String(nick).toLowerCase());
        await saveFriends(all);
    }
    res.json({ success: true, friends: await getFriendsOf(req.user.id) });
});

// Eski /api/friends/add tamamen kaldırıldı — frontend artık /api/friends/request kullanıyor

// ============ KİŞİSEL GÜVENLİK: ENGELLİ KULLANICI API'LERİ ============
// Codex D paketi: kullanıcı kişisel block listesi yönetebilsin.
// /api/blocks                      → kendi engellediklerin
// POST /api/blocks {nick}          → engelle
// DELETE /api/blocks/:nick         → engel kaldır

app.get('/api/blocks', requireAuth, async (req, res) => {
    res.json({ success: true, blocked: getBlocksOf(req.user.id) });
});

app.post('/api/blocks', requireAuth, async (req, res) => {
    const { nick } = req.body || {};
    if (!nick || typeof nick !== 'string') return res.status(400).json({ success: false, error: 'nick gerekli' });
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini engelleyemezsin' });
    }
    const users = await loadUsers();
    const target = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
    if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    // admin/mod engellenemez (moderasyon korumalı)
    if (target.role === 'admin' || target.role === 'mod') {
        return res.status(403).json({ success: false, error: 'Yöneticileri engelleyemezsin' });
    }
    const all = loadBlocks();
    if (!all[req.user.id]) all[req.user.id] = [];
    if (!all[req.user.id].some(n => n.toLowerCase() === target.nick.toLowerCase())) {
        all[req.user.id].push(target.nick);
        await saveBlocks(all);
    }
    // Engellenen kişi engelleyenle arkadaşsa arkadaşlık da silinsin (UX iyi olsun)
    if (areFriends(req.user.id, target.id, req.user.nick, target.nick)) {
        removeMutualFriend(req.user.id, req.user.nick, target.id, target.nick);
    }
    console.log(`[BLOCK] ${req.user.nick} → ${target.nick} (engelledi)`);
    res.json({ success: true, blocked: getBlocksOf(req.user.id) });
});

app.delete('/api/blocks/:nick', requireAuth, async (req, res) => {
    const nick = decodeURIComponent(req.params.nick);
    const all = loadBlocks();
    if (!all[req.user.id]) return res.json({ success: true, blocked: [] });
    all[req.user.id] = all[req.user.id].filter(n => n.toLowerCase() !== nick.toLowerCase());
    await saveBlocks(all);
    console.log(`[BLOCK] ${req.user.nick} → ${nick} (engel kaldırıldı)`);
    res.json({ success: true, blocked: await getBlocksOf(req.user.id) });
});

// ============ ODA ERİŞİM KONTROLÜ — pre-flight ============
// Frontend, private bir odaya tıklayınca önce buraya sorar.
// 'public' → ok, 'password' → şifre verirsen ok, 'invite'/'friends' → token zamanında kontrol
app.post('/api/rooms/:name/check-access', passwordAccessLimiter, requireAuth, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const userRoom = (await loadUserRooms()).find(r => r.name === name);
    // Üye odası değilse default açık
    if (!userRoom) return res.json({ success: true, access: 'public' });
    // +18 yaş kontrolü — herkese, host bile değil
    if (userRoom.is_18_plus) {
        const u = (await loadUsers()).find(u => u.id === req.user.id);
        if (!isAdult(u?.birthYear)) {
            return res.status(403).json({ success: false, access: 'adult_only', error: 'Bu oda +18 — yaş bilgini gir veya 18 yaşından küçüksen giremezsin.' });
        }
    }
    const access = userRoom.access || 'public';
    // Host kendi odasına her zaman girebilir
    if (userRoom.hostId === req.user.id) {
        return res.json({ success: true, access, isHost: true });
    }
    // Codex bulgu #8: co-host ve admin/mod da bypass etsin — /getToken zaten kabul ediyor;
    // /check-access preflight'ta tutarsız davranınca UI'da takılıyorlardı.
    if (isRoomHost(userRoom, req.user.nick)) {
        return res.json({ success: true, access, isHost: true, isCoHost: true });
    }
    if (req.user.role === 'admin' || req.user.role === 'mod') {
        return res.json({ success: true, access, isStaff: true });
    }
    switch (access) {
        case 'public':
            return res.json({ success: true, access: 'public' });
        case 'password': {
            const { password } = req.body || {};
            if (!password) return res.json({ success: false, access: 'password', needPassword: true });
            const ok = await bcrypt.compare(String(password), userRoom.passwordHash || '');
            if (!ok) return res.status(401).json({ success: false, access: 'password', error: 'Şifre yanlış.' });
            // Doğru şifre → kısa ömürlü erişim token üret (5dk)
            const accessToken = jwt.sign({ room: name, nick: req.user.nick, kind: 'room-access' }, JWT_SECRET, { expiresIn: '5m' });
            return res.json({ success: true, access: 'password', accessToken });
        }
        case 'invite': {
            const isInvited = (userRoom.invitedNicks || []).some(n => n.toLowerCase() === req.user.nick.toLowerCase());
            if (!isInvited) return res.status(403).json({ success: false, access: 'invite', error: 'Bu odaya davetli değilsin.' });
            return res.json({ success: true, access: 'invite' });
        }
        case 'friends': {
            const hostFriends = (await getFriendsOf(userRoom.hostId)).map(n => n.toLowerCase());
            if (!hostFriends.includes(req.user.nick.toLowerCase())) {
                return res.status(403).json({ success: false, access: 'friends', error: 'Sadece host\'un arkadaşları girebilir.' });
            }
            return res.json({ success: true, access: 'friends' });
        }
        default:
            return res.json({ success: true, access: 'public' });
    }
});

// ============ HOST: davetli listesi yönetimi ============
app.get('/api/rooms/:name/invites', requireAuth, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const room = (await loadUserRooms()).find(r => r.name === name);
    if (!room) return res.status(404).json({ success: false, error: 'Oda yok.' });
    if (room.hostId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Sadece host görebilir.' });
    }
    res.json({ success: true, invitedNicks: room.invitedNicks || [], access: room.access || 'public' });
});

app.post('/api/rooms/:name/invites', inviteLimiter, requireAuth, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const rooms = await loadUserRooms();
    const idx = rooms.findIndex(r => r.name === name);
    if (idx < 0) return res.status(404).json({ success: false, error: 'Oda yok.' });
    const room = rooms[idx];
    if (room.hostId !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Sadece host yönetir.' });
    }
    const { add, remove } = req.body || {};
    let list = room.invitedNicks || [];
    if (Array.isArray(add)) {
        const cleaned = add.filter(n => typeof n === 'string').map(n => n.trim().toLowerCase()).filter(n => n.length >= 2 && n.length <= 30);
        list = [...new Set([...list, ...cleaned])].slice(0, 30);
    }
    if (Array.isArray(remove)) {
        const drop = new Set(remove.map(n => String(n).toLowerCase()));
        list = list.filter(n => !drop.has(n.toLowerCase()));
    }
    room.invitedNicks = list;
    rooms[idx] = room;
    await saveUserRooms(rooms);
    res.json({ success: true, invitedNicks: list });
});

// ============ ODA SAHNE SİSTEMİ (söz iste / grant / revoke) ============
// In-memory state — restart sonrası sıfırlanır (oda sessiona özgü, kalıcı olmaması doğal)
// {
//   roomName: {
//     queue: [{ identity, ts }, ...],          // söz isteyenler — FIFO
//     speakers: { identity: { ts, lastSpeakTs, type: 'mic'|'cam'|'both' } },  // sahnedekiler
//   }
// }
const _roomStages = new Map();
const ROOM_STAGES_FILE = path.join(__dirname, 'data', 'room_stages.json');
// Init — disk'ten yükle (stale kuyruk girdileri atılır)
(() => {
    try {
        if (!fs.existsSync(ROOM_STAGES_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ROOM_STAGES_FILE, 'utf8'));
        const now = Date.now();
        for (const [roomName, stage] of Object.entries(raw || {})) {
            const queue = (stage.queue || []).filter(q => (now - q.ts) < 3600000); // 1 saat'ten eski kuyruk girişleri atılır
            const speakers = stage.speakers || {};
            if (queue.length || Object.keys(speakers).length) {
                _roomStages.set(roomName, { queue, speakers });
            }
        }
        console.log(`[STAGE] ${_roomStages.size} oda sahne durumu disk'ten yüklendi`);
    } catch (e) { console.warn('[STAGE] load fail:', e.message); }
})();
function _persistStages() {
    try {
        if (_persistStages._t) return; // debounce 2sn
        _persistStages._t = setTimeout(async () => {
            _persistStages._t = null;
            const out = {};
            for (const [roomName, stage] of _roomStages.entries()) {
                if (!stage.queue.length && !Object.keys(stage.speakers).length) continue;
                out[roomName] = stage;
            }
            try { await ensureDataDir(); } catch (e) { console.warn('[STAGE] ensureDataDir hatası:', e.message); }
            try { await atomicWriteJson(ROOM_STAGES_FILE, out); } catch (e) { console.warn('[STAGE] save fail:', e.message); }
        }, 2000);
    } catch (e) { console.error('[STAGE] persist hatası:', e); }
}

function getRoomStage(roomName) {
    if (!_roomStages.has(roomName)) {
        _roomStages.set(roomName, { queue: [], speakers: {} });
        _persistStages();
    }
    return _roomStages.get(roomName);
}

async function findRoomDef(roomName) {
    return ROOM_DEFS.find(r => r.name === roomName) || (await loadUserRooms()).find(r => r.name === roomName);
}

function speakerCount(stage) {
    return Object.keys(stage.speakers).length;
}
function cameraCount(stage) {
    return Object.values(stage.speakers).filter(s => s.type === 'cam' || s.type === 'both').length;
}

// Odada CANLI bir admin/mod var mı? (LiveKit'ten doğrula)
// Cache 15sn — sürekli LiveKit'i sorgulamayalım
const _modPresenceCache = new Map(); // roomName → { hasMod: bool, ts }
async function hasModInRoom(roomName) {
    const cached = _modPresenceCache.get(roomName);
    if (cached && Date.now() - cached.ts < 15_000) return cached.hasMod;
    const svc = getRoomServiceClient();
    if (!svc) return false;
    try {
        const parts = await svc.listParticipants(roomName);
        const users = await loadUsers();
        const def = await findRoomDef(roomName);
        const hostNick = def?.host?.toLowerCase();
        // Codex bulgu #5: co-host'lar da mod sayılmalıydı — auto_stage onlar varken devreye girmesin
        const coHostsLower = Array.isArray(def?.coHosts)
            ? def.coHosts.map(n => (n || '').toLowerCase())
            : [];
        const hasMod = parts.some(p => {
            const lc = p.identity.toLowerCase();
            if (hostNick && lc === hostNick) return true;   // primary host
            if (coHostsLower.includes(lc)) return true;      // co-host (FIX)
            const u = users.find(x => x.nick.toLowerCase() === lc);
            return u && (u.role === 'admin' || u.role === 'mod');
        });
        _modPresenceCache.set(roomName, { hasMod, ts: Date.now() });
        return hasMod;
    } catch {
        return false;
    }
}

// LiveKit'te identity'nin yayın iznini güncelle — audio/video kaynaklarını ayrı yönet.
// sources: ['microphone'] = sadece mic | ['microphone','camera'] = mic+cam | [] (canPublish=false) = dinleyici
async function updateLiveKitPermission(roomName, identity, opts) {
    const svc = getRoomServiceClient();
    if (!svc) return false;
    // Geriye uyum: eski çağrılar bool gönderiyor olabilir
    let canPublish, sources;
    if (typeof opts === 'boolean') {
        canPublish = opts;
        sources = opts ? ['microphone'] : [];
    } else {
        canPublish = !!opts?.canPublish;
        sources = Array.isArray(opts?.sources) ? opts.sources : (canPublish ? ['microphone'] : []);
    }
    try {
        await svc.updateParticipant(roomName, identity, undefined, {
            canPublish,
            canSubscribe: true,
            canPublishData: true,
            canPublishSources: toTrackSources(sources),  // LiveKit TrackSource enum array
        });
        return true;
    } catch (err) {
        console.warn(`[STAGE] LiveKit permission update fail (${identity}@${roomName}):`, err.message);
        // Codex bulgu #5: false dönüş rollback'i tetiklemiyordu. Throw et — caller (grantStageInternal)
        // try/catch ile yakalayıp state'i geri alıyor zaten.
        throw err;
    }
}

// GET — oda sahne durumu (queue + speakers + ayarlar)
app.get('/api/room/:name/stage', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const stage = getRoomStage(roomName);
    const myIdentity = req.user.nick;
    const myPos = stage.queue.findIndex(q => q.identity.toLowerCase() === myIdentity.toLowerCase());
    res.json({
        success: true,
        room: {
            name: def.name,
            category: def.category || 'free',
            icon: def.icon || '💬',
            host: def.host || null,
            coHosts: Array.isArray(def.coHosts) ? def.coHosts : [],   // frontend rol+yetki render için
            desc: def.desc || '',
            max: def.max || 100,
            isUserRoom: !!def.host,                                    // host varsa üye odası (sistem odasında host=null)
            theme: (def.theme && VALID_ROOM_THEMES.has(def.theme)) ? def.theme : 'classic',  // görsel tema (classic/sakir) — eski 'gece'/'pera' kayıtları classic'e düşer
            access: def.access || 'public',                            // erişim modu (public/password/invite/friends)
        },
        settings: {
            max_speakers: (def.max_speakers ?? 6),
            max_cameras: (def.max_cameras ?? 4),                       // ?? kullan ki 0 falsy düşmesin (cam_mode:none = 0 saklanmalı)
            mic_policy: def.mic_policy || 'request',
            cam_policy: def.cam_policy || 'speakers_only',
            auto_stage: def.auto_stage !== false,
            speaker_time_limit: def.speaker_time_limit || 0,
            silence_kick_seconds: def.silence_kick_seconds || 0,
            ai_level: def.ai_level || 'standard',
        },
        speakers: Object.entries(stage.speakers).map(([identity, s]) => ({
            identity, type: s.type, sinceTs: s.ts,
        })),
        queue: stage.queue.map((q, i) => ({ identity: q.identity, pos: i + 1, ts: q.ts })),
        my_position: myPos >= 0 ? myPos + 1 : null,
        is_speaker: !!stage.speakers[myIdentity],
        is_in_queue: myPos >= 0,
    });
});

// Söz iste
app.post('/api/room/:name/raise-hand', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    // NOT: mic_policy='open' modu /getToken'da işleniyor — kullanıcı odaya girer girmez
    // sahneye eklenir, raise-hand'e hiç gelmez. Buraya düşerse (race condition) aşağıdaki
    // "zaten sahnede" check'i 409 ile cevaplar.
    if (def.mic_policy === 'invite_only' && req.user.role !== 'admin' && req.user.role !== 'mod') {
        const isHost = isRoomHost(def, req.user.nick);  // host VEYA co-host
        if (!isHost) return res.status(403).json({ success: false, error: 'Bu oda davete dayalı — host seni davet etmeli.' });
    }
    const stage = getRoomStage(roomName);
    const me = req.user.nick;
    // Zaten sahnedeyse
    if (stage.speakers[me]) {
        return res.status(409).json({ success: false, error: 'Zaten sahnedesin.' });
    }
    // Zaten kuyrukta mı?
    const existing = stage.queue.findIndex(q => q.identity.toLowerCase() === me.toLowerCase());
    if (existing >= 0) {
        return res.json({ success: true, in_queue: true, position: existing + 1, message: 'Zaten kuyruktasın.' });
    }
    stage.queue.push({ identity: me, ts: Date.now() });
    _persistStages();
    console.log(`[STAGE] ${me} söz istedi: ${roomName} (kuyrukta ${stage.queue.length})`);
    // auto_stage açık + boş slot varsa + ODADA MOD YOKSA → otomatik grant
    // Mod varsa karar onlara bırakılır
    if (def.auto_stage !== false && speakerCount(stage) < ((def.max_speakers ?? 6))) {
        const modPresent = await hasModInRoom(roomName);
        if (!modPresent) {
            try {
                await grantStageInternal(roomName, me, 'mic');
                return res.json({ success: true, granted: true, message: 'Sahneye alındın — mikrofonun açık.' });
            } catch (e) {
                // LiveKit fail — kuyrukta kal, kullanıcıya bilgi ver
                console.warn('[STAGE] auto-grant fail (raise-hand):', e.message);
                return res.json({ success: true, in_queue: true, position: stage.queue.length, message: 'Sahneye alınamadın (geçici hata), kuyruktasın.' });
            }
        } else {
            console.log(`[STAGE] ${me} kuyrukta tutuldu — odada mod var, mod karar verecek`);
            return res.json({ success: true, in_queue: true, position: stage.queue.length, message: 'Odada mod var — onun onayını bekliyorsun.' });
        }
    }
    res.json({ success: true, in_queue: true, position: stage.queue.length });
});

// Host/mod kuyruktan birini reddeder (bildirim göndermez — psikolojik koruma)
app.post('/api/room/:name/reject-hand', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isHost = isRoomHost(def, req.user.nick);  // host VEYA co-host
    const isModerator = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isHost && !isModerator) {
        return res.status(403).json({ success: false, error: 'Sadece host/mod reddedebilir.' });
    }
    const stage = getRoomStage(roomName);
    const before = stage.queue.length;
    stage.queue = stage.queue.filter(q => q.identity.toLowerCase() !== identity.toLowerCase());
    if (stage.queue.length === before) {
        return res.status(404).json({ success: false, error: 'Bu kullanıcı kuyrukta değil.' });
    }
    _persistStages();
    console.log(`[STAGE] ${req.user.nick} kuyruktan reddetti: ${identity} @ ${roomName}`);
    res.json({ success: true });
});

// Söz iste kuyruktan iptal
app.post('/api/room/:name/cancel-hand', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const stage = getRoomStage(roomName);
    const me = req.user.nick;
    const idx = stage.queue.findIndex(q => q.identity.toLowerCase() === me.toLowerCase());
    if (idx < 0) return res.status(404).json({ success: false, error: 'Kuyrukta değilsin.' });
    stage.queue.splice(idx, 1);
    _persistStages();
    res.json({ success: true });
});

// İç fonksiyon — sahneye al
// Codex bulgu #4: LiveKit permission güncellemesi fail olursa state'i rollback et —
// yoksa backend "kişi sahnede" sanır ama LiveKit'te mic yetkisi yok kalır.
async function grantStageInternal(roomName, identity, type = 'mic') {
    const stage = getRoomStage(roomName);
    // Snapshot (rollback için)
    const prevQueue = [...stage.queue];
    const prevSpeaker = stage.speakers[identity];
    stage.queue = stage.queue.filter(q => q.identity.toLowerCase() !== identity.toLowerCase());
    stage.speakers[identity] = { ts: Date.now(), lastSpeakTs: Date.now(), type };
    try {
        await updateLiveKitPermission(roomName, identity, true);
    } catch (e) {
        // Rollback — state'i geri al, hata yukarı fırlat (caller karar versin)
        stage.queue = prevQueue;
        if (prevSpeaker) stage.speakers[identity] = prevSpeaker;
        else delete stage.speakers[identity];
        console.warn(`[STAGE] ${identity} sahneye alınamadı (LiveKit fail): ${e.message} — rollback yapıldı`);
        throw e;
    }
    _persistStages();
    console.log(`[STAGE] ${identity} sahneye alındı: ${roomName} (sahnede ${speakerCount(stage)})`);
}

// Host/mod — birini sahneye al
app.post('/api/room/:name/grant-stage', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity, type } = req.body;
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    // Yetki: host, admin, mod
    const isHost = isRoomHost(def, req.user.nick);  // host VEYA co-host
    const isModerator = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isHost && !isModerator) {
        return res.status(403).json({ success: false, error: 'Sadece host/mod sahneye alabilir.' });
    }
    const stage = getRoomStage(roomName);
    if (speakerCount(stage) >= ((def.max_speakers ?? 6))) {
        return res.status(429).json({ success: false, error: `Sahne dolu (${def.max_speakers} kişi limit).` });
    }
    if (stage.speakers[identity]) {
        return res.status(409).json({ success: false, error: 'Bu kullanıcı zaten sahnede.' });
    }
    try {
        await grantStageInternal(roomName, identity, type || 'mic');
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Sahneye alınamadı: ' + e.message });
    }
    // Bildirim
    const users = await loadUsers();
    const target = users.find(u => u.nick.toLowerCase() === identity.toLowerCase());
    if (target) {
        pushNotification(target.id, 'system', {
            title: '🎤 Sahneye alındın',
            body: `"${roomName}" odasında ${req.user.nick} seni sahneye aldı — mikrofonun açık.`,
            link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(identity),
            from: req.user.nick,
        });
    }
    res.json({ success: true, speakers: speakerCount(stage), max: def.max_speakers });
});

// İç fonksiyon — sahneden indir
// Rollback: LiveKit revoke fail olursa state'i geri al (kullanıcı hâlâ mic'e sahip ama
// backend "sahnede değil" sanmasın diye).
async function revokeStageInternal(roomName, identity, reason) {
    const stage = getRoomStage(roomName);
    if (!stage.speakers[identity]) return false;
    const prev = stage.speakers[identity];
    delete stage.speakers[identity];
    try {
        await updateLiveKitPermission(roomName, identity, false);
    } catch (e) {
        // Rollback — kullanıcı LiveKit'te hâlâ mic'e sahip, state'i geri yükle
        stage.speakers[identity] = prev;
        console.warn(`[STAGE] ${identity} sahneden indirme fail (${e.message}) — rollback`);
        throw e;
    }
    _persistStages();
    console.log(`[STAGE] ${identity} sahneden indirildi: ${roomName} — ${reason || 'no reason'}`);
    return true;
}

// Host/mod/kullanıcı kendisi — sahneden in
app.post('/api/room/:name/revoke-stage', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    const target = identity || req.user.nick;
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    // Yetki
    const isSelf = target.toLowerCase() === req.user.nick.toLowerCase();
    const isHost = isRoomHost(def, req.user.nick);  // host VEYA co-host
    const isModerator = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isSelf && !isHost && !isModerator) {
        return res.status(403).json({ success: false, error: 'Sadece kendini ya da host/mod başkalarını indirebilir.' });
    }
    let ok;
    try {
        ok = await revokeStageInternal(roomName, target, isSelf ? 'kullanıcı kendi indi' : `${req.user.nick} indirdi`);
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Sahneden indirilemedi: ' + e.message });
    }
    if (!ok) return res.status(404).json({ success: false, error: 'Sahnede değil.' });

    // Sahne boşaldıysa + auto_stage açık + kuyrukta varsa + odada mod yoksa → bir sonrakini al
    // (mod varsa onun onayını bekle — auto_stage kuralı)
    const stage = getRoomStage(roomName);
    if (def.auto_stage !== false && stage.queue.length > 0 && speakerCount(stage) < ((def.max_speakers ?? 6))) {
        const modPresent = await hasModInRoom(roomName);
        if (!modPresent) {
            const next = stage.queue[0];
            try { await grantStageInternal(roomName, next.identity, 'mic'); } catch (e) { console.warn('[STAGE] auto-grant fail:', e.message); }
        }
    }
    res.json({ success: true });
});

// ============ KAMERA İZNİ ============
// Sahneye çıkmış kullanıcının kamerasını backend'de cam_policy + max_cameras'a göre
// gerçekten yayın iznine bağla. Frontend toggleCam ÖNCE bu endpoint'i çağırır;
// 200 alırsa setCameraEnabled, başka türlü reddedilir.
app.post('/api/room/:name/cam-grant', camLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const me = req.user.nick;
    const stage = getRoomStage(roomName);
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, me);

    // 1) max_cameras = 0 → kamera tamamen kapalı oda (Sessiz Köşe gibi)
    const maxCams = def.max_cameras ?? 0;
    if (maxCams === 0) {
        return res.status(403).json({ success: false, error: 'Bu oda kamerasız ayarlanmış.' });
    }
    // 2) cam_policy enforcement
    const cp = def.cam_policy || 'speakers_only';
    if (cp === 'mod_only' && !isStaff && !isHost) {
        return res.status(403).json({ success: false, error: 'Bu odada kamera sadece host/mod için.' });
    }
    if (cp === 'speakers_only' && !stage.speakers[me]) {
        return res.status(403).json({ success: false, error: 'Önce sahneye çık (söz iste), sonra kamera aç.' });
    }
    // 3) max_cameras limit
    const camCount = cameraCount(stage);
    const already = stage.speakers[me] && (stage.speakers[me].type === 'cam' || stage.speakers[me].type === 'both');
    if (!already && camCount >= maxCams) {
        return res.status(429).json({ success: false, error: `Kamera dolu (${maxCams} kişi limit).` });
    }
    // 4) Stage'e cam tipini işle (sahnede değilse — mod_only host gibi — speakers'a koy)
    if (!stage.speakers[me]) {
        stage.speakers[me] = { ts: Date.now(), lastSpeakTs: Date.now(), type: 'cam' };
    } else {
        stage.speakers[me].type = 'both';
    }
    // 5) Codex bulgu #6: LiveKit permission — type'a göre source ver, kamera-only kullanıcıya
    // mic publish izni VERME. 'cam' = sadece camera, 'both' = mic + camera, 'mic' bu endpointe gelmez.
    const newType = stage.speakers[me].type;
    const sources = newType === 'cam' ? ['camera'] : ['microphone', 'camera'];
    try {
        await updateLiveKitPermission(roomName, me, { canPublish: true, sources });
    } catch (e) {
        // Rollback: stage tipini eski haline çevir
        if (newType === 'cam') delete stage.speakers[me];
        else stage.speakers[me].type = 'mic';
        return res.status(500).json({ success: false, error: 'Kamera izni LiveKit\'e iletilemedi: ' + e.message });
    }
    _persistStages();
    console.log(`[CAM] ${me} kamera açtı: ${roomName} (${cameraCount(stage)}/${maxCams}, type=${newType})`);
    res.json({ success: true, cameras: cameraCount(stage), max: maxCams });
});

app.post('/api/room/:name/cam-revoke', camLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    const target = identity || req.user.nick;
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isSelf = target.toLowerCase() === req.user.nick.toLowerCase();
    const isHost = isRoomHost(def, req.user.nick);  // host VEYA co-host
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isSelf && !isHost && !isStaff) {
        return res.status(403).json({ success: false, error: 'Sadece kendini ya da host/mod başkasının kamerasını kapatabilir.' });
    }
    const stage = getRoomStage(roomName);
    const sp = stage.speakers[target];
    if (!sp || (sp.type !== 'cam' && sp.type !== 'both')) {
        return res.json({ success: true, noop: true });
    }
    const prevType = sp.type;
    if (sp.type === 'cam') {
        // Sadece cam içindi (mod_only modunda dinleyici-cam senaryosu) → tamamen sahneden in
        delete stage.speakers[target];
        _persistStages();
        try {
            await updateLiveKitPermission(roomName, target, { canPublish: false, sources: [] });
        } catch (e) {
            stage.speakers[target] = { ...sp, type: prevType };
            return res.status(500).json({ success: false, error: 'Kamera kapatma LiveKit\'e iletilemedi: ' + e.message });
        }
    } else {
        // 'both' → mic kalsın, cam kapansın
        sp.type = 'mic';
        try {
            await updateLiveKitPermission(roomName, target, { canPublish: true, sources: ['microphone'] });
        } catch (e) {
            sp.type = prevType;
            return res.status(500).json({ success: false, error: 'Kamera kapatma LiveKit\'e iletilemedi: ' + e.message });
        }
    }
    _persistStages();
    console.log(`[CAM] ${target} kamera kapandı: ${roomName}`);
    res.json({ success: true });
});

// Stage tarayıcı — her 20sn:
// 1. Odadan ayrılanları sahneden çıkar
// 2. Speaker_time_limit dolanları indir
// 3. Silence_kick: uzun süre konuşmayanları indir
// 4. Auto-stage: boş slot varsa kuyruktan al
setInterval(async () => {
    const svc = getRoomServiceClient();
    if (!svc) return;
    for (const [roomName, stage] of _roomStages.entries()) {
        if (speakerCount(stage) === 0 && stage.queue.length === 0) continue;
        let participants;
        try { participants = await svc.listParticipants(roomName); }
        catch { continue; }
        const livingMap = new Map(); // nick(lc) → participant (audio activity için lastSpokeAt vs)
        participants.forEach(p => livingMap.set(p.identity.toLowerCase(), p));

        const def = await findRoomDef(roomName);
        const now = Date.now();
        const timeLimit = def?.speaker_time_limit || 0; // sn — 0 = sınırsız
        const silenceKick = def?.silence_kick_seconds || 0; // sn — 0 = kapalı

        // 1. Odadan ayrılan speakers temizliği
        for (const identity of Object.keys(stage.speakers)) {
            if (!livingMap.has(identity.toLowerCase())) {
                console.log(`[STAGE] ${identity} odadan ayrıldı, sahneden çıkarıldı`);
                delete stage.speakers[identity];
                _persistStages();
                continue;
            }
            const sp = stage.speakers[identity];
            const livingP = livingMap.get(identity.toLowerCase());
            // 2. Speaker time limit — İNDİRMEZ, sadece bir kez uyarı bildirimi gönderir
            if (timeLimit > 0 && (now - sp.ts) / 1000 > timeLimit && !sp.timeWarned) {
                console.log(`[STAGE] ${identity} süresi doldu (${timeLimit}sn) — uyarı bildirimi gönderildi`);
                sp.timeWarned = true;
                const users = await loadUsers();
                const u = users.find(x => x.nick.toLowerCase() === identity.toLowerCase());
                if (u) {
                    pushNotification(u.id, 'system', {
                        title: `⏰ Sahne süren doluyor`,
                        body: `"${roomName}" odasında ${Math.floor(timeLimit / 60)} dk'dan fazla konuşuyorsun — biraz toparla, sıradakilere yer aç.`,
                        link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(identity),
                    });
                }
                // Sahnedeyse kendine de okuyacağı şekilde flag — UI bunu görüp toast atabilir
            }
            // 3. Silence detection — İNDİRMEZ, mod varsa ona "X kişi 2dk konuşmadı" bildirimi
            if (silenceKick > 0) {
                const audioTracks = (livingP.tracks || []).filter(t => t.type === 1);
                const anyAudioActive = audioTracks.some(t => !t.muted);
                if (anyAudioActive) {
                    sp.lastSpeakTs = now;
                    sp.silenceWarned = false; // tekrar konuştu, uyarı flag'ini sıfırla
                } else if ((now - (sp.lastSpeakTs || sp.ts)) / 1000 > silenceKick && !sp.silenceWarned) {
                    sp.silenceWarned = true;
                    console.log(`[STAGE] ${identity} sessiz (${silenceKick}sn) — mod'lara bildirim`);
                    // Mod'lara bildirim — her admin/mod'a (odadakilere)
                    const users = await loadUsers();
                    for (const p of livingMap.values()) {
                        const u = users.find(x => x.nick.toLowerCase() === p.identity.toLowerCase());
                        if (u && (u.role === 'admin' || u.role === 'mod')) {
                            pushNotification(u.id, 'system', {
                                title: `🤫 Sessiz konuşmacı`,
                                body: `"${roomName}" odasında @${identity} ${Math.floor(silenceKick / 60)} dk'dır konuşmuyor — indirmek isteyebilirsin.`,
                                link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(p.identity),
                            });
                        }
                    }
                }
            }
        }

        // 4. Kuyrukta ama odada yoksa → çıkar
        const before = stage.queue.length;
        stage.queue = stage.queue.filter(q => livingMap.has(q.identity.toLowerCase()));
        if (before !== stage.queue.length) {
            _persistStages();
            console.log(`[STAGE] ${roomName} kuyruk temizlendi (${before} → ${stage.queue.length})`);
        }

        // 5. Auto-stage: boş slot + kuyruk + MOD YOK → sıradakini al
        if (def && def.auto_stage !== false && stage.queue.length > 0
            && speakerCount(stage) < ((def.max_speakers ?? 6))) {
            const modPresent = await hasModInRoom(roomName);
            if (!modPresent) {
                while (stage.queue.length > 0 && speakerCount(stage) < ((def.max_speakers ?? 6))) {
                    const next = stage.queue.shift();
                    _persistStages();
                    await grantStageInternal(roomName, next.identity, 'mic');
                }
            }
        }
    }
}, 20_000);

// Auto-close: 10dk'dan eski + boş üye odalarını sil (her 5dk çalışır)
// Host + co-host odadan ayrıldığı an kaydedilir; 5 dakika içinde geri dönmezlerse oda kapanır
// "Ev sahibi yoksa ev yıkılır" — odadaki diğer kullanıcılar yetkisiz kalmasın diye
const HOSTLESS_GRACE_MS = 5 * 60 * 1000;
const _hostlessSince = new Map();    // roomName → ts (host'un ayrıldığı an)
const _hostlessWarned = new Set();   // roomName → bot uyarı zaten gönderildi

async function autoCloseEmptyRooms() {
    const svc = getRoomServiceClient();
    if (!svc) return;
    const rooms = await loadUserRooms();
    if (rooms.length === 0) return;
    let live;
    try { live = await svc.listRooms(); } catch { return; }
    const liveMap = new Map(live.map(lr => [lr.name, lr.numParticipants]));
    const now = Date.now();
    const TEN_MIN = 10 * 60 * 1000;
    const toKeep = [];
    let removed = 0;

    for (const r of rooms) {
        const age = now - new Date(r.createdAt).getTime();
        const count = liveMap.get(r.name) || 0;
        const lkRoom = live.find(x => x.name === r.name);

        // 1) BOŞ ODA — 10dk
        if (age > TEN_MIN && count === 0) {
            console.log(`[ROOM] Auto-close (boş 10dk): ${r.name}`);
            removed++;
            svc.deleteRoom(r.name).catch((e) => { console.warn('[ROOM-CLEANUP] deleteRoom hatası:', r.name, e.message); });
            clearRoomBans(r.name);
            _hostlessSince.delete(r.name);
            _hostlessWarned.delete(r.name);
            try { pushActivity(`${r.name} odası boş kaldığı için kapandı`, '🚪'); } catch (e) { console.warn('[ROOM-CLEANUP] pushActivity hatası:', e.message); }
            pushModLog({ action: 'auto-close-empty', room: r.name, by: 'system' });
            continue;
        }

        // 2) HOSTLESS — host VEYA co-host odada yoksa grace period başlat
        if (count > 0 && lkRoom) {
            let participants = [];
            try { participants = await svc.listParticipants(r.name); } catch (e) { console.warn('[ROOM-CLEANUP] listParticipants hatası:', r.name, e.message); }
            const presentIds = new Set(participants.map(p => (p.identity || '').toLowerCase()));
            const hostPresent = r.host && presentIds.has(r.host.toLowerCase());
            const coHostPresent = Array.isArray(r.coHosts) && r.coHosts.some(n => presentIds.has((n || '').toLowerCase()));
            const anyHostPresent = hostPresent || coHostPresent;

            if (!anyHostPresent) {
                // Grace period başlat (ilk tespitte)
                if (!_hostlessSince.has(r.name)) {
                    _hostlessSince.set(r.name, now);
                    console.log(`[ROOM] Hostless tespit edildi: ${r.name} — 5dk grace başladı`);
                }
                const hostlessFor = now - _hostlessSince.get(r.name);
                // İlk uyarı bot mesajı
                if (!_hostlessWarned.has(r.name)) {
                    _hostlessWarned.add(r.name);
                    broadcastModBot(r.name, `⚠️ Ev sahibi (@${r.host}) ayrıldı. 5 dakika içinde geri dönmezse oda kapanacak.`);
                }
                // 5dk doldu → oda kapansın
                if (hostlessFor >= HOSTLESS_GRACE_MS) {
                    console.log(`[ROOM] Hostless 5dk doldu, kapanıyor: ${r.name}`);
                    removed++;
                    broadcastModBot(r.name, `🚪 Ev sahibi geri dönmedi — oda kapanıyor.`);
                    // Kullanıcıları LiveKit'ten çıkar
                    for (const p of participants) {
                        try { await svc.removeParticipant(r.name, p.identity); } catch (e) { console.warn('[ROOM-CLEANUP] removeParticipant hatası:', r.name, p.identity, e.message); }
                    }
                    svc.deleteRoom(r.name).catch((e) => { console.warn('[ROOM-CLEANUP] deleteRoom hatası:', r.name, e.message); });
                    clearRoomBans(r.name);
                    _hostlessSince.delete(r.name);
                    _hostlessWarned.delete(r.name);
                    try { pushActivity(`${r.name} odası ev sahibi dönmediği için kapandı`, '🚪'); } catch (e) { console.warn('[ROOM-CLEANUP] pushActivity hatası:', e.message); }
                    pushModLog({ action: 'auto-close-hostless', room: r.name, by: 'system', details: { host: r.host, coHosts: r.coHosts || [] } });
                    continue;
                }
            } else {
                // Host/co-host geri döndü — grace'i sıfırla
                if (_hostlessSince.has(r.name)) {
                    console.log(`[ROOM] Host/co-host geri döndü, grace iptal: ${r.name}`);
                    _hostlessSince.delete(r.name);
                    _hostlessWarned.delete(r.name);
                    broadcastModBot(r.name, `✅ Ev sahibi geri döndü, oda devam ediyor.`);
                }
            }
        } else {
            // Oda boş — hostless state'i de temizle (oda kapanmayı bekleyecek 10dk timeout)
            _hostlessSince.delete(r.name);
            _hostlessWarned.delete(r.name);
        }

        toKeep.push(r);
    }
    if (removed > 0) {
        await saveUserRooms(toKeep);
        roomCache.ts = 0;
    }
}
// Her 60sn — daha sık çalışır ki 5dk grace doğru zamanlansın (önceden 5dk'da bir çalışıyordu)
setInterval(autoCloseEmptyRooms, 60 * 1000);
setTimeout(autoCloseEmptyRooms, 30_000); // ilk çalıştırma 30sn sonra

// ============ Admin: Oda Yönetimi CRUD ============
app.get('/api/admin/rooms', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    res.json({ success: true, rooms: ROOM_DEFS });
});

// Oda CRUD — JWT + admin rolü ile, system_rooms.json'a kalıcı yazar
const VALID_CATEGORIES = new Set(['free', 'music', 'cam', 'book', 'game', 'hot']);
const VALID_MIC_POLICY = ['open', 'request', 'invite_only'];
// NOT: 'all' modu kaldırıldı (dinleyici LiveKit'te canPublish=false olduğu için anlamsızdı).
// Herkesin kameraya açılabilmesi mantıken zaten "dinleyici" tanımıyla çelişiyor.
const VALID_CAM_POLICY = ['speakers_only', 'mod_only'];
const VALID_AI_LEVEL = ['off', 'standard', 'strict'];
app.post('/api/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const {
        name, max, icon, category, badge, desc,
        // Opsiyonel ileri ayarlar — verilirse preset üstüne yazılır
        mic_policy, cam_policy, max_speakers, max_cameras,
        auto_stage, speaker_time_limit, silence_kick_seconds, ai_level,
        theme, cam_mode,
    } = req.body;
    if (!name || !max || !category) return res.status(400).json({ success: false, error: 'name, max ve category gerekli' });
    if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ success: false, error: 'Geçersiz kategori (free/music/cam/book/game/hot)' });
    if (ROOM_DEFS.find(r => r.name === name)) return res.status(400).json({ success: false, error: 'Bu isimde oda zaten var' });
    // Opsiyonel override'lara enum validation (PUT ile simetrik)
    if (mic_policy && !VALID_MIC_POLICY.includes(mic_policy)) return res.status(400).json({ success: false, error: 'Geçersiz mic_policy' });
    if (cam_policy && !VALID_CAM_POLICY.includes(cam_policy)) return res.status(400).json({ success: false, error: 'Geçersiz cam_policy' });
    if (ai_level && !VALID_AI_LEVEL.includes(ai_level)) return res.status(400).json({ success: false, error: 'Geçersiz ai_level' });
    if (theme && !VALID_ROOM_THEMES.has(theme)) return res.status(400).json({ success: false, error: 'Geçersiz tema' });
    // Kategori preset'ini uygula — mic/cam/sahne ayarları otomatik gelir; body'de override varsa o kazanır
    const newDef = applyPreset({
        name, max: parseInt(max), icon: icon || '💬', category,
        badge: badge || null, desc: desc || '',
        theme: (theme && VALID_ROOM_THEMES.has(theme)) ? theme : 'classic',
        ...(mic_policy !== undefined ? { mic_policy } : {}),
        ...(cam_policy !== undefined ? { cam_policy } : {}),
        ...(max_speakers !== undefined ? { max_speakers: parseInt(max_speakers) } : {}),
        ...(max_cameras !== undefined ? { max_cameras: parseInt(max_cameras) } : {}),
        ...(auto_stage !== undefined ? { auto_stage: !!auto_stage } : {}),
        ...(speaker_time_limit !== undefined ? { speaker_time_limit: parseInt(speaker_time_limit) } : {}),
        ...(silence_kick_seconds !== undefined ? { silence_kick_seconds: parseInt(silence_kick_seconds) } : {}),
        ...(ai_level !== undefined ? { ai_level } : {}),
    });
    if (cam_mode && ['camera','host_only','none'].includes(cam_mode)) applyCamMode(newDef, cam_mode);
    ROOM_DEFS.push(newDef);
    saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    console.log(`[ADMIN] Oda eklendi: ${name} (${category} preset, by ${req.user.nick})`);
    res.json({ success: true, rooms: ROOM_DEFS });
});

app.put('/api/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const {
        originalName, name, max, icon, category, badge, desc,
        mic_policy, cam_policy, max_speakers, max_cameras,
        auto_stage, speaker_time_limit, silence_kick_seconds, ai_level,
        theme, cam_mode,
    } = req.body;
    const idx = ROOM_DEFS.findIndex(r => r.name === originalName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı' });
    if (category && !VALID_CATEGORIES.has(category)) return res.status(400).json({ success: false, error: 'Geçersiz kategori' });
    if (mic_policy && !VALID_MIC_POLICY.includes(mic_policy)) return res.status(400).json({ success: false, error: 'Geçersiz mic_policy' });
    if (cam_policy && !VALID_CAM_POLICY.includes(cam_policy)) return res.status(400).json({ success: false, error: 'Geçersiz cam_policy' });
    if (ai_level && !VALID_AI_LEVEL.includes(ai_level)) return res.status(400).json({ success: false, error: 'Geçersiz ai_level' });
    if (theme && !VALID_ROOM_THEMES.has(theme)) return res.status(400).json({ success: false, error: 'Geçersiz tema' });

    const cur = ROOM_DEFS[idx];
    ROOM_DEFS[idx] = {
        ...cur,
        name: name || cur.name,
        max: parseInt(max) || cur.max,
        icon: icon || cur.icon,
        category: category || cur.category,
        badge: badge !== undefined ? badge : cur.badge,
        desc: desc !== undefined ? desc : cur.desc,
        // Sahne/kamera/otomasyon
        mic_policy: mic_policy || cur.mic_policy || 'request',
        cam_policy: cam_policy || cur.cam_policy || 'speakers_only',
        max_speakers: max_speakers !== undefined ? parseInt(max_speakers) : cur.max_speakers,
        max_cameras: max_cameras !== undefined ? parseInt(max_cameras) : cur.max_cameras,
        auto_stage: auto_stage !== undefined ? !!auto_stage : cur.auto_stage,
        speaker_time_limit: speaker_time_limit !== undefined ? parseInt(speaker_time_limit) : cur.speaker_time_limit,
        silence_kick_seconds: silence_kick_seconds !== undefined ? parseInt(silence_kick_seconds) : cur.silence_kick_seconds,
        ai_level: ai_level || cur.ai_level || 'standard',
        theme: (theme && VALID_ROOM_THEMES.has(theme)) ? theme : (cur.theme || 'classic'),
    };
    if (cam_mode && ['camera','host_only','none'].includes(cam_mode)) applyCamMode(ROOM_DEFS[idx], cam_mode);
    saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    console.log(`[ADMIN] Oda düzenlendi: ${originalName} → ${name || originalName} (by ${req.user.nick})`);
    res.json({ success: true, rooms: ROOM_DEFS });
});

app.delete('/api/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const { name } = req.body;
    const idx = ROOM_DEFS.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı' });
    ROOM_DEFS.splice(idx, 1);
    saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    console.log(`[ADMIN] Oda silindi: ${name} (by ${req.user.nick})`);
    res.json({ success: true, rooms: ROOM_DEFS });
});

// ============ Moderasyon: Manuel Kick (admin/mod) — JWT korumalı ============
// Codex bulgu #8: Kick sonrası 1 saat oda banı ekle — yoksa kullanıcı hemen geri girer.
// Body'de `ban: false` gönderirse soft-kick (sadece at, ban yok); default ban=true.
app.post('/api/kick', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room, identity, reason, ban } = req.body;
    if (!room || !identity) return res.status(400).json({ success: false, error: 'room ve identity gerekli' });
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    try {
        await svc.removeParticipant(room, identity);
        const applyBan = ban !== false; // default true
        if (applyBan) {
            addRoomBan(room, identity, req.user.nick, reason || 'Admin/mod kick');
        }
        console.log(`[MOD] ${identity} odadan atıldı: ${room} (Sebep: ${reason || 'belirtilmedi'}, ban: ${applyBan ? '1h' : 'yok'}, by ${req.user.nick})`);
        roomCache.ts = 0;
        pushModLog({ action: 'admin-kick', room, by: req.user.nick, target: identity, reason, details: { ban: applyBan ? '1h' : 'none' } });
        res.json({ success: true, message: `${identity} odadan atıldı${applyBan ? ' + 1 saat odadan uzaklaştırıldı' : ''}`, ban: applyBan ? '1h' : 'none' });
    } catch (err) {
        console.error('[MOD] Kick hatası:', err.message);
        res.status(500).json({ success: false, error: 'Kullanıcı atılamadı: ' + err.message });
    }
});

// ============ Moderasyon: Manuel Sustur (admin/mod) — JWT korumalı ============
app.post('/api/mute', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room, identity } = req.body;
    if (!room || !identity) return res.status(400).json({ success: false, error: 'room ve identity gerekli' });
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    try {
        const participants = await svc.listParticipants(room);
        const target = participants.find(p => p.identity === identity);
        if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        for (const track of target.tracks) {
            if (track.type === 1) {
                await svc.mutePublishedTrack(room, identity, track.sid, true);
            }
        }
        console.log(`[MOD] ${identity} susturuldu: ${room} (by ${req.user.nick})`);
        roomCache.ts = 0;
        pushModLog({ action: 'admin-mute', room, by: req.user.nick, target: identity });
        res.json({ success: true, message: `${identity} susturuldu` });
    } catch (err) {
        console.error('[MOD] Mute hatası:', err.message);
        res.status(500).json({ success: false, error: 'Susturma başarısız: ' + err.message });
    }
});

// ============ Davet (Invite) yardımcıları ============
function generateInviteCode() {
    // 8 char base36 — kısa + URL-friendly
    return crypto.randomBytes(5).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
}
function ensureInviteCode(user, users) {
    if (!user.invite_code) {
        // Benzersiz kod üret
        let code, tries = 0;
        do {
            code = generateInviteCode();
            tries++;
        } while (users.find(u => u.invite_code === code) && tries < 20);
        user.invite_code = code;
        return true; // değişiklik var
    }
    return false;
}

// ============ Kullanıcı Deposu (JSON) ============
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
// JWT_SECRET zorunlu — env'de yoksa fail-fast (eski hardcoded fallback güvenlik açığıydı)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('[FATAL] JWT_SECRET env değişkeni en az 32 karakter olmalı. .env dosyasına ekle.');
    process.exit(1);
}
const BCRYPT_ROUNDS = 10;

async function ensureDataDir() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    try { await fs.promises.access(USERS_FILE); } catch { await fs.promises.writeFile(USERS_FILE, '[]', 'utf8'); }
}

// Atomic JSON write — önce .tmp dosyaya yaz, sonra rename.
// Yarım yazılmış JSON dosyası kalmaz (process kill, disk dolu, vs. olsa bile)
async function atomicWriteJson(filePath, data) {
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
}

async function loadUsers() {
    await ensureDataDir();
    try {
        return JSON.parse(await fs.promises.readFile(USERS_FILE, 'utf8'));
    } catch { return []; }
}

async function saveUsers(users) {
    await ensureDataDir();
    await atomicWriteJson(USERS_FILE, users);
}

// bcrypt + legacy SHA-256 doğrulama (eski kayıtlar için geriye uyum)
async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}
async function verifyPassword(password, stored) {
    if (!stored) return false;
    // bcrypt hash $2a$/$2b$/$2y$ ile başlar
    if (stored.startsWith('$2')) return bcrypt.compare(password, stored);
    // Eski SHA-256 (64 hex char) — bir kerelik kabul, sonra otomatik upgrade tetiklenir
    const sha = crypto.createHash('sha256').update(password).digest('hex');
    return stored === sha;
}

// ============ Kayıt (Register) ============
app.post('/api/register', authLimiter, async (req, res) => {
    const { nick, password, invite_code, email, birthYear } = req.body;
    if (!nick || !password) {
        return res.status(400).json({ success: false, error: 'Nick ve şifre gerekli' });
    }
    if (nick.length < 2 || nick.length > 20) {
        return res.status(400).json({ success: false, error: 'Nick 2-20 karakter olmalı' });
    }
    if (!/^[a-zA-Z0-9_çğıöşüÇĞİÖŞÜ]+$/.test(nick)) {
        return res.status(400).json({ success: false, error: 'Nick sadece harf, rakam ve _ içerebilir' });
    }
    if (password.length < 4) {
        return res.status(400).json({ success: false, error: 'Şifre en az 4 karakter olmalı' });
    }
    // ============ DOĞUM YILI + YAŞ KONTROLÜ (13+ zorunlu, KVKK + çocuk koruma) ============
    const currentYear = new Date().getFullYear();
    const by = parseInt(birthYear);
    if (!by || isNaN(by)) {
        return res.status(400).json({ success: false, error: 'Doğum yılı gerekli (yaş kontrolü için).' });
    }
    if (by < 1925 || by > currentYear - 13) {
        const minYear = currentYear - 100;
        const maxYear = currentYear - 13;
        return res.status(400).json({ success: false, error: `Doğum yılı ${minYear}-${maxYear} arasında olmalı (13 yaş altı kayıt olamaz).` });
    }
    const validatedBirthYear = by;
    // Email opsiyonel — varsa formatla + tekillik
    let cleanedEmail = '';
    if (email && String(email).trim()) {
        cleanedEmail = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail)) {
            return res.status(400).json({ success: false, error: 'Geçerli bir email gir veya boş bırak' });
        }
    }

    const users = await loadUsers();
    const exists = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
    if (exists) {
        return res.status(409).json({ success: false, error: 'Bu nick zaten alınmış' });
    }
    if (cleanedEmail) {
        const emailDup = users.find(u => (u.email || '').toLowerCase() === cleanedEmail);
        if (emailDup) {
            return res.status(409).json({ success: false, error: 'Bu email başka bir hesapta kullanılıyor' });
        }
    }

    // Davet eden var mı?
    let inviter = null;
    if (invite_code) {
        inviter = users.find(u => u.invite_code === invite_code);
    }

    // ENV'de tanımlı admin email ise otomatik admin rolü
    const adminEmails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
    const initialRole = (cleanedEmail && adminEmails.includes(cleanedEmail)) ? 'admin' : 'user';

    const user = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        nick: nick,
        password: await hashPassword(password),
        role: initialRole,
        birthYear: validatedBirthYear,
        createdAt: new Date().toISOString(),
        invited_by: inviter ? inviter.id : null,
    };
    if (cleanedEmail) user.email = cleanedEmail;
    ensureInviteCode(user, users); // yeni user'ın da davet kodu olsun
    users.push(user);
    await saveUsers(users);

    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Yeni kayıt: ${nick}${inviter ? ' (davet eden: ' + inviter.nick + ')' : ''}`);
    try {
        pushActivity(`${nick} aramıza katıldı${inviter ? ' (' + inviter.nick + ' davet etti)' : ''}`, '👋');
        // Davet eden kişiye bildirim
        if (inviter) {
            pushNotification(inviter.id, 'invite_used', {
                title: `🎟️ Davet ettiğin ${nick} aramıza katıldı!`,
                body: `Davet linkin işe yaradı — yeni arkadaşlık fırsatı!`,
                link: '/u/' + encodeURIComponent(nick),
                from: nick,
            });
        }
    } catch (e) { console.error('[AUTH] Kayıt sonrası aktivite/bildirim hatası:', e.message); }
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// ============ Giriş (Login) ============
app.post('/api/login', authLimiter, async (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) {
        return res.status(400).json({ success: false, error: 'Nick ve şifre gerekli' });
    }

    const users = await loadUsers();
    // Email VEYA nick ile login
    const lcInput = nick.toLowerCase();
    const user = users.find(u =>
        u.nick.toLowerCase() === lcInput ||
        (u.email || '').toLowerCase() === lcInput
    );
    // Kullanıcı yok
    if (!user) {
        return res.status(401).json({ success: false, error: 'Nick/email veya şifre yanlış' });
    }
    // Google-only hesap (şifre yok)
    if (user.google_sub && !user.password) {
        return res.status(401).json({
            success: false,
            error: 'Bu hesap Google ile bağlı — aşağıdan "Google ile Giriş Yap" butonuna bas.',
            code: 'google_only',
            email: user.email || null,
        });
    }
    // Şifre yanlış
    if (!await verifyPassword(password, user.password)) {
        return res.status(401).json({ success: false, error: 'Nick/email veya şifre yanlış' });
    }

    // Legacy SHA-256 hash'i otomatik bcrypt'e upgrade
    if (user.password && !user.password.startsWith('$2')) {
        user.password = await hashPassword(password);
        await saveUsers(users);
        console.log(`[AUTH] Şifre hash upgrade: ${user.nick}`);
    }

    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Giriş: ${user.nick}`);
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// ============ Google ile Giriş / Kayıt ============
// Frontend Google Identity Services ile ID token alır, buraya POST eder.
// Aynı email ile daha önce kayıt varsa giriş, yoksa otomatik kayıt.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

app.get('/api/config', async (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
    if (!googleClient) {
        return res.status(503).json({ success: false, error: 'Google girişi yapılandırılmamış (GOOGLE_CLIENT_ID eksik).' });
    }
    const { credential, invite_code } = req.body;
    if (!credential) {
        return res.status(400).json({ success: false, error: 'credential gerekli' });
    }
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const googleSub = payload.sub;
        const email = (payload.email || '').toLowerCase();
        const emailVerified = payload.email_verified === true;
        const givenName = payload.given_name || '';
        const fullName = payload.name || '';

        if (!emailVerified) {
            return res.status(401).json({ success: false, error: 'Google hesabı email doğrulanmamış.' });
        }

        const users = await loadUsers();

        // 1) Önce google_sub ile bağlı kullanıcıyı ara
        let user = users.find(u => u.google_sub === googleSub);

        // 2) Yoksa email ile eşleştir + google_sub'ı bağla
        if (!user && email) {
            user = users.find(u => (u.email || '').toLowerCase() === email);
            if (user) {
                user.google_sub = googleSub;
                await saveUsers(users);
            }
        }

        // 3) Yine yoksa yeni kayıt oluştur (nick'i tekille — email local-part'tan türet)
        if (!user) {
            const baseNick = (givenName || email.split('@')[0] || 'retro').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'retro';
            let nick = baseNick;
            let i = 1;
            while (users.find(u => u.nick.toLowerCase() === nick.toLowerCase())) {
                nick = `${baseNick}${i++}`;
                if (i > 999) break;
            }
            // Davet eden var mı?
            let inviter = null;
            if (invite_code) {
                inviter = users.find(u => u.invite_code === invite_code);
            }
            // ENV'de tanımlı admin email ise otomatik admin rolü ata
            const adminEmails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
            const initialRole = adminEmails.includes(email) ? 'admin' : 'user';
            user = {
                id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                nick,
                email,
                google_sub: googleSub,
                display_name: fullName,
                role: initialRole,
                createdAt: new Date().toISOString(),
                invited_by: inviter ? inviter.id : null,
            };
            ensureInviteCode(user, users);
            users.push(user);
            await saveUsers(users);
            console.log(`[AUTH] Google kayit: ${nick} (${email}) — rol: ${initialRole}${inviter ? ' (davet eden: ' + inviter.nick + ')' : ''}`);
            try {
                pushActivity(`${nick} aramıza katıldı${inviter ? ' (' + inviter.nick + ' davet etti)' : ''}`, '👋');
                if (inviter) {
                    pushNotification(inviter.id, 'invite_used', {
                        title: `🎟️ Davet ettiğin ${nick} aramıza katıldı!`,
                        body: `Davet linkin işe yaradı — yeni arkadaşlık fırsatı!`,
                        link: '/u/' + encodeURIComponent(nick),
                        from: nick,
                    });
                }
            } catch (e) { console.error('[AUTH] Google kayıt aktivite/bildirim hatası:', e.message); }
        } else {
            // Mevcut kullanıcı — admin email listesinde varsa rolünü admin'e yükselt (silinmesin)
            const adminEmails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
            if (adminEmails.includes((user.email || '').toLowerCase()) && user.role !== 'admin') {
                user.role = 'admin';
                await saveUsers(users);
                console.log(`[AUTH] ${user.nick} ADMIN yetkisine yükseltildi (${email})`);
            }
            console.log(`[AUTH] Google giris: ${user.nick} (${email}) — rol: ${user.role}`);
        }

        const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, nick: user.nick, role: user.role });
    } catch (err) {
        console.error('[AUTH] Google verify hatasi:', err.message);
        res.status(401).json({ success: false, error: 'Google girisi dogrulanamadi: ' + err.message });
    }
});

// ============ Misafir Modu (Guest) ============
// Kayıt zorunsuz hızlı giriş — random nick + 24sa JWT + role='guest'.
// Misafirler: odaları dinler, anasayfayı görür, profiller görür.
// Yapamaz: DM gönder, oda mesajı yaz, profil oluştur. (frontend + backend guard)
const GUEST_ADJ = ['Sessiz', 'Nostaljik', 'Eski', 'Yıldız', 'Mavi', 'Altın', 'Gece', 'Mor', 'Ay', 'Yağmur', 'Rüzgar', 'Bulut'];
const GUEST_NOUN = ['Kaset', 'Walkman', 'Plak', 'Radyo', 'Şahin', 'Tofaş', 'Disket', 'TV', 'Modem', 'Kafe', 'Sokak', 'Defter'];

function genGuestNick() {
    const adj = GUEST_ADJ[Math.floor(Math.random() * GUEST_ADJ.length)];
    const noun = GUEST_NOUN[Math.floor(Math.random() * GUEST_NOUN.length)];
    const num = Math.floor(Math.random() * 900) + 100;
    // Format: "RetroXxxYyy123" — brand'e uyumlu, "Misafir_" prefix kaldırıldı (kullanıcı feedback)
    return `Retro${adj}${noun}${num}`;
}

app.post('/api/auth/guest', authLimiter, async (req, res) => {
    // Misafir kullanıcı disk'e kaydedilmez — sadece JWT içinde yaşar
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const nick = genGuestNick();
    const token = jwt.sign({ id, nick, role: 'guest' }, JWT_SECRET, { expiresIn: '24h' });
    console.log(`[AUTH] Misafir giriş: ${nick}`);
    try { pushActivity(`${nick} misafir olarak göz attı`, '👀'); } catch (e) { console.warn('[AUTH] pushActivity hatası:', e.message); }
    res.json({ success: true, token, nick, role: 'guest' });
});

// ============ Oturum Kontrolü (Me) — profil bilgileri dahil ============
app.get('/api/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        // Misafir kullanıcılar disk'te yok — JWT'den direkt geri dön
        if (decoded.role === 'guest') {
            return res.json({
                success: true, nick: decoded.nick, role: 'guest', id: decoded.id,
                avatar: 'default', bio: '', status: 'online', personal_msg: '',
                createdAt: new Date(decoded.iat * 1000).toISOString(),
            });
        }
        const users = await loadUsers();
        const user = users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        res.json({
            success: true, nick: user.nick, role: user.role, id: user.id,
            avatar: user.avatar || 'default', bio: user.bio || '',
            status: user.status || 'online',
            personal_msg: user.personal_msg || '',
            birthYear: user.birthYear || null,
            age: calcAge(user.birthYear),
            isAdult: isAdult(user.birthYear),
            hasGoogle: !!user.google_sub,
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

// MSN-style status keys: online, busy, brb, away, invisible
const STATUS_KEYS = new Set(['online', 'busy', 'brb', 'away', 'invisible']);

app.post('/api/profile', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler profil düzenleyemez' });
    }
    const { avatar, bio, status, personal_msg, about, birthYear, city, musicTaste, instagram, twitter } = req.body;
    const users = await loadUsers();
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    if (avatar && AVATAR_LIST.includes(avatar)) user.avatar = avatar;
    if (bio !== undefined) user.bio = String(bio).substring(0, 60);
    if (status && STATUS_KEYS.has(status)) user.status = status;
    if (personal_msg !== undefined) user.personal_msg = String(personal_msg).substring(0, 100);
    // Yeni "hakkımda" alanları
    if (about !== undefined) user.about = String(about).substring(0, 500);
    if (birthYear !== undefined) {
        const yr = parseInt(birthYear);
        if (yr >= 1950 && yr <= 2020) user.birthYear = yr;
        else if (birthYear === '' || birthYear === null) delete user.birthYear;
    }
    if (city !== undefined) user.city = String(city).substring(0, 40);
    if (musicTaste !== undefined) user.musicTaste = String(musicTaste).substring(0, 150);
    if (instagram !== undefined) {
        // Sadece kullanıcı adı (@ olmadan), max 30 char, alphanumeric+._
        const ig = String(instagram).replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '').substring(0, 30);
        user.instagram = ig;
    }
    if (twitter !== undefined) {
        const tw = String(twitter).replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 15);
        user.twitter = tw;
    }

    await saveUsers(users);
    console.log(`[PROFILE] ${user.nick} profil güncelledi`);
    res.json({
        success: true,
        avatar: user.avatar, bio: user.bio, status: user.status, personal_msg: user.personal_msg,
        about: user.about, birthYear: user.birthYear, city: user.city, musicTaste: user.musicTaste,
        instagram: user.instagram, twitter: user.twitter,
    });
});

// ============ DÜRT (NUDGE) — friend-only + spam koruma ============
// Kullanıcının nudge_pref alanı: 'all' | 'friends' | 'none' (default 'friends')
// Rate-limit: gönderici → alıcı, 60sn'de 1 nudge (in-memory)
const _nudgeCooldowns = new Map(); // key: "fromId:toId" → lastTs
const NUDGE_COOLDOWN_MS = 60 * 1000;

app.post('/api/users/:nick/nudge', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler dürtemez.' });
    }
    const targetNick = req.params.nick;
    if (targetNick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini dürtemezsin.' });
    }
    const users = await loadUsers();
    const target = users.find(u => u.nick.toLowerCase() === targetNick.toLowerCase());
    if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı.' });

    // Tercih kontrolü
    const pref = target.nudge_pref || 'friends';
    if (pref === 'none') {
        return res.status(403).json({ success: false, error: `${target.nick} dürt kabul etmiyor.` });
    }
    if (pref === 'friends') {
        const targetFriends = ((await getFriendsOf(target.id)) || []).map(n => n.toLowerCase());
        if (!targetFriends.includes(req.user.nick.toLowerCase())) {
            return res.status(403).json({ success: false, error: `${target.nick} sadece arkadaşlarından dürt kabul ediyor.` });
        }
    }
    // Rate limit
    const key = req.user.id + ':' + target.id;
    const last = _nudgeCooldowns.get(key) || 0;
    const remaining = NUDGE_COOLDOWN_MS - (Date.now() - last);
    if (remaining > 0) {
        return res.status(429).json({ success: false, error: `Çok hızlı — ${Math.ceil(remaining / 1000)}sn sonra tekrar dene.` });
    }
    _nudgeCooldowns.set(key, Date.now());

    console.log(`[NUDGE] ${req.user.nick} → ${target.nick}`);
    // Bildirim
    pushNotification(target.id, 'dm', {
        title: `📳 ${req.user.nick} seni dürttü!`,
        body: 'Dürt — bir merhaba kadar samimi!',
        link: '/?dm=' + encodeURIComponent(req.user.nick),
        from: req.user.nick,
    });
    res.json({ success: true });
});

// Tercih güncelle (dürt + bildirim sesi vs)
app.post('/api/account/preferences', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafir tercih ayarlayamaz.' });
    const { nudge_pref, sound_enabled } = req.body;
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı.' });
    if (nudge_pref !== undefined) {
        if (!['all', 'friends', 'none'].includes(nudge_pref)) {
            return res.status(400).json({ success: false, error: 'nudge_pref: all|friends|none olmalı.' });
        }
        u.nudge_pref = nudge_pref;
    }
    if (sound_enabled !== undefined) {
        u.sound_enabled = !!sound_enabled;
    }
    await saveUsers(users);
    res.json({
        success: true,
        nudge_pref: u.nudge_pref || 'friends',
        sound_enabled: u.sound_enabled !== false,
    });
});

// ============ HESAP YÖNETİMİ ============
// /api/account/me — kendi PRIVATE bilgilerim (email vb.)
app.get('/api/account/me', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin hesabı yok' });
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    res.json({
        success: true,
        nick: u.nick,
        email: u.email || '',
        hasPassword: !!u.password,
        googleLinked: !!u.google_sub,
        role: u.role,
        createdAt: u.createdAt,
        nudge_pref: u.nudge_pref || 'friends',
        sound_enabled: u.sound_enabled !== false,
        birthYear: u.birthYear || null,
        age: calcAge(u.birthYear),
        isAdult: isAdult(u.birthYear),
        // Codex D paketi: privacy ayarları UI form için
        privacy: u.privacy || { hideBirthYear: false, hideActiveRoom: false, hideInviteCode: false, hideFriends: false, dmFrom: 'all' },
    });
});

// ============ ŞİFRE SIFIRLAMA (email ile) ============
// data/password_resets.json — { token, userId, email, expiresAt, used, createdAt }
function resetsFile() { return path.join(DATA_DIR, 'password_resets.json'); }
async function loadResets() {
    try {
        const f = resetsFile();
        try { await fs.promises.access(f); } catch { await ensureDataDir(); await fs.promises.writeFile(f, '[]', 'utf8'); return []; }
        return JSON.parse(await fs.promises.readFile(f, 'utf8'));
    } catch { return []; }
}
async function saveResets(arr) {
    try { await ensureDataDir(); await atomicWriteJson(resetsFile(), arr); }
    catch (e) { console.error('[RESET] save fail:', e.message); }
}
// Rate limit: aynı email saatte max 3 istek
const _resetRequestHistory = new Map(); // emailLc → [ts...]
function resetRateOk(emailLc) {
    const now = Date.now();
    const hist = (_resetRequestHistory.get(emailLc) || []).filter(t => now - t < 60 * 60 * 1000);
    if (hist.length >= 3) return false;
    hist.push(now);
    _resetRequestHistory.set(emailLc, hist);
    return true;
}

// İstek gönder — email girip linki almak
app.post('/api/account/password-reset/request', authLimiter, async (req, res) => {
    const { email } = req.body;
    const cleaned = String(email || '').trim().toLowerCase();
    if (!cleaned || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
        return res.status(400).json({ success: false, error: 'Geçerli email gerekli' });
    }
    if (!resetRateOk(cleaned)) {
        return res.status(429).json({ success: false, error: 'Bu email için saatte 3 istek limitine ulaşıldı.' });
    }
    // GÜVENLİK: email var olsun olmasın aynı response → enumeration koruması
    const SUCCESS_RESPONSE = {
        success: true,
        message: 'Eğer bu email kayıtlıysa, sıfırlama linki gönderildi. 5 dakika içinde gelmezse spam klasörüne bak.',
    };
    const users = await loadUsers();
    const user = users.find(u => (u.email || '').toLowerCase() === cleaned);
    if (!user) {
        console.log(`[RESET] Kayıtsız email için istek: ${cleaned}`);
        return res.json(SUCCESS_RESPONSE);
    }
    // Google ile bağlıysa ve şifresi yoksa — Google'a yönlendir mesajı
    if (user.google_sub && !user.password) {
        console.log(`[RESET] Google-only kullanıcı: ${user.nick}`);
        const baseUrl = process.env.PUBLIC_URL || 'https://retrosesler.com';
        try {
            await sendMail({
                to: cleaned,
                subject: 'RetroSesler — Hesabın Google ile bağlı 🔵',
                text: `Merhaba ${user.nick},\n\nHesabın Google ile bağlı olduğu için ayrı bir şifren yok. RetroSesler'e giriş yapmak için Google ile giriş yapmaya devam edebilirsin.\n\nEğer ayrı bir şifre belirlemek istiyorsan, önce Google ile giriş yap, sonra Profil → Hesap & Güvenlik sekmesinden şifre belirleyebilirsin.\n\nGiriş: ${baseUrl}/giris\n\n— RetroSesler.com`,
                html: `
                    <div style="font-family:Tahoma,Verdana,sans-serif;max-width:520px;margin:0 auto;border:2px solid #A09880;border-radius:6px;background:#FAFAF5;overflow:hidden">
                        <div style="background:linear-gradient(180deg,#4A90D9,#2E6BBF);color:#fff;padding:10px 16px;font-weight:bold;font-size:13px;text-shadow:1px 1px 1px rgba(0,0,0,0.4)">
                            🔵 RetroSesler — Google ile Bağlı Hesap
                        </div>
                        <div style="padding:20px;color:#222;font-size:13px;line-height:1.55">
                            <p style="margin:0 0 12px">Merhaba <b style="color:#1E4070">${user.nick}</b>,</p>
                            <p style="margin:0 0 12px">Şifre sıfırlama isteği aldık ama hesabın <b>Google ile bağlı</b> olduğu için ayrı bir şifren yok.</p>
                            <p style="margin:0 0 14px">Giriş yapmak için sadece <b>Google ile devam et</b> butonuna basman yeterli — bambaşka şifreye ihtiyacın yok.</p>
                            <p style="text-align:center;margin:18px 0">
                                <a href="${baseUrl}/giris" style="display:inline-block;background:linear-gradient(180deg,#4A90D9,#2E6BBF);color:#fff;padding:11px 26px;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:0.5px;border:1px solid #1E5AA8">🔵 Google ile Gir</a>
                            </p>
                            <div style="margin-top:18px;padding:12px 14px;background:#FFF8E1;border-left:3px solid #E0C870;font-size:12px;color:#7d6608">
                                💡 <b>İpucu:</b> Eğer Google'la giriş dışında <b>ayrı bir şifre</b> de belirlemek istersen — önce Google ile gir, sonra <b>Profil → Hesap & Güvenlik</b> sekmesinden "Şifre Belirle" yapabilirsin. Sonrasında hem Google ile hem şifreyle giriş yapabilirsin.
                            </div>
                            <p style="margin-top:18px;padding-top:14px;border-top:1px solid #ddd;font-size:11px;color:#888">
                                Bu isteği sen yapmadıysan görmezden gel — hesabın güvende, Google ile bağlı olduğu için kimse şifre değiştirmeyle giremez.
                            </p>
                        </div>
                        <div style="background:#ECE9D8;padding:8px 14px;font-size:10px;color:#666;text-align:center;border-top:1px solid #c8c3b5">
                            RetroSesler.com — 2000'lerin sohbet kültürü, modern teknoloji
                        </div>
                    </div>
                `,
            });
        } catch (e) { console.warn('[RESET] mail send fail:', e.message); }
        return res.json(SUCCESS_RESPONSE);
    }
    // Token üret (32 byte rastgele hex)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 saat
    const resets = await loadResets();
    // Aynı kullanıcının eski pending tokenlarını invalidate et
    resets.forEach(r => { if (r.userId === user.id && !r.used) r.used = true; });
    resets.push({
        token, userId: user.id, email: cleaned, expiresAt, used: false, createdAt: Date.now(),
    });
    // Eski tokenları temizle (1 günden eski)
    const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cleanedResets = resets.filter(r => r.createdAt > dayCutoff);
    await saveResets(cleanedResets);
    // Mail gönder
    const baseUrl = process.env.PUBLIC_URL || `https://retrosesler.com`;
    const resetUrl = `${baseUrl}/sifre-sifirla?token=${token}`;
    try {
        await sendMail({
            to: cleaned,
            subject: 'RetroSesler — Şifre Sıfırlama',
            text: `Merhaba ${user.nick},\n\nRetroSesler.com hesabın için şifre sıfırlama isteği aldık.\n\nYeni şifre belirlemek için aşağıdaki linke tıkla (1 saat geçerli):\n\n${resetUrl}\n\nEğer bu isteği sen yapmadıysan bu maili görmezden gel — hesabın güvende.\n\n— RetroSesler.com`,
            html: `
                <div style="font-family:Tahoma,sans-serif;max-width:520px;margin:0 auto;border:2px solid #A09880;border-radius:6px;background:#FAFAF5">
                    <div style="background:linear-gradient(180deg,#4A90D9,#2E6BBF);color:#fff;padding:12px 16px;font-weight:bold;font-size:14px">
                        🔑 RetroSesler — Şifre Sıfırlama
                    </div>
                    <div style="padding:18px;color:#333;font-size:13px;line-height:1.5">
                        <p>Merhaba <b>${user.nick}</b>,</p>
                        <p>RetroSesler.com hesabın için şifre sıfırlama isteği aldık.</p>
                        <p style="text-align:center;margin:20px 0">
                            <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(180deg,#4A90D9,#2E6BBF);color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:bold">🔓 Yeni Şifre Belirle</a>
                        </p>
                        <p style="font-size:11px;color:#666">Bu link <b>1 saat</b> geçerli. Linke tıklayamıyorsan tarayıcına yapıştır:<br><code style="background:#fff;padding:3px 6px;border:1px solid #ddd;word-break:break-all;display:inline-block;margin-top:4px">${resetUrl}</code></p>
                        <p style="font-size:11px;color:#888;margin-top:20px;padding-top:14px;border-top:1px solid #ddd">Bu isteği sen yapmadıysan görmezden gel — hesabın güvende.</p>
                    </div>
                </div>
            `,
        });
        console.log(`[RESET] Mail gönderildi: ${user.nick} (${cleaned})`);
    } catch (err) {
        console.error('[RESET] Mail gönderim hatası:', err.message);
        // Yine de success dön (kullanıcı hata görmesin — enumeration koruması)
    }
    res.json(SUCCESS_RESPONSE);
});

// Token doğrula (frontend reset.html'de token geçerliliğini kontrol için)
app.get('/api/account/password-reset/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'Token gerekli' });
    const resets = await loadResets();
    const r = resets.find(x => x.token === token);
    if (!r || r.used || r.expiresAt < Date.now()) {
        return res.status(400).json({ success: false, error: 'Token geçersiz veya süresi dolmuş.' });
    }
    res.json({ success: true });
});

// Yeni şifre belirle (token + newPassword)
app.post('/api/account/password-reset/confirm', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ success: false, error: 'token ve newPassword gerekli' });
    if (typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 64) {
        return res.status(400).json({ success: false, error: 'Şifre 4-64 karakter olmalı' });
    }
    const resets = await loadResets();
    const r = resets.find(x => x.token === token);
    if (!r || r.used || r.expiresAt < Date.now()) {
        return res.status(400).json({ success: false, error: 'Token geçersiz veya süresi dolmuş.' });
    }
    const users = await loadUsers();
    const user = users.find(u => u.id === r.userId);
    if (!user) {
        r.used = true;
        await saveResets(resets);
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı.' });
    }
    user.password = await bcrypt.hash(String(newPassword), 10);
    await saveUsers(users);
    r.used = true;
    r.usedAt = Date.now();
    await saveResets(resets);
    console.log(`[RESET] ${user.nick} şifresini yeniledi (email reset)`);
    // Bildirim
    pushNotification(user.id, 'system', {
        title: '🔐 Şifren değişti',
        body: 'Email ile şifren yenilendi. Bu sen değilsen hemen tekrar şifreni değiştir.',
        link: '/u/' + encodeURIComponent(user.nick) + '?edit=1',
    });
    res.json({ success: true, message: 'Şifren yenilendi. Şimdi yeni şifrenle giriş yapabilirsin.' });
});

// Şifre değiştir — eski şifre + yeni şifre (Google-only hesaplar için eski şifre opsiyonel)
app.post('/api/account/password', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirler şifre değiştiremez' });
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 64) {
        return res.status(400).json({ success: false, error: 'Yeni şifre 4-64 karakter olmalı' });
    }
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    // Mevcut şifre varsa doğrula
    if (u.password) {
        if (!currentPassword) return res.status(400).json({ success: false, error: 'Mevcut şifrenizi girin' });
        const ok = await bcrypt.compare(String(currentPassword), u.password);
        if (!ok) return res.status(401).json({ success: false, error: 'Mevcut şifre yanlış' });
    }
    u.password = await bcrypt.hash(String(newPassword), 10);
    await saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} şifresini değiştirdi`);
    res.json({ success: true, message: 'Şifre güncellendi' });
});

// Email ekle veya değiştir — Google ile bağlıysa email Google'dan gelir, manuel yazılamaz
app.post('/api/account/email', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin emaili yok' });
    const { email } = req.body;
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.google_sub) {
        return res.status(400).json({ success: false, error: 'Email Google hesabınızdan otomatik gelir, manuel değiştirilemez.' });
    }
    const cleaned = String(email || '').trim().toLowerCase();
    if (cleaned && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
        return res.status(400).json({ success: false, error: 'Geçersiz email' });
    }
    // Başka kullanıcıda var mı?
    if (cleaned) {
        const dup = users.find(x => x.id !== u.id && (x.email || '').toLowerCase() === cleaned);
        if (dup) return res.status(409).json({ success: false, error: 'Bu email başka bir hesapta kullanılıyor' });
    }
    u.email = cleaned;
    await saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} email güncelledi: ${cleaned || '(silindi)'}`);
    res.json({ success: true, email: u.email });
});

// Doğum yılı tamamlama (Google ile giren kullanıcılar register'da girmedikleri için)
// Bir kez set edildikten sonra değiştirilemez (yaş kontrolünü atlatma engeli)
app.post('/api/account/birth-year', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin yaş bilgisi yok' });
    const by = parseInt(req.body?.birthYear);
    if (!by || isNaN(by)) return res.status(400).json({ success: false, error: 'Doğum yılı sayısal olmalı.' });
    const currentYear = new Date().getFullYear();
    if (by < 1925 || by > currentYear - 13) {
        return res.status(400).json({ success: false, error: `Doğum yılı ${currentYear - 100}-${currentYear - 13} arasında olmalı (13 yaş altı kullanıcı olamaz).` });
    }
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.birthYear) {
        return res.status(409).json({ success: false, error: 'Doğum yılı önceden girilmiş — değişiklik için admin ile iletişime geç.' });
    }
    u.birthYear = by;
    await saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} doğum yılı: ${by}`);
    res.json({ success: true, birthYear: by, age: calcAge(by) });
});

// Nick değiştir — 24 saatte bir kez (kullanıcı kaybolmasın, search/DM tutarlı kalsın)
app.post('/api/account/nick', nickChangeLimiter, requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirler nick değiştiremez' });
    const { newNick } = req.body;
    const nick = String(newNick || '').trim();
    if (!nick || nick.length < 2 || nick.length > 20 || !/^[a-zA-Z0-9_]+$/.test(nick)) {
        return res.status(400).json({ success: false, error: 'Nick 2-20 karakter, sadece harf/rakam/_' });
    }
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.nick === nick) return res.status(400).json({ success: false, error: 'Yeni nick eskisiyle aynı' });
    // 24 saat sınırı
    if (u.nick_changed_at) {
        const elapsed = Date.now() - new Date(u.nick_changed_at).getTime();
        if (elapsed < 24 * 60 * 60 * 1000) {
            const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - elapsed) / (60 * 60 * 1000));
            return res.status(429).json({ success: false, error: `Nick'i 24 saatte bir değiştirebilirsin (${hoursLeft} saat sonra)` });
        }
    }
    // Tekillik
    if (users.find(x => x.id !== u.id && x.nick.toLowerCase() === nick.toLowerCase())) {
        return res.status(409).json({ success: false, error: 'Bu nick zaten alınmış' });
    }
    const oldNick = u.nick;
    u.nick = nick;
    u.nick_changed_at = new Date().toISOString();
    await saveUsers(users);
    // Friends.json güncelle — eski nick → yeni nick (arkadaş listelerinde)
    try {
        const friendsAll = loadFriends();
        let changed = false;
        Object.keys(friendsAll).forEach(ownerId => {
            const list = friendsAll[ownerId] || [];
            list.forEach((f, i) => {
                if (f.toLowerCase() === oldNick.toLowerCase()) {
                    list[i] = nick;
                    changed = true;
                }
            });
        });
        if (changed) await saveFriends(friendsAll);
    } catch (e) { console.error('[ACCOUNT] Nick değişikliği friends güncelleme hatası:', e.message); }
    // Yeni JWT (nick değişti) — frontend'e güncel token dön
    const newToken = jwt.sign({ id: u.id, nick: u.nick, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[ACCOUNT] ${oldNick} → ${nick} (nick değişti)`);
    res.json({ success: true, nick: u.nick, token: newToken });
});

// Hesap sil — hard delete (geri dönüşü yok)
app.post('/api/account/delete', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafir hesabı zaten silinir' });
    const { confirmText, currentPassword } = req.body;
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    // İki onay: confirmText "SIL" + (varsa) mevcut şifre
    if (confirmText !== 'SIL') {
        return res.status(400).json({ success: false, error: '"SIL" yazarak onaylaman gerek' });
    }
    if (u.password && currentPassword) {
        const ok = await bcrypt.compare(String(currentPassword), u.password);
        if (!ok) return res.status(401).json({ success: false, error: 'Şifre yanlış' });
    } else if (u.password && !currentPassword) {
        return res.status(400).json({ success: false, error: 'Şifreni doğrula' });
    }
    // Sil
    const idx = users.findIndex(x => x.id === u.id);
    users.splice(idx, 1);
    await saveUsers(users);
    // Arkadaş listelerinden temizle
    try {
        const friendsAll = loadFriends();
        delete friendsAll[u.id];
        Object.keys(friendsAll).forEach(ownerId => {
            friendsAll[ownerId] = (friendsAll[ownerId] || []).filter(f => f.toLowerCase() !== u.nick.toLowerCase());
        });
        await saveFriends(friendsAll);
    } catch (e) { console.error('[ACCOUNT] Hesap silme friends temizleme hatası:', e.message); }
    // Üye odalarını sil
    try {
        const userRooms = await loadUserRooms();
        const remaining = userRooms.filter(r => r.hostId !== u.id);
        if (remaining.length !== userRooms.length) await saveUserRooms(remaining);
    } catch (e) { console.error('[ACCOUNT] Hesap silme oda temizleme hatası:', e.message); }
    console.log(`[ACCOUNT] ${u.nick} hesabı SİLİNDİ (kullanıcı tarafından)`);
    res.json({ success: true, message: 'Hesabın silindi. Hoşça kal.' });
});

// Davet linki yenile — eski geçersiz olsun
app.post('/api/account/invite-refresh', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirin davet linki yok' });
    const users = await loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    // Yeni kod üret — ensureInviteCode mevcut kodu silmiyorsa override edelim
    u.invite_code = Math.random().toString(36).slice(2, 10);
    await saveUsers(users);
    res.json({ success: true, invite_code: u.invite_code });
});

// Hızlı status değiştirme (Profilim panelindeki dropdown için)
app.post('/api/status', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirlerin sabit statüsü yok' });
    }
    const { status } = req.body;
    if (!STATUS_KEYS.has(status)) {
        return res.status(400).json({ success: false, error: 'Geçersiz status' });
    }
    const users = await loadUsers();
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    user.status = status;
    await saveUsers(users);
    res.json({ success: true, status: user.status });
});

// ============ ROZET SİSTEMİ — otomatik hesaplanır ============
// Rozetler kullanıcı verisinden türetilir, DB'de saklanmıyor.
function computeBadges(user, allUsers, friends, invitedCount) {
    const badges = [];
    const accountAge = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    // Erken üye — sistem ilk 100 üyenin ID listesi
    const userIdx = allUsers.findIndex(u => u.id === user.id);
    if (userIdx >= 0 && userIdx < 100) {
        badges.push({ slug: 'early', emoji: '🎟️', name: 'Erken Üye', desc: 'İlk 100 üye arasındasın!' });
    }
    // Kıdemli — 1+ yıl
    if (accountAge >= 365) {
        badges.push({ slug: 'veteran', emoji: '🏆', name: 'Kıdemli', desc: '1 yıldır aramızda' });
    }
    // Davet eden
    if (invitedCount >= 5) {
        badges.push({ slug: 'inviter5', emoji: '📨', name: 'Cömert Davetçi', desc: `${invitedCount} kişiyi davet etmiş` });
    } else if (invitedCount >= 1) {
        badges.push({ slug: 'inviter1', emoji: '✉️', name: 'Davet Eden', desc: `${invitedCount} kişiyi davet etmiş` });
    }
    // Sosyal — 10+ arkadaş
    if (friends.length >= 10) {
        badges.push({ slug: 'social', emoji: '👥', name: 'Sosyal', desc: `${friends.length} arkadaşı var` });
    } else if (friends.length >= 3) {
        badges.push({ slug: 'friendly', emoji: '🤝', name: 'Dostane', desc: `${friends.length} arkadaşı var` });
    }
    // Profil dolu (bio + about + avatar + city)
    if ((user.bio && user.about && user.city) && user.avatar && user.avatar !== 'default') {
        badges.push({ slug: 'complete', emoji: '✨', name: 'Profil Tamamlandı', desc: 'Tüm alanları doldurmuş' });
    }
    // Rol bazlı
    if (user.role === 'admin') {
        badges.unshift({ slug: 'admin', emoji: '👑', name: 'Yönetici', desc: 'Site yöneticisi' });
    } else if (user.role === 'mod') {
        badges.unshift({ slug: 'mod', emoji: '🛡️', name: 'Moderatör', desc: 'Topluluk moderatörü' });
    }
    // Google ile katılan
    if (user.email) {
        badges.push({ slug: 'verified', emoji: '✓', name: 'Doğrulanmış', desc: 'Google ile doğrulanmış hesap' });
    }
    return badges;
}

// Aktif odayı LiveKit'ten bul
async function findActiveRoomForNick(nick) {
    const svc = getRoomServiceClient();
    if (!svc) return null;
    try {
        const rooms = await svc.listRooms();
        for (const r of rooms) {
            try {
                const parts = await svc.listParticipants(r.name);
                if (parts.some(p => p.identity.toLowerCase() === nick.toLowerCase())) {
                    return r.name;
                }
            } catch (e) { console.error('[PROFILE] listParticipants hatası:', r.name, e.message); }
        }
    } catch (e) { console.error('[PROFILE] findActiveRoom listRooms hatası:', e.message); }
    return null;
}

// ============ Herkese Açık Profil Bilgisi ============
// ============ Kullanıcı Arama ============
// Public — herkes arayabilir. Nick + bio + about + city alanlarında match.
// Sonuçlar minimal bilgi (nick, role, avatar, bio) — XSS/leak yok.
// Rate-limit: anti-scrape (saniyede 1 istek, dakikada 30)
const _searchHistory = new Map(); // ip → [ts...]
function searchRateOk(ip) {
    const now = Date.now();
    const hist = (_searchHistory.get(ip) || []).filter(t => now - t < 60_000);
    if (hist.length >= 30) return false;
    hist.push(now);
    _searchHistory.set(ip, hist);
    return true;
}
app.get('/api/users/search', async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) {
        return res.json({ success: true, users: [], message: 'En az 2 karakter' });
    }
    if (q.length > 30) {
        return res.status(400).json({ success: false, error: 'En fazla 30 karakter' });
    }
    if (!searchRateOk(req.ip)) {
        return res.status(429).json({ success: false, error: 'Çok hızlı arıyorsun — yavaşla.' });
    }
    // Türkçe-aware lowercase (İ→i, I→ı)
    const qNorm = q.replace(/İ/g, 'i').replace(/I/g, 'ı');
    const users = await loadUsers();
    const matches = users.filter(u => {
        const nick = (u.nick || '').toLowerCase().replace(/İ/g, 'i').replace(/I/g, 'ı');
        if (nick.includes(qNorm)) return true;
        const bio = (u.bio || '').toLowerCase().replace(/İ/g, 'i').replace(/I/g, 'ı');
        if (bio.includes(qNorm)) return true;
        const about = (u.about || '').toLowerCase().replace(/İ/g, 'i').replace(/I/g, 'ı');
        if (about.includes(qNorm)) return true;
        const city = (u.city || '').toLowerCase().replace(/İ/g, 'i').replace(/I/g, 'ı');
        if (city.includes(qNorm)) return true;
        return false;
    });
    // Skor: tam nick eşleşmesi > nick prefix > nick içerir > bio/about/city
    matches.forEach(u => {
        const nick = (u.nick || '').toLowerCase();
        let score = 0;
        if (nick === q) score = 100;
        else if (nick.startsWith(q)) score = 80;
        else if (nick.includes(q)) score = 60;
        else if ((u.bio || '').toLowerCase().includes(q)) score = 40;
        else score = 20;
        u._score = score;
    });
    matches.sort((a, b) => b._score - a._score);
    res.json({
        success: true,
        query: q,
        count: matches.length,
        users: matches.slice(0, 20).map(u => ({
            nick: u.nick,
            role: u.role,
            avatar: u.avatar || 'default',
            bio: u.bio || '',
            city: u.city || '',
            createdAt: u.createdAt,
        })),
    });
});

app.get('/api/profile/:nick', async (req, res) => {
    const users = await loadUsers();
    const user = users.find(u => u.nick.toLowerCase() === req.params.nick.toLowerCase());
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    // Lazy invite_code üretimi (eski kayıtlar için)
    if (ensureInviteCode(user, users)) saveUsers(users);

    // Davet ettiği kişi sayısı + davet eden
    const invitedCount = users.filter(u => u.invited_by === user.id).length;
    const inviter = user.invited_by ? users.find(u => u.id === user.invited_by) : null;

    // Arkadaşları (herkes görür — ama public)
    const friends = await getFriendsOf(user.id);

    // Açtığı odalar (üye odaları)
    const userRoomsAll = await loadUserRooms();
    const ownedRooms = userRoomsAll
        .filter(r => r.hostId === user.id)
        .map(r => ({
            name: r.name, icon: r.icon || '💬', category: r.category || 'free',
            max: r.max || 50, desc: (r.desc || '').slice(0, 80),
        }));

    // Rozetler (otomatik)
    const badges = computeBadges(user, users, friends, invitedCount);

    // Aktif olduğu oda (varsa)
    const activeRoom = await findActiveRoomForNick(user.nick);

    // invisible status'ü public görünmesin (online göster)
    const publicStatus = user.status === 'invisible' ? 'online' : (user.status || 'online');

    // Yaş hesapla (birthYear varsa)
    const age = user.birthYear ? (new Date().getFullYear() - user.birthYear) : null;

    // Codex D paketi: Profil gizlilik kontrolleri.
    // user.privacy: { hideBirthYear, hideActiveRoom, hideInviteCode, hideFriends, dmFrom }
    const privacy = user.privacy || {};
    // Eğer ziyaretçi engellenmişse profil bilgisi minimal (varlığı bil, başka bir şey gösterme)
    // Auth varsa requester'ı bul
    let requesterNick = null, requesterId = null;
    try {
        const auth = req.headers.authorization;
        if (auth?.startsWith('Bearer ')) {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            requesterNick = decoded.nick;
            const reqUser = users.find(u => u.nick.toLowerCase() === decoded.nick.toLowerCase());
            requesterId = reqUser?.id;
        }
    } catch (e) { console.error('[PROFILE] Requester JWT doğrulama hatası:', e.message); }
    // Hedef requester'ı engellemiş mi?
    const blockedByTarget = requesterNick && hasBlocked(user.id, requesterNick);
    if (blockedByTarget) {
        // Sadece minimal varlık bilgisi
        return res.json({
            success: true,
            nick: user.nick,
            avatar: user.avatar || 'default',
            blocked_by_target: true,
            createdAt: user.createdAt,
        });
    }

    res.json({
        success: true,
        nick: user.nick,
        role: user.role,
        avatar: user.avatar || 'default',
        bio: user.bio || '',
        about: user.about || '',
        createdAt: user.createdAt,
        status: publicStatus,
        personal_msg: user.personal_msg || '',
        // Codex D paketi: gizlilik gate'leri
        invite_code: privacy.hideInviteCode ? null : user.invite_code,
        invited_count: invitedCount,
        invited_by_nick: inviter ? inviter.nick : null,
        // birthYear/age — gizlenebilir
        birthYear: privacy.hideBirthYear ? null : (user.birthYear || null),
        age: privacy.hideBirthYear ? null : age,
        city: user.city || '',
        musicTaste: user.musicTaste || '',
        instagram: user.instagram || '',
        twitter: user.twitter || '',
        // Arkadaş listesi gizlenebilir
        friends: privacy.hideFriends ? [] : friends.slice(0, 12),
        friendCount: privacy.hideFriends ? 0 : friends.length,
        // Açtığı odalar (public)
        ownedRooms,
        ownedRoomsCount: ownedRooms.length,
        badges,
        // Aktif oda gizlenebilir — invisible status zaten activeRoom'u da etkilesin
        activeRoom: (privacy.hideActiveRoom || user.status === 'invisible') ? null : activeRoom,
        // DM kabul politikası — UI buton göstermek için
        dmFrom: privacy.dmFrom || 'all',
    });
});

// Codex D paketi: Profil gizlilik ayarları PUT — kullanıcı kendi privacy field'larını günceller
app.put('/api/account/privacy', requireAuth, async (req, res) => {
    const { hideBirthYear, hideActiveRoom, hideInviteCode, hideFriends, dmFrom } = req.body || {};
    const users = await loadUsers();
    const idx = users.findIndex(u => u.id === req.user.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    const cur = users[idx].privacy || {};
    users[idx].privacy = {
        hideBirthYear: hideBirthYear !== undefined ? !!hideBirthYear : !!cur.hideBirthYear,
        hideActiveRoom: hideActiveRoom !== undefined ? !!hideActiveRoom : !!cur.hideActiveRoom,
        hideInviteCode: hideInviteCode !== undefined ? !!hideInviteCode : !!cur.hideInviteCode,
        hideFriends: hideFriends !== undefined ? !!hideFriends : !!cur.hideFriends,
        dmFrom: ['all', 'friends', 'none'].includes(dmFrom) ? dmFrom : (cur.dmFrom || 'all'),
    };
    await saveUsers(users);
    res.json({ success: true, privacy: users[idx].privacy });
});

// /davet/:code → davet landing (HTML)
app.get('/davet/:code', (req, res) => res.sendFile(path.join(__dirname, 'davet.html')));

// /api/invite/lookup/:code — davet kodunu doğrula, kim davet ediyor
app.get('/api/invite/lookup/:code', async (req, res) => {
    const users = await loadUsers();
    const inviter = users.find(u => u.invite_code === req.params.code);
    if (!inviter) return res.status(404).json({ success: false, error: 'Geçersiz davet kodu' });
    res.json({ success: true, inviter: inviter.nick, code: inviter.invite_code });
});

// ============ ÖZEL MESAJ (DM) SİSTEMİ ============
const DMS_FILE = path.join(DATA_DIR, 'dms.json');

async function loadDMs() {
    await ensureDataDir();
    try { await fs.promises.access(DMS_FILE); } catch { await fs.promises.writeFile(DMS_FILE, '[]', 'utf8'); }
    try { return JSON.parse(await fs.promises.readFile(DMS_FILE, 'utf8')); } catch { return []; }
}
async function saveDMs(dms) {
    await ensureDataDir();
    await atomicWriteJson(DMS_FILE, dms);
}

// İki nick'i normalize edip thread key üret (alfabetik sıra, lowercase)
function threadKey(a, b) {
    return [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}

// POST /api/dm/send — auth gerektirir, misafirler yazamaz, rate limit
app.post('/api/dm/send', dmLimiter, requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler mesaj yazamaz — önce kayıt ol.' });
    }
    const { to_nick, body } = req.body;
    if (!to_nick || !body || !body.trim()) {
        return res.status(400).json({ success: false, error: 'to_nick ve body gerekli' });
    }
    const trimmed = body.trim().slice(0, 1000);
    const fromNick = req.user.nick;
    if (to_nick.toLowerCase() === fromNick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendine mesaj atamazsın' });
    }
    const users = await loadUsers();
    const toUser = users.find(u => u.nick.toLowerCase() === to_nick.toLowerCase());
    if (!toUser) {
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }
    // Codex D paketi: Engel kontrolü — iki yönden de.
    const fromUserObj = users.find(u => u.id === req.user.id);
    if (fromUserObj && hasBlocked(fromUserObj.id, toUser.nick)) {
        return res.status(403).json({ success: false, error: 'Bu kullanıcıyı engellediğin için mesaj atamazsın. Önce engel listeden çıkar.' });
    }
    if (hasBlocked(toUser.id, fromNick)) {
        // Hedef, gönderici tarafından engellenmiş — gönderici bunu açıkça bilmesin (privacy)
        return res.status(403).json({ success: false, error: 'Bu kullanıcıya şu anda mesaj atılamıyor.' });
    }
    // Codex D paketi: DM izni kontrolü — toUser ayarına göre.
    // privacy.dmFrom: 'all' (default) | 'friends' | 'none'
    const dmFrom = toUser?.privacy?.dmFrom || 'all';
    if (dmFrom === 'none') {
        return res.status(403).json({ success: false, error: 'Bu kullanıcı kimseden DM kabul etmiyor.' });
    }
    if (dmFrom === 'friends') {
        const isFriend = areFriends(fromUserObj.id, toUser.id, fromNick, toUser.nick);
        const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
        if (!isFriend && !isStaff) {
            return res.status(403).json({ success: false, error: 'Bu kullanıcı sadece arkadaşlarından DM kabul ediyor.' });
        }
    }
    const dms = await loadDMs();
    const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        from: fromNick,
        to: toUser.nick,
        body: trimmed,
        ts: Date.now(),
        read: false,
    };
    dms.push(msg);
    // Disk şişmesin diye max 5000 mesaj tutulur (en eskileri silinir)
    if (dms.length > 5000) dms.splice(0, dms.length - 5000);
    await saveDMs(dms);
    console.log(`[DM] ${fromNick} → ${toUser.nick}: ${trimmed.slice(0, 40)}`);
    // Bildirim merkezi tetik
    pushNotification(toUser.id, 'dm', {
        title: `💬 ${fromNick} sana mesaj gönderdi`,
        body: trimmed.slice(0, 100),
        link: '/?dm=' + encodeURIComponent(fromNick),
        from: fromNick,
    });
    res.json({ success: true, message: msg });
});

// GET /api/dm/inbox — thread'lere gruplanmış, her thread'in son mesajı + unread sayısı
app.get('/api/dm/inbox', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const dms = await loadDMs();
    const threads = new Map(); // peerNick(lc) -> { peer, lastMsg, unread }
    for (const m of dms) {
        const fromLc = m.from.toLowerCase();
        const toLc = m.to.toLowerCase();
        if (fromLc !== me && toLc !== me) continue;
        const peer = fromLc === me ? m.to : m.from;
        const peerLc = peer.toLowerCase();
        const existing = threads.get(peerLc);
        const isUnread = !m.read && toLc === me; // benim aldığım okunmamış
        if (!existing || m.ts > existing.lastMsg.ts) {
            threads.set(peerLc, {
                peer: existing?.peer || peer,
                lastMsg: m,
                unread: (existing?.unread || 0) + (isUnread ? 1 : 0),
            });
        } else if (isUnread) {
            existing.unread = (existing.unread || 0) + 1;
        }
    }
    // Liste — en yeni mesaj üstte
    const list = Array.from(threads.values()).sort((a, b) => b.lastMsg.ts - a.lastMsg.ts);
    const totalUnread = list.reduce((sum, t) => sum + t.unread, 0);
    res.json({ success: true, threads: list, totalUnread });
});

// GET /api/dm/thread/:nick — iki kullanıcı arası tüm mesajlar (kronolojik)
app.get('/api/dm/thread/:nick', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const peer = req.params.nick.toLowerCase();
    const dms = await loadDMs();
    const messages = dms.filter(m => {
        const fl = m.from.toLowerCase(), tl = m.to.toLowerCase();
        return (fl === me && tl === peer) || (fl === peer && tl === me);
    }).sort((a, b) => a.ts - b.ts);
    // Peer info ekle (status + personal msg) — MSN penceresinde göstermek için
    const users = await loadUsers();
    const peerUser = users.find(u => u.nick.toLowerCase() === peer);
    const peerInfo = peerUser ? {
        nick: peerUser.nick,
        avatar: peerUser.avatar || 'default',
        status: peerUser.status === 'invisible' ? 'online' : (peerUser.status || 'online'),
        personal_msg: peerUser.personal_msg || '',
    } : null;
    res.json({ success: true, messages, me: req.user.nick, peer: peerInfo });
});

// POST /api/dm/read — {nick} thread'indeki bana gelen mesajları okundu işaretle
app.post('/api/dm/read', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const peer = (req.body.nick || '').toLowerCase();
    if (!peer) return res.status(400).json({ success: false, error: 'nick gerekli' });
    const dms = await loadDMs();
    let changed = 0;
    for (const m of dms) {
        if (m.to.toLowerCase() === me && m.from.toLowerCase() === peer && !m.read) {
            m.read = true; changed++;
        }
    }
    if (changed) await saveDMs(dms);
    res.json({ success: true, marked: changed });
});

// ============ BAN SİSTEMİ ============
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
const LOCKS_FILE = path.join(DATA_DIR, 'locks.json');

async function loadBans() {
    await ensureDataDir();
    try { await fs.promises.access(BANS_FILE); } catch { await fs.promises.writeFile(BANS_FILE, '[]', 'utf8'); }
    try { return JSON.parse(await fs.promises.readFile(BANS_FILE, 'utf8')); } catch { return []; }
}
async function saveBans(bans) {
    await ensureDataDir();
    await atomicWriteJson(BANS_FILE, bans);
}
async function loadLocks() {
    await ensureDataDir();
    try { await fs.promises.access(LOCKS_FILE); } catch { await fs.promises.writeFile(LOCKS_FILE, '{}', 'utf8'); }
    try { return JSON.parse(await fs.promises.readFile(LOCKS_FILE, 'utf8')); } catch { return {}; }
}
async function saveLocks(locks) {
    await ensureDataDir();
    await atomicWriteJson(LOCKS_FILE, locks);
}
async function isUserBanned(nick) {
    const bans = await loadBans();
    const now = new Date();
    return bans.find(b => b.nick.toLowerCase() === nick.toLowerCase() && (!b.expiresAt || new Date(b.expiresAt) > now));
}

// ============ BİLDİRİM MERKEZİ ============
// data/notifications.json — { userId: [{ id, type, title, body, link, ts, read }, ...] }
// Tip listesi: dm, friend_add, ban_warn, ai_mod, invite_used, system, room_kick
// Her kullanıcı için max 50 bildirim tutulur (yenisi eskisini push eder).
function notifFile() { return path.join(DATA_DIR, 'notifications.json'); }
async function loadNotifications() {
    try {
        const f = notifFile();
        try { await fs.promises.access(f); } catch {
            await ensureDataDir();
            await fs.promises.writeFile(f, '{}', 'utf8');
            return {};
        }
        return JSON.parse(await fs.promises.readFile(f, 'utf8'));
    } catch { return {}; }
}
async function saveNotifications(data) {
    try {
        await ensureDataDir();
        await atomicWriteJson(notifFile(), data);
    } catch (e) { console.error('[NOTIF] save fail:', e.message); }
}
async function getNotifsForUser(userId) {
    const all = await loadNotifications();
    return all[userId] || [];
}
const NOTIF_MAX_PER_USER = 50;
const NOTIF_TYPES = new Set(['dm', 'friend_add', 'ban_warn', 'ai_mod', 'invite_used', 'system', 'room_kick']);
async function pushNotification(userId, type, payload) {
    if (!userId || !NOTIF_TYPES.has(type)) return;
    try {
        const all = await loadNotifications();
        const list = all[userId] || [];
        list.unshift({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            type,
            title: (payload.title || '').slice(0, 100),
            body: (payload.body || '').slice(0, 200),
            link: payload.link || null,        // örn /u/ahmet veya /oda?room=...
            from: payload.from || null,         // gönderen nick (varsa)
            ts: Date.now(),
            read: false,
        });
        if (list.length > NOTIF_MAX_PER_USER) list.length = NOTIF_MAX_PER_USER;
        all[userId] = list;
        await saveNotifications(all);
    } catch (e) {
        console.warn('[NOTIF] push fail:', e.message);
    }
}
// userId yerine nick ile çağırabilmek için yardımcı
async function pushNotificationByNick(nick, type, payload) {
    if (!nick) return;
    const u = (await loadUsers()).find(x => x.nick.toLowerCase() === String(nick).toLowerCase());
    if (u) await pushNotification(u.id, type, payload);
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

// Codex bulgu #4: JWT role tazeliği — token'daki role 7 gün geçerli; admin downgrade edilse bile
// eski token admin endpoint'lerini kullanmaya devam edebiliyordu. requireRole artık DB'den
// güncel role'ü okur ve gerekirse req.user.role'ü de tazeler (her admin/mod isteğinde 1 file read).
function requireRole(...roles) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
        }
        try {
            const users = await loadUsers();
            const u = users.find(x => x.nick.toLowerCase() === req.user.nick.toLowerCase());
            const freshRole = u?.role || 'user';
            // JWT'deki ile DB'deki uyuşmuyorsa request scope'unda güncelle
            if (freshRole !== req.user.role) {
                console.warn(`[ROLE] ${req.user.nick} role mismatch: JWT=${req.user.role}, DB=${freshRole}`);
                req.user.role = freshRole;
            }
            if (!roles.includes(freshRole)) {
                return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
            }
        } catch (e) {
            // DB hatası — fail-closed (yetki yok)
            console.error('[ROLE] requireRole DB read fail:', e.message);
            return res.status(500).json({ success: false, error: 'Yetki kontrolü başarısız' });
        }
        next();
    };
}

// ============ BAN KONTROLÜ (Token isterken) ============
const originalGetToken = app._router.stack.find(r => r.route && r.route.path === '/getToken');

// Ban kontrolü middleware — token isteyen kullanıcıyı kontrol et
app.use('/getToken', async (req, res, next) => {
    const identity = req.query.identity;
    if (identity) {
        const ban = await isUserBanned(identity);
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
app.get('/api/room/status', async (req, res) => {
    const { room } = req.query;
    if (!room) return res.status(400).json({ success: false, error: 'room parametresi gerekli' });
    const locks = await loadLocks();
    res.json({
        room,
        locked: !!locks[room],
        lockedBy: locks[room]?.lockedBy || null,
        lockedAt: locks[room]?.lockedAt || null
    });
});

// ============ BİLDİRİM API ============
// Bildirim ziline SADECE kişisel/sosyal türler düşer: DM, arkadaşlık, davet kullanıldı,
// odadan atıldın, ban uyarısı, AI moderasyon. 'system' (sahne süresi, sessiz konuşmacı
// vs.) bell'i boğmasın diye filtrelenir — kayıtta kalır, sadece UI'da gösterilmez.
const BELL_TYPES = new Set(['dm', 'friend_add', 'invite_used', 'room_kick', 'ban_warn', 'ai_mod']);
// Liste — varsayılan son 50, ?unread=1 ile sadece okunmamışlar, ?count=1 ile sadece sayı
app.get('/api/notifications', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.json({ success: true, notifications: [], unreadCount: 0, total: 0 });
    }
    const raw = getNotifsForUser(req.user.id);
    // Zilden düşecek türleri filtrele — 'system' gibi gürültülü olanlar gizli kalır
    const list = raw.filter(n => BELL_TYPES.has(n.type));
    const unreadCount = list.filter(n => !n.read).length;
    if (req.query.count === '1') {
        return res.json({ success: true, unreadCount, total: list.length });
    }
    const onlyUnread = req.query.unread === '1';
    const filtered = onlyUnread ? list.filter(n => !n.read) : list;
    res.json({
        success: true,
        notifications: filtered.slice(0, 30),
        unreadCount,
        total: list.length,
    });
});

// Tek bildirimi okundu yap (id ile) veya hepsi (?all=1)
app.post('/api/notifications/read', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.json({ success: true, marked: 0 });
    const { id } = req.body;
    const all = await loadNotifications();
    const list = all[req.user.id] || [];
    let marked = 0;
    if (req.body.all || req.query.all === '1') {
        list.forEach(n => { if (!n.read) { n.read = true; marked++; } });
    } else if (id) {
        const n = list.find(x => x.id === id);
        if (n && !n.read) { n.read = true; marked = 1; }
    } else {
        return res.status(400).json({ success: false, error: 'id veya all=1 gerekli' });
    }
    all[req.user.id] = list;
    await saveNotifications(all);
    res.json({ success: true, marked });
});

// Tek bildirimi sil
app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.json({ success: false });
    const all = await loadNotifications();
    const list = all[req.user.id] || [];
    const idx = list.findIndex(n => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ success: false, error: 'Bildirim bulunamadı' });
    list.splice(idx, 1);
    all[req.user.id] = list;
    await saveNotifications(all);
    res.json({ success: true });
});

// Tümünü sil
app.delete('/api/notifications', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.json({ success: false });
    const all = await loadNotifications();
    all[req.user.id] = [];
    await saveNotifications(all);
    res.json({ success: true });
});

// ============ ADMIN API ============

// Kullanıcı listesi
app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
    const users = (await loadUsers()).map(u => ({
        id: u.id,
        nick: u.nick,
        role: u.role,
        createdAt: u.createdAt
    }));
    res.json({ success: true, users });
});

// Rol değiştir
app.post('/api/admin/users/role', requireAuth, requireRole('admin'), async (req, res) => {
    const { userId, role } = req.body;
    if (!userId || !['user', 'mod', 'admin'].includes(role)) {
        return res.status(400).json({ success: false, error: 'userId ve geçerli role gerekli (user/mod/admin)' });
    }
    const users = await loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    user.role = role;
    await saveUsers(users);
    console.log(`[ADMIN] Rol değişikliği: ${user.nick} → ${role}`);
    pushModLog({ action: 'admin-role-change', by: req.user.nick, target: user.nick, details: { newRole: role } });
    res.json({ success: true, nick: user.nick, role });
});

// ============ MODERASYON GEÇMİŞİ ============
// Admin/mod tüm log kayıtlarını okur — filtre: ?room=&action=&since=ts&limit=200
app.get('/api/admin/mod-log', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room, action, since, limit } = req.query;
    let list = _modLog.slice();  // baş = en yeni
    if (room) list = list.filter(x => x.room === room);
    if (action) list = list.filter(x => x.action === action);
    if (since) {
        const t = parseInt(since);
        if (!isNaN(t)) list = list.filter(x => x.ts >= t);
    }
    const n = Math.max(1, Math.min(500, parseInt(limit) || 200));
    res.json({
        success: true,
        total: _modLog.length,
        filtered: list.length,
        items: list.slice(0, n),
    });
});

// Ban listesi
app.get('/api/admin/bans', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const bans = await loadBans();
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

    const bans = await loadBans();
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
    await saveBans(bans);

    // LiveKit'ten de at (tüm odalardan)
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const livekitRooms = await svc.listRooms();
            for (const room of livekitRooms) {
                try { await svc.removeParticipant(room.name, nick); } catch (e) { console.error('[ADMIN-BAN] removeParticipant hatası:', room.name, e.message); }
            }
        }
    } catch (e) { console.error('[ADMIN-BAN] LiveKit odalardan atma hatası:', e.message); }

    console.log(`[ADMIN] Ban: ${nick} by ${req.user.nick} — ${reason || 'sebep yok'}`);
    pushModLog({ action: 'admin-ban', by: req.user.nick, target: nick, reason, details: { duration_min: duration || 0, expiresAt } });
    // Bildirim
    pushNotificationByNick(nick, 'ban_warn', {
        title: `⛔ Admin tarafından yasaklandın`,
        body: `Sebep: ${reason || 'Kural ihlali'}${expiresAt ? ' — Bitiş: ' + new Date(expiresAt).toLocaleString('tr-TR') : ' — Kalıcı'}`,
        link: null,
        from: req.user.nick,
    });
    res.json({ success: true, message: `${nick} yasaklandı` });
});

// Ban kaldır
app.post('/api/admin/unban', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli' });

    const bans = await loadBans();
    const idx = bans.findIndex(b => b.nick.toLowerCase() === nick.toLowerCase());
    if (idx < 0) return res.status(404).json({ success: false, error: 'Ban kaydı bulunamadı' });

    bans.splice(idx, 1);
    await saveBans(bans);
    console.log(`[ADMIN] Unban: ${nick} by ${req.user.nick}`);
    pushModLog({ action: 'admin-unban', by: req.user.nick, target: nick });
    res.json({ success: true, message: `${nick} yasağı kaldırıldı` });
});

// Oda kilitle
app.post('/api/admin/room/lock', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'room gerekli' });
    const locks = await loadLocks();
    locks[room] = { lockedBy: req.user.nick, lockedAt: new Date().toISOString() };
    await saveLocks(locks);
    console.log(`[ADMIN] Oda kilitlendi: ${room} by ${req.user.nick}`);
    res.json({ success: true, message: `${room} kilitlendi` });
});

// Oda kilidini aç
app.post('/api/admin/room/unlock', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'room gerekli' });
    const locks = await loadLocks();
    delete locks[room];
    await saveLocks(locks);
    console.log(`[ADMIN] Oda kilidi açıldı: ${room} by ${req.user.nick}`);
    res.json({ success: true, message: `${room} kilidi açıldı` });
});

// İstatistikler
app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res) => {
    const users = await loadUsers();
    const bans = await loadBans();
    const locks = await loadLocks();
    let totalOnline = 0;
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const rooms = await svc.listRooms();
            rooms.forEach(r => totalOnline += r.numParticipants);
        }
    } catch (e) { console.error('[ADMIN-STATS] LiveKit online sayısı hatası:', e.message); }
    res.json({
        success: true,
        totalUsers: users.length,
        totalBans: bans.length,
        lockedRooms: Object.keys(locks).length,
        totalOnline
    });
});

// ============ DJ RADİO SİSTEMİ - playlist.json'dan yüklenir ============
let RADIO_PLAYLIST = [];
// Ölü/embed-blocklu YouTube ID'leri — Map<ytId, { reporters: Set<nick>, lastFailTs }>
//   * Bir ID gerçekten ölü sayılması için DEAD_YT_THRESHOLD FARKLI KULLANICI'dan fail bildirimi gerek
//     (önceki version aynı kullanıcının 2 bildirimini sayıyordu → tek kullanıcı sayfayı yenilediğinde
//      yüzlerce ID hızla "BLOCKED" oluyordu. Unique reporter set kullanarak fix.)
//   * DEAD_YT_TTL_MS sonra otomatik temizlenir (YT yasak kalkmış olabilir)
const DEAD_YT_THRESHOLD = 1;        // İlk fail bildirimi → blackliste (embed-disabled hızlı atılsın)
const DEAD_YT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 gün sonra unutulur
const DEAD_YT_IDS = new Map();
const DEAD_YT_FILE = path.join(__dirname, 'data', 'dead_yt_ids.json');
try {
    if (fs.existsSync(DEAD_YT_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DEAD_YT_FILE, 'utf8'));
        if (Array.isArray(raw)) {
            // Geriye uyum:
            //   - string[]: eski format, güvenilirlik yok → boş reporters seti (eşik altında)
            //   - {ytId, fails, lastFailTs}: eski Map format, reporters yok → fails=1 sayısal sayım, blocked değil
            //   - {ytId, reporters: [], lastFailTs}: yeni format
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
        await ensureDataDir();
        const arr = [...DEAD_YT_IDS.entries()].map(([ytId, v]) => ({
            ytId,
            reporters: [...v.reporters],
            lastFailTs: v.lastFailTs,
        }));
        await atomicWriteJson(DEAD_YT_FILE, arr);
    } catch (e) { console.error('[DJ] dead-yt save hatası:', e.message); }
}
// TTL temizlik — saatte bir
setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [ytId, v] of DEAD_YT_IDS.entries()) {
        if (now - (v.lastFailTs || 0) > DEAD_YT_TTL_MS) { DEAD_YT_IDS.delete(ytId); removed++; }
    }
    if (removed > 0) {
        console.log(`[DJ] TTL temizlik: ${removed} eski ölü ID silindi (${DEAD_YT_IDS.size} kaldı)`);
        saveDeadYtIds();
    }
}, 60 * 60 * 1000);
// Bir ID gerçekten ölü mü?
function isYtDead(ytId) {
    const v = DEAD_YT_IDS.get(ytId);
    return !!v && v.reporters.size >= DEAD_YT_THRESHOLD;
}

try {
    const playlistPath = require('path').join(__dirname, 'playlist.json');
    RADIO_PLAYLIST = JSON.parse(fs.readFileSync(playlistPath, 'utf8'));
    // Karıştır (Fisher-Yates shuffle)
    for (let i = RADIO_PLAYLIST.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [RADIO_PLAYLIST[i], RADIO_PLAYLIST[j]] = [RADIO_PLAYLIST[j], RADIO_PLAYLIST[i]];
    }
    console.log(`[DJ] ${RADIO_PLAYLIST.length} şarkı yüklendi (playlist.json)`);
} catch (e) {
    console.error('[DJ] playlist.json yüklenemedi:', e.message);
    RADIO_PLAYLIST = [{ artist: 'DJ_RetroBot', title: 'Test Yayını', year: 2024, duration: 180, ytId: 'dQw4w9WgXcQ' }];
}

// Yardımcı: canlı (ölü olmayan) playlist
function liveTracks() {
    return RADIO_PLAYLIST.filter(t => !isYtDead(t.ytId));
}

// Radyo başlangıç zamanı
const RADIO_START_TIME = Date.now();

function getRadioNowPlaying() {
    const tracks = liveTracks();
    if (tracks.length === 0) {
        return { index: 0, song: RADIO_PLAYLIST[0] || { artist: 'DJ', title: 'Boş', duration: 0, ytId: '' }, elapsed: 0, remaining: 0, progress: 0, next: null };
    }
    const total = tracks.reduce((sum, s) => sum + (s.duration || 180), 0);
    const elapsed = Math.floor((Date.now() - RADIO_START_TIME) / 1000);
    const posInPlaylist = elapsed % total;

    let cumulative = 0;
    for (let i = 0; i < tracks.length; i++) {
        const song = tracks[i];
        const dur = song.duration || 180;
        if (cumulative + dur > posInPlaylist) {
            const songElapsed = posInPlaylist - cumulative;
            // Sıradakini bulurken current ile aynı olanı atla — playlist'te ardışık duplike varsa
            // kullanıcıya "Sıradaki = çalan" tuhaflığı görünmesin.
            let nextIdx = (i + 1) % tracks.length;
            let safety = tracks.length;
            while (safety-- > 0 && tracks[nextIdx] &&
                   tracks[nextIdx].artist === song.artist &&
                   tracks[nextIdx].title === song.title) {
                nextIdx = (nextIdx + 1) % tracks.length;
                if (nextIdx === i) break; // tek track playlist — kendine döndü
            }
            const nextSong = (nextIdx !== i) ? tracks[nextIdx] : null;
            return {
                index: i,
                song: song,
                elapsed: songElapsed,
                remaining: dur - songElapsed,
                progress: Math.round((songElapsed / dur) * 100),
                next: nextSong
            };
        }
        cumulative += dur;
    }
    return { index: 0, song: tracks[0], elapsed: 0, remaining: tracks[0].duration || 180, progress: 0, next: tracks[1] || null };
}

// Frontend YT 150/101 hatasında çağrılır → ID'yi blacklist'e ekle
// Auth korumalı — sadece login'li kullanıcılar dead YT ID bildirebilir (kötüye kullanım koruması)
// Hem misafir hem kayıtlı kabul (frontend'den gelen player error normal akış)
// Dead bildirim — auth OPSİYONEL. Misafir/anonim de bildirebilir (radyo herkese açık).
// IP+ytId rate-limit ile spam koruması yeterli.
const DEAD_REPORT_IPS = new Map();   // ytId → Set<ip>
app.post('/api/radio/dead', express.json(), async (req, res) => {
    const { ytId } = req.body;
    if (!ytId || typeof ytId !== 'string' || ytId.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(ytId)) {
        return res.status(400).json({ success: false, error: 'Geçersiz ytId' });
    }
    // Reporter kimliği: auth varsa nick, yoksa IP
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
    console.log(`[DJ] Fail bildirimi: ${ytId} (${count}/${DEAD_YT_THRESHOLD} reporter, ${trulyDead ? 'BLOCKED' : 'şüpheli'}) by ${reporter}${isNew ? '' : ' [yinelenen]'}`);
    res.json({ success: true, reporters: count, blocked: trulyDead, threshold: DEAD_YT_THRESHOLD });
});

// Admin: Dead YT listesini temizle (yanlış pozitif birikmiş olabilir)
app.post('/api/admin/radio/clear-dead-yt', requireAuth, requireRole('admin'), async (req, res) => {
    const before = DEAD_YT_IDS.size;
    DEAD_YT_IDS.clear();
    saveDeadYtIds();
    console.log(`[DJ] Admin dead-list reset: ${before} → 0 (by ${req.user.nick})`);
    res.json({ success: true, cleared: before });
});

// ============ Şarkı Talep Sistemi ============
// İstekler in-memory queue'da tutulur. Bir sonraki playlist track'ten önce
// queue'dan FIFO çekilir ve "şu an çalan" olur. Daha sade: aynı kullanıcı
// 5 dakikada 1 talep yapabilir (basit rate limit).
const SONG_REQUESTS = []; // [{id, by, artist, title, ts}]
const SONG_REQ_COOLDOWN = 5 * 60 * 1000; // 5 dakika
const _lastReqByNick = new Map();

app.get('/api/radio/queue', async (req, res) => {
    res.json({ success: true, queue: SONG_REQUESTS.slice(0, 10) });
});

app.post('/api/radio/request', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler şarkı isteyemez — önce kayıt ol.' });
    }
    const { artist, title } = req.body;
    if (!artist || !title || !artist.trim() || !title.trim()) {
        return res.status(400).json({ success: false, error: 'artist ve title gerekli' });
    }
    // Rate limit per nick
    const last = _lastReqByNick.get(req.user.nick) || 0;
    if (Date.now() - last < SONG_REQ_COOLDOWN) {
        const remainSec = Math.ceil((SONG_REQ_COOLDOWN - (Date.now() - last)) / 1000);
        return res.status(429).json({ success: false, error: `Bir sonraki istek için ${Math.ceil(remainSec / 60)} dakika bekle.` });
    }
    const cleanArtist = artist.trim().slice(0, 60);
    const cleanTitle = title.trim().slice(0, 100);
    const reqItem = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
        by: req.user.nick,
        artist: cleanArtist,
        title: cleanTitle,
        ts: Date.now(),
    };
    SONG_REQUESTS.push(reqItem);
    if (SONG_REQUESTS.length > 50) SONG_REQUESTS.splice(0, SONG_REQUESTS.length - 50);
    _lastReqByNick.set(req.user.nick, Date.now());
    console.log(`[RADYO] Talep: ${req.user.nick} → ${cleanArtist} - ${cleanTitle}`);
    try { pushActivity(`${req.user.nick} şarkı istedi: "${cleanArtist} — ${cleanTitle}"`, '🎵'); } catch (e) { console.warn('[RADYO] pushActivity hatası:', e.message); }
    res.json({ success: true, request: reqItem, queueLength: SONG_REQUESTS.length });
});

app.get('/api/radio/now-playing', async (req, res) => {
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

app.get('/api/radio/playlist', async (req, res) => {
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
