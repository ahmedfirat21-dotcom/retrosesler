const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const AVATARS_DIR = path.join(__dirname, '..', 'assets', 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 }, // max 3MB
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) cb(null, true);
        else cb(new Error('Sadece JPEG, PNG, WebP ve GIF desteklenir.'));
    }
});

const db = require('../services/db');
const {
    JWT_SECRET,
    googleClient,
    sendMail,
    calcAge,
    isAdult,
    authLimiter,
    nickChangeLimiter,
    requireAuth,
    requireRole,
    pushActivity,
    pushNotification,
    getRoomServiceClient,
    pushNotificationByNick,
    pushModLog
} = require('../services/shared');

const AVATAR_LIST = [
    'default', 'retro_tv', 'cassette', 'gameboy', 'floppy', 'headphones',
    'sunglasses', 'rocket', 'star', 'crown', 'diamond', 'fire',
    'robot', 'alien', 'ghost', 'ninja', 'wizard', 'pirate',
    'cat', 'dog', 'unicorn', 'phoenix'
];
const STATUS_KEYS = new Set(['online', 'busy', 'brb', 'away', 'invisible']);

function generateInviteCode() {
    return crypto.randomBytes(5).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex');
}

function ensureInviteCode(user, users) {
    if (!user.invite_code) {
        let code, tries = 0;
        do {
            code = generateInviteCode();
            tries++;
        } while (users.find(u => u.invite_code === code) && tries < 20);
        user.invite_code = code;
        return true;
    }
    return false;
}

async function verifyPassword(password, stored) {
    if (!stored) return false;
    if (stored.startsWith('$2')) return bcrypt.compare(password, stored);
    const sha = crypto.createHash('sha256').update(password).digest('hex');
    return stored === sha;
}

// Config
router.get('/config', async (req, res) => {
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// Register
router.post('/register', authLimiter, async (req, res) => {
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

    let cleanedEmail = '';
    if (email && String(email).trim()) {
        cleanedEmail = String(email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail)) {
            return res.status(400).json({ success: false, error: 'Geçerli bir email gir veya boş bırak' });
        }
    }

    const users = await db.loadUsers();
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

    let inviter = null;
    if (invite_code) {
        inviter = users.find(u => u.invite_code === invite_code);
    }

    const adminEmails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
    const initialRole = (cleanedEmail && adminEmails.includes(cleanedEmail)) ? 'admin' : 'user';

    const user = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        nick: nick,
        password: await bcrypt.hash(password, 10),
        role: initialRole,
        birthYear: by,
        createdAt: new Date().toISOString(),
        invited_by: inviter ? inviter.id : null,
    };
    if (cleanedEmail) user.email = cleanedEmail;
    ensureInviteCode(user, users);
    users.push(user);
    await db.saveUsers(users);

    user.sessionId = crypto.randomBytes(16).toString('hex');
    await db.saveUsers(users);
    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role, sid: user.sessionId }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Yeni kayıt: ${nick}${inviter ? ' (davet eden: ' + inviter.nick + ')' : ''}`);
    try {
        pushActivity(`${nick} aramıza katıldı${inviter ? ' (' + inviter.nick + ' davet etti)' : ''}`, '👋');
        if (inviter) {
            await pushNotification(inviter.id, 'invite_used', {
                title: `🎟️ Davet ettiğin ${nick} aramıza katıldı!`,
                body: `Davet linkin işe yaradı — yeni arkadaşlık fırsatı!`,
                link: '/u/' + encodeURIComponent(nick),
                from: nick,
            });
        }
    } catch (e) { console.error('[AUTH] Kayıt sonrası aktivite/bildirim hatası:', e.message); }
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// Login
router.post('/login', authLimiter, async (req, res) => {
    const { nick, password } = req.body;
    if (!nick || !password) {
        return res.status(400).json({ success: false, error: 'Nick ve şifre gerekli' });
    }

    const users = await db.loadUsers();
    const lcInput = nick.toLowerCase();
    const user = users.find(u =>
        u.nick.toLowerCase() === lcInput ||
        (u.email || '').toLowerCase() === lcInput
    );
    if (!user) {
        return res.status(401).json({ success: false, error: 'Nick/email veya şifre yanlış' });
    }
    if (user.google_sub && !user.password) {
        return res.status(401).json({
            success: false,
            error: 'Bu hesap Google ile bağlı — aşağıdan "Google ile Giriş Yap" butonuna bas.',
            code: 'google_only',
            email: user.email || null,
        });
    }
    if (!await verifyPassword(password, user.password)) {
        return res.status(401).json({ success: false, error: 'Nick/email veya şifre yanlış' });
    }

    if (user.password && !user.password.startsWith('$2')) {
        user.password = await bcrypt.hash(password, 10);
        await db.saveUsers(users);
        console.log(`[AUTH] Şifre hash upgrade: ${user.nick}`);
    }

    user.sessionId = crypto.randomBytes(16).toString('hex');
    await db.saveUsers(users);
    const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role, sid: user.sessionId }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[AUTH] Giriş: ${user.nick}`);
    res.json({ success: true, token, nick: user.nick, role: user.role });
});

