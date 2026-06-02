require('dotenv').config();
const { AccessToken, RoomServiceClient, TrackSource } = require('livekit-server-sdk');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'local_dev_admin_secret_change_in_prod';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ============ LiveKit Config ============
const SOURCE_MAP = { microphone: TrackSource.MICROPHONE, camera: TrackSource.CAMERA, screen_share: TrackSource.SCREEN_SHARE };
function toTrackSources(sources) {
    if (!Array.isArray(sources)) return [];
    return sources.map(s => typeof s === 'string' ? (SOURCE_MAP[s] ?? s) : s).filter(s => s !== undefined);
}

function getRoomServiceClient() {
    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) return null;
    const httpUrl = url.replace('wss://', 'https://').replace('ws://', 'http://');
    return new RoomServiceClient(httpUrl, apiKey, apiSecret);
}

// ============ Mail Transporter ============
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

// ============ Age Helpers ============
function calcAge(birthYear) {
    if (!birthYear || isNaN(birthYear)) return null;
    return new Date().getFullYear() - parseInt(birthYear);
}
function isAdult(birthYear) {
    const a = calcAge(birthYear);
    return a !== null && a >= 18;
}

// ============ Rate Limiters ============
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Çok fazla deneme — 5 dakika sonra tekrar dene.' },
});
const dmLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'DM gönderme limiti — bir dakika bekle.' },
});
const kornaLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Korna spam — biraz bekle.' },
});
const chatModerateLimiter = rateLimit({
    windowMs: 10 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: true, blocked: true, safe: false, action: 'rate_limit', reason: 'Çok hızlı yazıyorsun, biraz yavaşla.' },
});
const stageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Sahne işlemleri için biraz bekle.' },
});
const camLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Kamera işlemleri için biraz bekle.' },
});
const roomCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Saatte en fazla 5 yeni oda açabilirsin.' },
});
const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Saatte rapor limiti aşıldı.' },
});
const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Davet limiti aşıldı.' },
});
const nickChangeLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Nick değiştirme — günde en fazla 3 kez.' },
});
const passwordAccessLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Çok fazla yanlış şifre — 10 dakika bekle.' },
});

// ============ Auth Middlewares ============
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token gerekli' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        req.user = decoded;
        if (decoded.role === 'guest') return next();
        try {
            const users = await db.loadUsers();
            const freshUser = users.find(u => u.nick.toLowerCase() === decoded.nick.toLowerCase());
            if (freshUser) {
                req.user.role = freshUser.role || 'user';
                req.user.id = freshUser.id;
                if (freshUser.sessionId && freshUser.sessionId !== decoded.sid) {
                    return res.status(401).json({
                        success: false,
                        error: 'Başka bir cihazdan giriş yapıldı. Lütfen tekrar giriş yap.',
                        code: 'session_replaced'
                    });
                }
            }
        } catch {}
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Geçersiz token' });
    }
}

function requireRole(...roles) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
        }
        try {
            const users = await db.loadUsers();
            const u = users.find(x => x.nick.toLowerCase() === req.user.nick.toLowerCase());
            const freshRole = u?.role || 'user';
            if (freshRole !== req.user.role) {
                console.warn(`[ROLE] ${req.user.nick} role mismatch: JWT=${req.user.role}, DB=${freshRole}`);
                req.user.role = freshRole;
            }
            if (!roles.includes(freshRole)) {
                return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
            }
            next();
        } catch (e) {
            res.status(403).json({ success: false, error: 'Yetkiniz yok' });
        }
    };
}

// ============ Activity & Notification Helpers ============
const ACTIVITY_FEED = [];
const ACTIVITY_MAX = 12;
function pushActivity(text, icon) {
    ACTIVITY_FEED.unshift({ text, icon: icon || '•', ts: Date.now() });
    if (ACTIVITY_FEED.length > ACTIVITY_MAX) ACTIVITY_FEED.pop();
}

const NOTIF_MAX_PER_USER = 50;
const NOTIF_TYPES = new Set(['dm', 'friend_add', 'ban_warn', 'ai_mod', 'invite_used', 'system', 'room_kick']);
async function pushNotification(userId, type, payload) {
    if (!userId || !NOTIF_TYPES.has(type)) return;
    try {
        const all = await db.loadNotifications();
        const list = all[userId] || [];
        list.unshift({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            type,
            title: (payload.title || '').slice(0, 100),
            body: (payload.body || '').slice(0, 200),
            link: payload.link || null,
            from: payload.from || null,
            ts: Date.now(),
            read: false,
        });
        if (list.length > NOTIF_MAX_PER_USER) list.length = NOTIF_MAX_PER_USER;
        all[userId] = list;
        await db.saveNotifications(all);
    } catch (e) { console.error('[NOTIF] push fail:', e.message); }
}