// Google Auth
router.post('/auth/google', authLimiter, async (req, res) => {
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
            audience: process.env.GOOGLE_CLIENT_ID,
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

        const users = await db.loadUsers();
        let user = users.find(u => u.google_sub === googleSub);

        if (!user && email) {
            user = users.find(u => (u.email || '').toLowerCase() === email);
            if (user) {
                user.google_sub = googleSub;
                await db.saveUsers(users);
            }
        }

        if (!user) {
            const baseNick = (givenName || email.split('@')[0] || 'retro').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'retro';
            let nick = baseNick;
            let i = 1;
            while (users.find(u => u.nick.toLowerCase() === nick.toLowerCase())) {
                nick = `${baseNick}${i++}`;
                if (i > 999) break;
            }
            let inviter = null;
            if (invite_code) {
                inviter = users.find(u => u.invite_code === invite_code);
            }
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
            await db.saveUsers(users);
            console.log(`[AUTH] Google kayit: ${nick} (${email}) — rol: ${initialRole}${inviter ? ' (davet eden: ' + inviter.nick + ')' : ''}`);
            try {
                pushActivity(`${nick} aramıza katıldı${inviter ? ' (' + inviter.nick + ' davet etti)' : ''}`, '👋');
                if (inviter) {
                    await pushNotification(inviter.id, 'invite_used', {
                        title: `🎟️ Davet ettiğin ${nick} aramıza katıldı!`,
                        body: `Davet linkin işe yaradı — yeni arkadaşlık fırsatı!`,
                        link: '/u/' + encodeURIComponent(nick),
                        from: nick,
                    });
                }
            } catch (e) { console.error('[AUTH] Google kayıt aktivite/bildirim hatası:', e.message); }
        } else {
            const adminEmails = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
            if (adminEmails.includes((user.email || '').toLowerCase()) && user.role !== 'admin') {
                user.role = 'admin';
                await db.saveUsers(users);
                console.log(`[AUTH] ${user.nick} ADMIN yetkisine yükseltildi (${email})`);
            }
            console.log(`[AUTH] Google giris: ${user.nick} (${email}) — rol: ${user.role}`);
        }

        user.sessionId = crypto.randomBytes(16).toString('hex');
        await db.saveUsers(users);
        const token = jwt.sign({ id: user.id, nick: user.nick, role: user.role, sid: user.sessionId }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, nick: user.nick, role: user.role });
    } catch (err) {
        console.error('[AUTH] Google verify hatasi:', err.message);
        res.status(401).json({ success: false, error: 'Google girisi dogrulanamadi: ' + err.message });
    }
});

// Guest Auth
router.post('/auth/guest', authLimiter, async (req, res) => {
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const nick = genGuestNick();
    const token = jwt.sign({ id, nick, role: 'guest' }, JWT_SECRET, { expiresIn: '24h' });
    console.log(`[AUTH] Misafir giriş: ${nick}`);
    try { pushActivity(`${nick} misafir olarak göz attı`, '👀'); } catch (e) { console.warn('[AUTH] pushActivity hatası:', e.message); }
    res.json({ success: true, token, nick, role: 'guest' });
});

const GUEST_ADJ = ['Sessiz', 'Nostaljik', 'Eski', 'Yıldız', 'Mavi', 'Altın', 'Gece', 'Mor', 'Ay', 'Yağmur', 'Rüzgar', 'Bulut'];
const GUEST_NOUN = ['Kaset', 'Walkman', 'Plak', 'Radyo', 'Şahin', 'Tofaş', 'Disket', 'TV', 'Modem', 'Kafe', 'Sokak', 'Defter'];
function genGuestNick() {
    const adj = GUEST_ADJ[Math.floor(Math.random() * GUEST_ADJ.length)];
    const noun = GUEST_NOUN[Math.floor(Math.random() * GUEST_NOUN.length)];
    const num = Math.floor(Math.random() * 900) + 100;
    return `Retro${adj}${noun}${num}`;
}

// Me info
router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        if (decoded.role === 'guest') {
            return res.json({
                success: true, nick: decoded.nick, role: 'guest', id: decoded.id,
                avatar: 'default', bio: '', status: 'online', personal_msg: '',
                createdAt: new Date(decoded.iat * 1000).toISOString(),
            });
        }
        const users = await db.loadUsers();
        const user = users.find(u => u.id === decoded.id);
        if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        if (user.sessionId && user.sessionId !== decoded.sid) {
            return res.status(401).json({
                success: false,
                error: 'Başka bir cihazdan giriş yapıldı. Lütfen tekrar giriş yap.',
                code: 'session_replaced'
            });
        }
        res.json({
            success: true, nick: user.nick, role: user.role, id: user.id,
            avatar: user.avatar || 'default', bio: user.bio || '',
            avatarPhoto: user.avatarPhoto ? `/assets/avatars/${user.avatarPhoto}` : null,
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

// Update Profile
router.post('/profile', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler profil düzenleyemez' });
    }
    const { 
        avatar, bio, status, personal_msg, about, city, musicTaste, instagram, twitter,
        tiktok, youtube, discord, removePhoto,
        profileTheme, profileMusic, profileMusicName, moodEmoji, moodText
    } = req.body;
    const users = await db.loadUsers();
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    if (avatar && (AVATAR_LIST.includes(avatar) || avatar === 'custom')) user.avatar = avatar;
    if (removePhoto && user.avatarPhoto) {
        const oldPath = path.join(__dirname, '..', 'assets', 'avatars', user.avatarPhoto);
        try { fs.unlinkSync(oldPath); } catch {}
        delete user.avatarPhoto;
        user.avatar = avatar || 'default';
    }
    if (bio !== undefined) user.bio = String(bio).substring(0, 60);
    if (status && STATUS_KEYS.has(status)) user.status = status;
    if (personal_msg !== undefined) user.personal_msg = String(personal_msg).substring(0, 100);
    if (about !== undefined) user.about = String(about).substring(0, 500);
    if (city !== undefined) user.city = String(city).substring(0, 40);
    if (musicTaste !== undefined) user.musicTaste = String(musicTaste).substring(0, 150);
    if (instagram !== undefined) {
        user.instagram = String(instagram).replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '').substring(0, 30);
    }
    if (twitter !== undefined) {
        user.twitter = String(twitter).replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 15);
    }
    if (tiktok !== undefined) {
        user.tiktok = String(tiktok).replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '').substring(0, 30);
    }
    if (youtube !== undefined) {
        user.youtube = String(youtube).replace(/[^a-zA-Z0-9@_-]/g, '').substring(0, 50);
    }
    if (discord !== undefined) {
        user.discord = String(discord).substring(0, 40);
    }

    const THEMES = new Set(['default', 'win98', 'sakir', 'gece', 'pera', 'matrix', 'bliss', 'xp_metallic', 'space', 'romance']);
    if (profileTheme !== undefined) {
        user.profileTheme = THEMES.has(profileTheme) ? profileTheme : 'default';
    }
    if (profileMusic !== undefined) {
        user.profileMusic = String(profileMusic).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 15);
    }
    if (profileMusicName !== undefined) {
        user.profileMusicName = String(profileMusicName).substring(0, 100);
    }
    if (moodEmoji !== undefined) {
        user.moodEmoji = String(moodEmoji).substring(0, 10);
    }
    if (moodText !== undefined) {
        user.moodText = String(moodText).substring(0, 40);
    }

    await db.saveUsers(users);
    console.log(`[PROFILE] ${user.nick} profil güncelledi`);
    res.json({
        success: true,
        avatar: user.avatar, bio: user.bio, status: user.status, personal_msg: user.personal_msg,
        about: user.about, birthYear: user.birthYear, city: user.city, musicTaste: user.musicTaste,
        instagram: user.instagram, twitter: user.twitter,
        tiktok: user.tiktok, youtube: user.youtube, discord: user.discord,
        profileTheme: user.profileTheme, profileMusic: user.profileMusic,
        profileMusicName: user.profileMusicName, moodEmoji: user.moodEmoji, moodText: user.moodText
    });
});

// Profil fotoğrafı yükleme
router.post('/profile/avatar-upload', requireAuth, (req, res) => {
    avatarUpload.single('avatar')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Dosya çok büyük (max 3MB)' : (err.message || 'Yükleme hatası');
            return res.status(400).json({ success: false, error: msg });
        }
        if (!req.file) return res.status(400).json({ success: false, error: 'Dosya seçilmedi' });

        try {
            const users = await db.loadUsers();
            const user = users.find(u => u.id === req.user.id);
            if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

            const filename = `${user.id}_${Date.now()}.webp`;
            const filepath = path.join(AVATARS_DIR, filename);

            // Sharp ile 200x200 resize + webp formatına çevir
            await sharp(req.file.buffer)
                .resize(200, 200, { fit: 'cover', position: 'centre' })
                .webp({ quality: 85 })
                .toFile(filepath);

            // Eski fotoğrafı sil (varsa)
            if (user.avatarPhoto) {
                const oldPath = path.join(AVATARS_DIR, user.avatarPhoto);
                try { fs.unlinkSync(oldPath); } catch {}
            }

            user.avatarPhoto = filename;
            user.avatar = 'custom'; // avatar türü artık custom
            await db.saveUsers(users);

            console.log(`[PROFILE] ${user.nick} profil fotoğrafı yükledi: ${filename}`);
            res.json({
                success: true,
                avatarPhoto: filename,
                avatarUrl: `/assets/avatars/${filename}`,
            });
        } catch (e) {
            console.error('[PROFILE] Avatar upload hatası:', e.message);
            res.status(500).json({ success: false, error: 'Fotoğraf işlenirken hata: ' + e.message });
        }
    });
});

// Update Preferences
router.post('/account/preferences', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafir tercih ayarlayamaz.' });
    const { nudge_pref, sound_enabled } = req.body;
    const users = await db.loadUsers();
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
    await db.saveUsers(users);
    res.json({
        success: true,
        nudge_pref: u.nudge_pref || 'friends',
        sound_enabled: u.sound_enabled !== false,
    });
});

// Account Info
router.get('/account/me', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin hesabı yok' });
    const users = await db.loadUsers();
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
        privacy: u.privacy || { hideBirthYear: false, hideActiveRoom: false, hideInviteCode: false, hideFriends: false, dmFrom: 'all' },
    });
});

// Password Reset Request
const _resetRequestHistory = new Map();
function resetRateOk(emailLc) {
    const now = Date.now();
    const hist = (_resetRequestHistory.get(emailLc) || []).filter(t => now - t < 60 * 60 * 1000);
    if (hist.length >= 3) return false;
    hist.push(now);
    _resetRequestHistory.set(emailLc, hist);
    return true;
}