async function pushNotificationByNick(nick, type, payload) {
    if (!nick) return;
    const users = await db.loadUsers();
    const u = users.find(x => x.nick.toLowerCase() === String(nick).toLowerCase());
    if (u) await pushNotification(u.id, type, payload);
}

async function isUserBanned(nick) {
    const bans = await db.loadBans();
    const now = new Date();
    return bans.find(b => b.nick.toLowerCase() === nick.toLowerCase() && (!b.expiresAt || new Date(b.expiresAt) > now));
}

const MOD_LOG_MAX = 1000;
let _modLog = [];
(async () => {
    try { _modLog = await db.loadModLog(); } catch {}
})();

function pushModLog({ action, room, by, target, reason, details }) {
    if (!action || !by) return;
    _modLog.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        action,
        room: room || null,
        by,
        target: target || null,
        reason: reason ? String(reason).slice(0, 200) : '',
        details: details || null,
    });
    if (_modLog.length > MOD_LOG_MAX) _modLog.length = MOD_LOG_MAX;
    if (!pushModLog._t) {
        pushModLog._t = setTimeout(async () => {
            pushModLog._t = null;
            try { await db.saveModLog(_modLog); } catch {}
        }, 2000);
    }
}

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
        await svc.sendData(roomName, payload, 0);
    } catch (err) {
        console.warn('[Moderation] Bot broadcast hatası:', err.message);
    }
}

// ============ Preset & Room Configs ============
const VALID_ROOM_THEMES = new Set(['classic', 'xp', 'win2k', 'sakir', 'gece', 'pera', 'matrix', 'bliss', 'xp_metallic', 'space', 'romance']);
const ROOM_CATEGORIES = {
    free:  { label: 'Sohbet',   icon: '💬', cap: 'mic',     defaultBadge: null },
    music: { label: 'Müzik',    icon: '🎵', cap: 'mic+dj',  defaultBadge: 'music' },
    cam:   { label: 'Kamera',   icon: '📹', cap: 'mic+cam', defaultBadge: 'cam' },
    hot:   { label: 'Gece',     icon: '🌙', cap: 'mic',     defaultBadge: null },
    book:  { label: 'Edebiyat', icon: '📚', cap: 'mic',     defaultBadge: 'new' },
    game:  { label: 'Oyun',     icon: '🎮', cap: 'mic',     defaultBadge: null },
};
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
    for (const key in preset) {
        if (room[key] === undefined) room[key] = preset[key];
    }
    return room;
}
function applyCamMode(roomDef, mode) {
    if (mode === 'camera') {
        roomDef.cam_policy = 'speakers_only';
        roomDef.max_cameras = roomDef.category === 'cam' ? 12 : 4;
    } else if (mode === 'host_only') {
        roomDef.cam_policy = 'mod_only';
        roomDef.max_cameras = 2;
    } else if (mode === 'none') {
        roomDef.cam_policy = 'mod_only';
        roomDef.max_cameras = 0;
    }
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

module.exports = {
    JWT_SECRET,
    ADMIN_SECRET,
    GOOGLE_CLIENT_ID,
    googleClient,
    toTrackSources,
    getRoomServiceClient,
    sendMail,
    calcAge,
    isAdult,
    authLimiter,
    dmLimiter,
    kornaLimiter,
    chatModerateLimiter,
    stageLimiter,
    camLimiter,
    roomCreateLimiter,
    reportLimiter,
    inviteLimiter,
    nickChangeLimiter,
    passwordAccessLimiter,
    requireAuth,
    requireRole,
    ACTIVITY_FEED,
    pushActivity,
    pushNotification,
    pushNotificationByNick,
    isUserBanned,
    pushModLog,
    _modLog,
    broadcastModBot,
    VALID_ROOM_THEMES,
    ROOM_CATEGORIES,
    ROOM_PRESETS,
    applyPreset,
    applyCamMode,
    DEFAULT_SYSTEM_ROOMS
};