router.post('/account/password-reset/request', authLimiter, async (req, res) => {
    const { email } = req.body;
    const cleaned = String(email || '').trim().toLowerCase();
    if (!cleaned || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
        return res.status(400).json({ success: false, error: 'Geçerli email gerekli' });
    }
    if (!resetRateOk(cleaned)) {
        return res.status(429).json({ success: false, error: 'Bu email için saatte 3 istek limitine ulaşıldı.' });
    }
    const SUCCESS_RESPONSE = {
        success: true,
        message: 'Eğer bu email kayıtlıysa, sıfırlama linki gönderildi. 5 dakika içinde gelmezse spam klasörüne bak.',
    };
    const users = await db.loadUsers();
    const user = users.find(u => (u.email || '').toLowerCase() === cleaned);
    if (!user) {
        console.log(`[RESET] Kayıtsız email için istek: ${cleaned}`);
        return res.json(SUCCESS_RESPONSE);
    }
    if (user.google_sub && !user.password) {
        console.log(`[RESET] Google-only kullanıcı: ${user.nick}`);
        const baseUrl = process.env.PUBLIC_URL || 'https://retrosesler.com';
        try {
            await sendMail({
                to: cleaned,
                subject: 'RetroSesler — Hesabın Google ile bağlı 🔵',
                text: `Merhaba ${user.nick},\n\nHesabın Google ile bağlı olduğu için ayrı bir şifren yok. Giriş: ${baseUrl}/giris`,
                html: `
                    <div style="font-family:Tahoma,sans-serif;max-width:520px;margin:0 auto;border:2px solid #A09880;background:#FAFAF5">
                        <div style="background:linear-gradient(180deg,#4A90D9,#2E6BBF);color:#fff;padding:12px 16px;font-weight:bold">
                            🔵 RetroSesler — Google ile Giriş
                        </div>
                        <div style="padding:18px;color:#333;font-size:13px">
                            <p>Merhaba <b>${user.nick}</b>,</p>
                            <p>Hesabın Google ile bağlı olduğu için şifren yok. Google ile giriş butonuna basarak doğrudan giriş yapabilirsin.</p>
                            <p style="text-align:center"><a href="${baseUrl}/giris" style="display:inline-block;background:#2E6BBF;color:#fff;padding:8px 20px;text-decoration:none;border-radius:4px">🔵 Giriş Yap</a></p>
                        </div>
                    </div>
                `
            });
        } catch (e) { console.warn('[RESET] mail send fail:', e.message); }
        return res.json(SUCCESS_RESPONSE);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const resets = await db.loadResets();
    resets.forEach(r => { if (r.userId === user.id && !r.used) r.used = true; });
    resets.push({
        token, userId: user.id, email: cleaned, expiresAt, used: false, createdAt: Date.now(),
    });
    const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const cleanedResets = resets.filter(r => r.createdAt > dayCutoff);
    await db.saveResets(cleanedResets);

    const baseUrl = process.env.PUBLIC_URL || `https://retrosesler.com`;
    const resetUrl = `${baseUrl}/sifre-sifirla?token=${token}`;
    try {
        await sendMail({
            to: cleaned,
            subject: 'RetroSesler — Şifre Sıfırlama',
            text: `Merhaba ${user.nick},\n\nŞifre sıfırlama linki: ${resetUrl}`,
            html: `
                <div style="font-family:Tahoma,sans-serif;max-width:520px;margin:0 auto;border:2px solid #A09880;background:#FAFAF5">
                    <div style="background:#2E6BBF;color:#fff;padding:12px 16px;font-weight:bold">
                        🔑 RetroSesler — Şifre Sıfırlama
                    </div>
                    <div style="padding:18px">
                        <p>Merhaba <b>${user.nick}</b>,</p>
                        <p>Aşağıdaki linki kullanarak yeni şifre belirleyebilirsin:</p>
                        <p style="text-align:center"><a href="${resetUrl}" style="display:inline-block;background:#2E6BBF;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:bold">🔓 Yeni Şifre Belirle</a></p>
                    </div>
                </div>
            `,
        });
        console.log(`[RESET] Mail gönderildi: ${user.nick} (${cleaned})`);
    } catch (err) {
        console.error('[RESET] Mail gönderim hatası:', err.message);
    }
    res.json(SUCCESS_RESPONSE);
});

// Verify reset token
router.get('/account/password-reset/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'Token gerekli' });
    const resets = await db.loadResets();
    const r = resets.find(x => x.token === token);
    if (!r || r.used || r.expiresAt < Date.now()) {
        return res.status(400).json({ success: false, error: 'Token geçersiz veya süresi dolmuş.' });
    }
    res.json({ success: true });
});

// Confirm password reset
router.post('/account/password-reset/confirm', authLimiter, async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ success: false, error: 'token ve newPassword gerekli' });
    if (typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 64) {
        return res.status(400).json({ success: false, error: 'Şifre 4-64 karakter olmalı' });
    }
    const resets = await db.loadResets();
    const r = resets.find(x => x.token === token);
    if (!r || r.used || r.expiresAt < Date.now()) {
        return res.status(400).json({ success: false, error: 'Token geçersiz veya süresi dolmuş.' });
    }
    const users = await db.loadUsers();
    const user = users.find(u => u.id === r.userId);
    if (!user) {
        r.used = true;
        await db.saveResets(resets);
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı.' });
    }
    user.password = await bcrypt.hash(String(newPassword), 10);
    await db.saveUsers(users);
    r.used = true;
    r.usedAt = Date.now();
    await db.saveResets(resets);
    console.log(`[RESET] ${user.nick} şifresini yeniledi (email reset)`);
    await pushNotification(user.id, 'system', {
        title: '🔐 Şifren değişti',
        body: 'Email ile şifren yenilendi. Bu sen değilsen hemen tekrar şifreni değiştir.',
        link: '/u/' + encodeURIComponent(user.nick) + '?edit=1',
    });
    res.json({ success: true, message: 'Şifren yenilendi. Şimdi yeni şifrenle giriş yapabilirsin.' });
});

// Update Password
router.post('/account/password', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirler şifre değiştiremez' });
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 64) {
        return res.status(400).json({ success: false, error: 'Yeni şifre 4-64 karakter olmalı' });
    }
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.password) {
        if (!currentPassword) return res.status(400).json({ success: false, error: 'Mevcut şifrenizi girin' });
        const ok = await bcrypt.compare(String(currentPassword), u.password);
        if (!ok) return res.status(401).json({ success: false, error: 'Mevcut şifre yanlış' });
    }
    u.password = await bcrypt.hash(String(newPassword), 10);
    await db.saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} şifresini değiştirdi`);
    res.json({ success: true, message: 'Şifre güncellendi' });
});

// Update Email
router.post('/api/account/email', requireAuth, async (req, res) => {
    // backwards compatible fallback
    return updateEmail(req, res);
});
router.post('/account/email', requireAuth, async (req, res) => {
    return updateEmail(req, res);
});
async function updateEmail(req, res) {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin emaili yok' });
    const { email } = req.body;
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.google_sub) {
        return res.status(400).json({ success: false, error: 'Email Google hesabınızdan otomatik gelir, manuel değiştirilemez.' });
    }
    const cleaned = String(email || '').trim().toLowerCase();
    if (cleaned && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
        return res.status(400).json({ success: false, error: 'Geçersiz email' });
    }
    if (cleaned) {
        const dup = users.find(x => x.id !== u.id && (x.email || '').toLowerCase() === cleaned);
        if (dup) return res.status(409).json({ success: false, error: 'Bu email başka bir hesapta kullanılıyor' });
    }
    u.email = cleaned;
    await db.saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} email güncelledi: ${cleaned || '(silindi)'}`);
    res.json({ success: true, email: u.email });
}

// Update birth year
router.post('/account/birth-year', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin yaş bilgisi yok' });
    const by = parseInt(req.body?.birthYear);
    if (!by || isNaN(by)) return res.status(400).json({ success: false, error: 'Doğum yılı sayısal olmalı.' });
    const currentYear = new Date().getFullYear();
    if (by < 1925 || by > currentYear - 13) {
        return res.status(400).json({ success: false, error: `Doğum yılı ${currentYear - 100}-${currentYear - 13} arasında olmalı (13 yaş altı kullanıcı olamaz).` });
    }
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.birthYear) {
        return res.status(409).json({ success: false, error: 'Doğum yılı önceden girilmiş — değişiklik için admin ile iletişime geç.' });
    }
    u.birthYear = by;
    await db.saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} doğum yılı: ${by}`);
    res.json({ success: true, birthYear: by, age: calcAge(by) });
});

// Update Nickname
router.post('/account/nick', nickChangeLimiter, requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirler nick değiştiremez' });
    const { newNick } = req.body;
    const nick = String(newNick || '').trim();
    if (!nick || nick.length < 2 || nick.length > 20 || !/^[a-zA-Z0-9_]+$/.test(nick)) {
        return res.status(400).json({ success: false, error: 'Nick 2-20 karakter, sadece harf/rakam/_' });
    }
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (u.nick === nick) return res.status(400).json({ success: false, error: 'Yeni nick eskisiyle aynı' });
    if (u.nick_changed_at) {
        const elapsed = Date.now() - new Date(u.nick_changed_at).getTime();
        if (elapsed < 24 * 60 * 60 * 1000) {
            const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - elapsed) / (60 * 60 * 1000));
            return res.status(429).json({ success: false, error: `Nick'i 24 saatte bir değiştirebilirsin (${hoursLeft} saat sonra)` });
        }
    }
    if (users.find(x => x.id !== u.id && x.nick.toLowerCase() === nick.toLowerCase())) {
        return res.status(409).json({ success: false, error: 'Bu nick zaten alınmış' });
    }
    const oldNick = u.nick;
    u.nick = nick;
    u.nick_changed_at = new Date().toISOString();
    await db.saveUsers(users);

    try {
        const friendsAll = await db.loadFriends();
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
        if (changed) await db.saveFriends(friendsAll);
    } catch (e) { console.error('[ACCOUNT] Nick değişikliği friends güncelleme hatası:', e.message); }

    u.sessionId = crypto.randomBytes(16).toString('hex');
    await db.saveUsers(users);
    const newToken = jwt.sign({ id: u.id, nick: u.nick, role: u.role, sid: u.sessionId }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`[ACCOUNT] ${oldNick} → ${nick} (nick değişti)`);
    res.json({ success: true, nick: u.nick, token: newToken });
});

// Update Privacy
router.put('/account/privacy', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirlerin hesabı yok' });
    const { hideBirthYear, hideActiveRoom, hideInviteCode, hideFriends, dmFrom } = req.body;
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    u.privacy = u.privacy || {};
    if (hideBirthYear !== undefined) u.privacy.hideBirthYear = !!hideBirthYear;
    if (hideActiveRoom !== undefined) u.privacy.hideActiveRoom = !!hideActiveRoom;
    if (hideInviteCode !== undefined) u.privacy.hideInviteCode = !!hideInviteCode;
    if (hideFriends !== undefined) u.privacy.hideFriends = !!hideFriends;
    if (dmFrom !== undefined && ['all', 'friends', 'none'].includes(dmFrom)) u.privacy.dmFrom = dmFrom;

    await db.saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} gizlilik ayarlarını güncelledi`);
    res.json({ success: true, privacy: u.privacy });
});

// Delete Account
router.post('/account/delete', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafir hesabı zaten silinir' });
    const { confirmText, currentPassword } = req.body;
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    if (confirmText !== 'SIL') {
        return res.status(400).json({ success: false, error: '"SIL" yazarak onaylaman gerek' });
    }
    if (u.password && currentPassword) {
        const ok = await bcrypt.compare(String(currentPassword), u.password);
        if (!ok) return res.status(401).json({ success: false, error: 'Şifre yanlış' });
    } else if (u.password && !currentPassword) {
        return res.status(400).json({ success: false, error: 'Şifreni doğrula' });
    }
    const idx = users.findIndex(x => x.id === u.id);
    users.splice(idx, 1);
    await db.saveUsers(users);

    try {
        const friendsAll = await db.loadFriends();
        delete friendsAll[u.id];
        Object.keys(friendsAll).forEach(ownerId => {
            friendsAll[ownerId] = (friendsAll[ownerId] || []).filter(f => f.toLowerCase() !== u.nick.toLowerCase());
        });
        await db.saveFriends(friendsAll);
    } catch (e) { console.error('[ACCOUNT] Hesap silme friends temizleme hatası:', e.message); }

    try {
        const userRooms = await db.loadUserRooms();
        const remaining = userRooms.filter(r => r.host !== u.nick);
        if (remaining.length !== userRooms.length) await db.saveUserRooms(remaining);
    } catch (e) { console.error('[ACCOUNT] Hesap silme oda temizleme hatası:', e.message); }

    console.log(`[ACCOUNT] ${u.nick} hesabı SİLİNDİ (kullanıcı tarafından)`);
    res.json({ success: true, message: 'Hesabın silindi. Hoşça kal.' });
});

// Refresh Invite Code
router.post('/account/invite-refresh', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirin davet linki yok' });
    const users = await db.loadUsers();
    const u = users.find(x => x.id === req.user.id);
    if (!u) return res.status(404).json({ success: false, error: 'Bulunamadı' });
    u.invite_code = generateInviteCode();
    await db.saveUsers(users);
    console.log(`[ACCOUNT] ${u.nick} davet kodunu yeniledi: ${u.invite_code}`);
    res.json({ success: true, invite_code: u.invite_code });
});

// Public profile retrieval
router.get('/profile/:nick', async (req, res) => {
    const targetNick = req.params.nick;
    if (!targetNick) return res.status(400).json({ success: false, error: 'Nick gerekli' });
    try {
        const users = await db.loadUsers();
        const target = users.find(u => u.nick.toLowerCase() === targetNick.toLowerCase());
        if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

        const isSelf = req.headers.authorization ? (() => {
            try {
                const decoded = jwt.verify(req.headers.authorization.split(' ')[1], JWT_SECRET);
                return decoded.id === target.id;
            } catch { return false; }
        })() : false;

        let blockedByTarget = false;
        let selfUserId = null;
        if (req.headers.authorization) {
            try {
                const decoded = jwt.verify(req.headers.authorization.split(' ')[1], JWT_SECRET);
                selfUserId = decoded.id;
                const blocksAll = await db.loadBlocks();
                const targetBlocks = blocksAll[target.id] || [];
                if (targetBlocks.some(n => n.toLowerCase() === decoded.nick.toLowerCase())) {
                    blockedByTarget = true;
                }
            } catch {}
        }

        if (blockedByTarget) {
            return res.json({ success: true, blocked_by_target: true, nick: target.nick });
        }

        const privacy = target.privacy || { hideBirthYear: false, hideActiveRoom: false, hideInviteCode: false, hideFriends: false };
        const friendsAll = await db.loadFriends();
        const targetFriends = friendsAll[target.id] || [];

        let mutualFriends = [];
        if (selfUserId && selfUserId !== target.id) {
            const myFriends = friendsAll[selfUserId] || [];
            mutualFriends = targetFriends.filter(f => myFriends.some(mf => mf.toLowerCase() === f.toLowerCase()));
        }

        const friendsEnriched = [];
        const limit = 30;
        if (!privacy.hideFriends || isSelf) {
            const activeUsers = users.filter(u => targetFriends.some(f => f.toLowerCase() === u.nick.toLowerCase()));
            activeUsers.slice(0, limit).forEach(u => {
                friendsEnriched.push({
                    nick: u.nick,
                    avatar: u.avatar || 'default',
                    avatarPhoto: u.avatarPhoto ? `/assets/avatars/${u.avatarPhoto}` : null,
                    status: u.status || 'offline',
                    moodEmoji: u.moodEmoji || null,
                    moodText: u.moodText || null,
                    activeRoom: (!u.privacy?.hideActiveRoom) ? u.activeRoom : null
                });
            });
        }

        const userRooms = await db.loadUserRooms();
        const ownedRooms = userRooms.filter(r => r.host && r.host.toLowerCase() === target.nick.toLowerCase());

        res.json({
            success: true,
            id: target.id,
            nick: target.nick,
            display_name: target.display_name || '',
            avatar: target.avatar || 'default',
            avatarPhoto: target.avatarPhoto ? `/assets/avatars/${target.avatarPhoto}` : null,
            bio: target.bio || '',
            status: target.status || 'offline',
            personal_msg: target.personal_msg || '',
            about: target.about || '',
            createdAt: target.createdAt,
            invited_by_nick: target.invited_by ? users.find(u => u.id === target.invited_by)?.nick : null,
            invite_code: (!privacy.hideInviteCode || isSelf) ? target.invite_code : null,
            age: (!privacy.hideBirthYear || isSelf) ? calcAge(target.birthYear) : null,
            city: target.city || '',
            musicTaste: target.musicTaste || '',
            instagram: target.instagram || '',
            twitter: target.twitter || '',
            tiktok: target.tiktok || '',
            youtube: target.youtube || '',
            discord: target.discord || '',
            profileTheme: target.profileTheme || 'default',
            profileMusic: target.profileMusic || null,
            profileMusicName: target.profileMusicName || null,
            moodEmoji: target.moodEmoji || null,
            moodText: target.moodText || null,
            activeRoom: (!privacy.hideActiveRoom || isSelf) ? target.activeRoom : null,
            friendCount: targetFriends.length,
            friendsEnriched,
            mutualFriends,
            ownedRooms,
            badges: target.badges || []
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============ GUESTBOOK (ZİYARETÇİ DEFTERİ) ENDPOINTS ============

// GET /api/profile/:nick/guestbook
router.get('/profile/:nick/guestbook', async (req, res) => {
    const targetNick = req.params.nick;
    if (!targetNick) return res.status(400).json({ success: false, error: 'Nick gerekli' });
    try {
        const rows = db.db.prepare(`
            SELECT g.id, g.profile_nick, g.author AS fromNick, g.body AS message, g.ts,
                   u.avatar AS fromAvatar
            FROM guestbook g
            LEFT JOIN users u ON LOWER(g.author) = LOWER(u.nick)
            WHERE LOWER(g.profile_nick) = LOWER(?)
            ORDER BY g.ts DESC
        `).all(targetNick);

        res.json({ success: true, posts: rows });
    } catch (err) {
        console.error('[API] /api/profile/:nick/guestbook GET hatası:', err);
        res.status(500).json({ success: false, error: 'Ziyaretçi defteri yüklenemedi' });
    }
});

// POST /api/profile/:nick/guestbook
router.post('/profile/:nick/guestbook', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler defteri imzalayamaz' });
    }
    const targetNick = req.params.nick;
    const { message } = req.body;
    if (!targetNick) return res.status(400).json({ success: false, error: 'Nick gerekli' });
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Mesaj boş olamaz' });
    if (message.length > 200) return res.status(400).json({ success: false, error: 'Mesaj en fazla 200 karakter olabilir' });

    try {
        const id = crypto.randomUUID();
        const ts = Date.now();
        db.db.prepare(`
            INSERT INTO guestbook (id, profile_nick, author, body, ts)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, targetNick, req.user.nick, message.trim(), ts);

        res.json({ success: true });
    } catch (err) {
        console.error('[API] /api/profile/:nick/guestbook POST hatası:', err);
        res.status(500).json({ success: false, error: 'Deftere yazılamadı' });
    }
});

// DELETE /api/profile/:nick/guestbook/:postId
router.delete('/profile/:nick/guestbook/:postId', requireAuth, async (req, res) => {
    const { nick, postId } = req.params;
    if (!nick || !postId) return res.status(400).json({ success: false, error: 'Parametreler eksik' });

    try {
        const post = db.db.prepare(`SELECT * FROM guestbook WHERE id = ?`).get(postId);
        if (!post) return res.status(404).json({ success: false, error: 'Mesaj bulunamadı' });

        const isProfileOwner = req.user.nick.toLowerCase() === post.profile_nick.toLowerCase();
        const isAuthor = req.user.nick.toLowerCase() === post.author.toLowerCase();
        
        if (!isProfileOwner && !isAuthor) {
            return res.status(403).json({ success: false, error: 'Bu mesajı silmeye yetkiniz yok' });
        }

        db.db.prepare(`DELETE FROM guestbook WHERE id = ?`).run(postId);
        res.json({ success: true });
    } catch (err) {
        console.error('[API] /api/profile/:nick/guestbook/:postId DELETE hatası:', err);
        res.status(500).json({ success: false, error: 'Mesaj silinemedi' });
    }
});

// ============ ADMIN / MODERATOR ENDPOINTS (STATS, USERS, BANS) ============

const { fetchRoomData } = require('./rooms');

// GET /api/admin/stats
router.get('/admin/stats', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    try {
        const totalUsersRow = db.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role != 'guest'").get();
        const totalUsers = totalUsersRow ? totalUsersRow.count : 0;

        let totalOnline = 0;
        try {
            const baseRooms = await fetchRoomData();
            totalOnline = baseRooms.reduce((sum, r) => sum + (r.participants || 0), 0);
        } catch (e) {
            console.warn('[ADMIN-STATS] fetchRoomData failed:', e.message);
        }

        const nowStr = new Date().toISOString();
        const totalBansRow = db.db.prepare(`
            SELECT COUNT(*) AS count FROM global_bans 
            WHERE expiresAt IS NULL OR expiresAt > ?
        `).get(nowStr);
        const totalBans = totalBansRow ? totalBansRow.count : 0;

        const locks = await db.loadLocks();
        const lockedRooms = Object.keys(locks).length;

        res.json({
            success: true,
            totalUsers,
            totalOnline,
            totalBans,
            lockedRooms
        });
    } catch (err) {
        console.error('[API] /api/admin/stats error:', err);
        res.status(500).json({ success: false, error: 'İstatistikler alınamadı' });
    }
});

// GET /api/admin/users
router.get('/admin/users', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    try {
        const rows = db.db.prepare("SELECT id, nick, role, createdAt FROM users WHERE role != 'guest' ORDER BY createdAt DESC").all();
        res.json({ success: true, users: rows });
    } catch (err) {
        console.error('[API] /api/admin/users error:', err);
        res.status(500).json({ success: false, error: 'Kullanıcı listesi alınamadı' });
    }
});

// POST /api/admin/users/role
router.post('/admin/users/role', requireAuth, requireRole('admin'), async (req, res) => {
    const { userId, role } = req.body;
    if (!userId || !role) return res.status(400).json({ success: false, error: 'Parametreler eksik' });
    if (!['user', 'mod', 'admin'].includes(role)) {
        return res.status(400).json({ success: false, error: 'Geçersiz rol' });
    }

    try {
        const user = db.db.prepare("SELECT nick, role FROM users WHERE id = ?").get(userId);
        if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

        if (user.role === 'admin' && role !== 'admin') {
            const otherAdmins = db.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?").get(userId);
            if (!otherAdmins || otherAdmins.count === 0) {
                return res.status(400).json({ success: false, error: 'Sistemde en az bir yönetici kalmalıdır.' });
            }
        }

        db.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
        console.log(`[ADMIN] ${req.user.nick} kullanıcısının rolünü güncelledi: ${user.nick} → ${role}`);
        res.json({ success: true, nick: user.nick });
    } catch (err) {
        console.error('[API] /api/admin/users/role error:', err);
        res.status(500).json({ success: false, error: 'Rol güncellenemedi' });
    }
});

// GET /api/admin/bans
router.get('/admin/bans', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    try {
        const nowStr = new Date().toISOString();
        const rows = db.db.prepare(`
            SELECT nick, reason, by_nick AS bannedBy, createdAt, expiresAt 
            FROM global_bans 
            WHERE expiresAt IS NULL OR expiresAt > ?
            ORDER BY createdAt DESC
        `).all(nowStr);
        res.json({ success: true, bans: rows });
    } catch (err) {
        console.error('[API] /api/admin/bans error:', err);
        res.status(500).json({ success: false, error: 'Yasaklılar listesi alınamadı' });
    }
});

// POST /api/admin/ban
router.post('/admin/ban', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { nick, reason, duration } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli' });

    try {
        const cleanNick = nick.trim();
        const targetUser = db.db.prepare("SELECT role, id FROM users WHERE LOWER(nick) = LOWER(?)").get(cleanNick);
        if (targetUser && (targetUser.role === 'admin' || targetUser.role === 'mod')) {
            return res.status(403).json({ success: false, error: 'Yönetici veya moderatörler yasaklanamaz' });
        }

        const durationMin = parseInt(duration);
        const expiresAt = (durationMin > 0)
            ? new Date(Date.now() + durationMin * 60 * 1000).toISOString()
            : null;

        const banReason = reason ? reason.trim() : 'Yönetici tarafından yasaklandı';
        
        db.db.prepare(`
            INSERT OR REPLACE INTO global_bans (nick, reason, by_nick, createdAt, expiresAt)
            VALUES (?, ?, ?, ?, ?)
        `).run(cleanNick, banReason, req.user.nick, new Date().toISOString(), expiresAt);

        if (targetUser) {
            try {
                await pushNotification(targetUser.id, 'ban_warn', {
                    title: `⛔ Yasaklandın`,
                    body: `Sebep: ${banReason}${expiresAt ? ' — Bitiş: ' + new Date(expiresAt).toLocaleString('tr-TR') : ' — Kalıcı yasak'}`,
                    link: null,
                    from: req.user.nick,
                });
            } catch (e) {
                console.warn('[ADMIN-BAN] pushNotification failed:', e.message);
            }
        }

        const svc = getRoomServiceClient();
        if (svc) {
            try {
                const live = await svc.listRooms();
                for (const r of live) {
                    try {
                        await svc.removeParticipant(r.name, cleanNick);
                    } catch {}
                }
            } catch (lkErr) {
                console.warn('[ADMIN-BAN] LiveKit kick failed:', lkErr.message);
            }
        }

        try {
            pushModLog({
                action: 'admin-ban',
                by: req.user.nick,
                target: cleanNick,
                reason: banReason,
                details: { durationMin }
            });
        } catch (e) {
            console.warn('[ADMIN-BAN] pushModLog failed:', e.message);
        }

        res.json({ success: true, message: `@${cleanNick} başarıyla yasaklandı.` });
    } catch (err) {
        console.error('[API] /api/admin/ban error:', err);
        res.status(500).json({ success: false, error: 'Kullanıcı yasaklanamadı' });
    }
});

// POST /api/admin/unban
router.post('/admin/unban', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli' });

    try {
        const cleanNick = nick.trim();
        const existing = db.db.prepare("SELECT * FROM global_bans WHERE LOWER(nick) = LOWER(?)").get(cleanNick);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Bu kullanıcıya ait aktif bir yasak bulunamadı.' });
        }

        db.db.prepare("DELETE FROM global_bans WHERE LOWER(nick) = LOWER(?)").run(cleanNick);

        try {
            pushModLog({
                action: 'admin-unban',
                by: req.user.nick,
                target: cleanNick
            });
        } catch (e) {
            console.warn('[ADMIN-UNBAN] pushModLog failed:', e.message);
        }

        res.json({ success: true, message: `@${cleanNick} yasaklaması kaldırıldı.` });
    } catch (err) {
        console.error('[API] /api/admin/unban error:', err);
        res.status(500).json({ success: false, error: 'Yasak kaldırılamadı' });
    }
});

module.exports = router;
