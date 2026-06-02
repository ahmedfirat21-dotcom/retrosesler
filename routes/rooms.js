const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../services/db');
const Moderation = require('../services/moderation');

const {
    JWT_SECRET,
    toTrackSources,
    getRoomServiceClient,
    isAdult,
    requireAuth,
    requireRole,
    pushActivity,
    pushNotification,
    pushNotificationByNick,
    pushModLog,
    broadcastModBot,
    VALID_ROOM_THEMES,
    ROOM_CATEGORIES,
    ROOM_PRESETS,
    applyPreset,
    applyCamMode,
    DEFAULT_SYSTEM_ROOMS,
    stageLimiter,
    camLimiter,
    roomCreateLimiter,
    reportLimiter,
    inviteLimiter,
    passwordAccessLimiter,
    isUserBanned
} = require('../services/shared');

// ============ FILE AND STATE PATHS ============
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOCKS_FILE = path.join(DATA_DIR, 'locks.json');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const SYSTEM_ROOMS_FILE = path.join(DATA_DIR, 'system_rooms.json');
const USER_ROOMS_FILE = path.join(DATA_DIR, 'user_rooms.json');

async function ensureDataDir() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

async function atomicWriteJson(filePath, data) {
    const tmp = filePath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
}

// ============ PERSISTENT MEMORY MAPS ============

// 1. Room stages
const _roomStages = new Map();
const ROOM_STAGES_FILE = path.join(DATA_DIR, 'room_stages.json');

// Init — load from disk
(() => {
    try {
        if (!fs.existsSync(ROOM_STAGES_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ROOM_STAGES_FILE, 'utf8'));
        const now = Date.now();
        for (const [roomName, stage] of Object.entries(raw || {})) {
            const queue = (stage.queue || []).filter(q => (now - q.ts) < 3600000); // 1 hour queue limit
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
        if (_persistStages._t) return; // debounce 2s
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

// 2. Room bans (1 hour kick bans)
const _roomBans = new Map();
const ROOM_BAN_TTL_MS = 60 * 60 * 1000;
const ROOM_BANS_FILE = path.join(DATA_DIR, 'room_bans.json');

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
        if (_persistRoomBans._t) return;
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
    if (Date.now() - v.ts > ROOM_BAN_TTL_MS) {
        m.delete((nick || '').toLowerCase());
        _persistRoomBans();
        return null;
    }
    return v;
}

function addRoomBan(roomName, nick, by, reason) {
    let m = _roomBans.get(roomName);
    if (!m) {
        m = new Map();
        _roomBans.set(roomName, m);
    }
    m.set((nick || '').toLowerCase(), { ts: Date.now(), by, reason: reason || '' });
    _persistRoomBans();
}

function clearRoomBans(roomName) {
    _roomBans.delete(roomName);
    _persistRoomBans();
}

// 3. Room chat mutes
const _chatMutes = new Map();
const ROOM_CHAT_MUTES_FILE = path.join(DATA_DIR, 'room_chat_mutes.json');
let _chatMutesLoaded = false;

function _chatMuteKey(room, nick) {
    return room + '::' + (nick || '').toLowerCase();
}

function _loadChatMutesOnce() {
    if (_chatMutesLoaded) return;
    _chatMutesLoaded = true;
    try {
        if (!fs.existsSync(ROOM_CHAT_MUTES_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ROOM_CHAT_MUTES_FILE, 'utf8'));
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
            await ensureDataDir();
            await atomicWriteJson(ROOM_CHAT_MUTES_FILE, Object.fromEntries(_chatMutes.entries()));
        } catch (e) { console.warn('[CHAT-MUTE] save fail:', e.message); }
    }, 1500);
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

// 4. Extended room bans (24h or permanent)
const _extendedBans = new Map();
const ROOM_EXT_BANS_FILE = path.join(DATA_DIR, 'room_extended_bans.json');
let _extendedBansLoaded = false;

function _loadExtendedBansOnce() {
    if (_extendedBansLoaded) return;
    _extendedBansLoaded = true;
    try {
        if (!fs.existsSync(ROOM_EXT_BANS_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(ROOM_EXT_BANS_FILE, 'utf8'));
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
            await ensureDataDir();
            await atomicWriteJson(ROOM_EXT_BANS_FILE, Object.fromEntries(_extendedBans.entries()));
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

// ============ ROOM RESOLUTIONS & CACHES ============
let ROOM_DEFS = [...DEFAULT_SYSTEM_ROOMS];
(async () => {
    try {
        ROOM_DEFS = await db.loadSystemRooms();
        if (ROOM_DEFS.length === 0) {
            await db.saveSystemRooms(DEFAULT_SYSTEM_ROOMS);
            ROOM_DEFS = [...DEFAULT_SYSTEM_ROOMS];
        }
    } catch {}
})();

async function findRoomDef(roomName) {
    return ROOM_DEFS.find(r => r.name === roomName) || (await db.loadUserRooms()).find(r => r.name === roomName);
}

function isRoomHost(roomDef, nick) {
    if (!roomDef || !nick) return false;
    const lo = nick.toLowerCase();
    if (roomDef.host && roomDef.host.toLowerCase() === lo) return true;
    if (Array.isArray(roomDef.coHosts) && roomDef.coHosts.some(n => (n || '').toLowerCase() === lo)) return true;
    return false;
}

async function getFriendsOf(userId) {
    const all = await db.loadFriends();
    return all[userId] || [];
}

let roomCache = { data: null, ts: 0 };
const CACHE_TTL = 5000; // 5 seconds

// Helper counting functions
function speakerCount(stage) {
    return Object.keys(stage.speakers).length;
}
function cameraCount(stage) {
    return Object.values(stage.speakers).filter(s => s.type === 'cam' || s.type === 'both').length;
}

// Check if mod is present in room
const _modPresenceCache = new Map();
async function hasModInRoom(roomName) {
    const cached = _modPresenceCache.get(roomName);
    if (cached && Date.now() - cached.ts < 15000) return cached.hasMod;
    const svc = getRoomServiceClient();
    if (!svc) return false;
    try {
        const parts = await svc.listParticipants(roomName);
        const users = await db.loadUsers();
        const def = await findRoomDef(roomName);
        const hostNick = def?.host?.toLowerCase();
        const coHostsLower = Array.isArray(def?.coHosts) ? def.coHosts.map(n => (n || '').toLowerCase()) : [];
        const hasMod = parts.some(p => {
            const lc = p.identity.toLowerCase();
            if (hostNick && lc === hostNick) return true;
            if (coHostsLower.includes(lc)) return true;
            const u = users.find(x => x.nick.toLowerCase() === lc);
            return u && (u.role === 'admin' || u.role === 'mod');
        });
        _modPresenceCache.set(roomName, { hasMod, ts: Date.now() });
        return hasMod;
    } catch {
        return false;
    }
}

// LiveKit user permissions update
async function updateLiveKitPermission(roomName, identity, opts) {
    const svc = getRoomServiceClient();
    if (!svc) return false;
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
            canPublishSources: toTrackSources(sources),
        });
        return true;
    } catch (err) {
        console.warn(`[STAGE] LiveKit permission update fail (${identity}@${roomName}):`, err.message);
        throw err;
    }
}

async function grantStageInternal(roomName, identity, type = 'mic') {
    const stage = getRoomStage(roomName);
    const prevQueue = [...stage.queue];
    const prevSpeaker = stage.speakers[identity];
    stage.queue = stage.queue.filter(q => q.identity.toLowerCase() !== identity.toLowerCase());
    stage.speakers[identity] = { ts: Date.now(), lastSpeakTs: Date.now(), type };
    try {
        await updateLiveKitPermission(roomName, identity, true);
    } catch (e) {
        stage.queue = prevQueue;
        if (prevSpeaker) stage.speakers[identity] = prevSpeaker;
        else delete stage.speakers[identity];
        throw e;
    }
    _persistStages();
}

async function revokeStageInternal(roomName, identity, reason) {
    const stage = getRoomStage(roomName);
    if (!stage.speakers[identity]) return false;
    const prev = stage.speakers[identity];
    delete stage.speakers[identity];
    try {
        await updateLiveKitPermission(roomName, identity, false);
    } catch (e) {
        stage.speakers[identity] = prev;
        throw e;
    }
    _persistStages();
    return true;
}

// Fetch Room Data combining LiveKit data
async function fetchRoomData() {
    const now = Date.now();
    if (roomCache.data && (now - roomCache.ts) < CACHE_TTL) {
        return roomCache.data;
    }
    const userRooms = await db.loadUserRooms();
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
                access: def.access || 'public',
                theme: def.theme || 'classic',
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
        return roomCache.data || ROOM_DEFS.map(r => ({ ...r, participants: 0, users: [] }));
    }
}

// BOTS INJECT DEFINITIONS
const HOUSE_BOTS = [
    { nick: 'DJ_RetroBot', room: 'Müzik Odası', role: 'host', emoji: '🎧', alwaysShow: true },
    { nick: 'RetroHost',   room: 'Genel Sohbet', role: 'host', emoji: '🎙️', alwaysShow: false },
    { nick: 'NostaljiAna', room: 'Nostalji Köşesi', role: 'host', emoji: '📻', alwaysShow: false },
];
const BOT_HIDE_THRESHOLD = 3;

// ============ SHOUTBOX / LOBBY CHAT ============
const lobbyChat = [];
const LOBBY_CHAT_MAX = 50;

// ============ AUTO CLOSE / HOSTLESS TIMERS ============
const HOSTLESS_GRACE_MS = 5 * 60 * 1000;
const _hostlessSince = new Map();
const _hostlessWarned = new Set();

async function autoCloseEmptyRooms() {
    const svc = getRoomServiceClient();
    if (!svc) return;
    const rooms = await db.loadUserRooms();
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

        if (age > TEN_MIN && count === 0) {
            console.log(`[ROOM] Auto-close (boş 10dk): ${r.name}`);
            removed++;
            svc.deleteRoom(r.name).catch(() => {});
            clearRoomBans(r.name);
            _hostlessSince.delete(r.name);
            _hostlessWarned.delete(r.name);
            try { pushActivity(`${r.name} odası boş kaldığı için kapandı`, '🚪'); } catch {}
            pushModLog({ action: 'auto-close-empty', room: r.name, by: 'system' });
            continue;
        }

        if (count > 0 && lkRoom) {
            let participants = [];
            try { participants = await svc.listParticipants(r.name); } catch {}
            const presentIds = new Set(participants.map(p => (p.identity || '').toLowerCase()));
            const hostPresent = r.host && presentIds.has(r.host.toLowerCase());
            const coHostPresent = Array.isArray(r.coHosts) && r.coHosts.some(n => presentIds.has((n || '').toLowerCase()));
            const anyHostPresent = hostPresent || coHostPresent;

            if (!anyHostPresent) {
                if (!_hostlessSince.has(r.name)) {
                    _hostlessSince.set(r.name, now);
                }
                const hostlessFor = now - _hostlessSince.get(r.name);
                if (!_hostlessWarned.has(r.name)) {
                    _hostlessWarned.add(r.name);
                    broadcastModBot(r.name, `⚠️ Ev sahibi (@${r.host}) ayrıldı. 5 dakika içinde geri dönmezse oda kapanacak.`);
                }
                if (hostlessFor >= HOSTLESS_GRACE_MS) {
                    removed++;
                    broadcastModBot(r.name, `🚪 Ev sahibi geri dönmedi — oda kapanıyor.`);
                    for (const p of participants) {
                        try { await svc.removeParticipant(r.name, p.identity); } catch {}
                    }
                    svc.deleteRoom(r.name).catch(() => {});
                    clearRoomBans(r.name);
                    _hostlessSince.delete(r.name);
                    _hostlessWarned.delete(r.name);
                    try { pushActivity(`${r.name} odası ev sahibi dönmediği için kapandı`, '🚪'); } catch {}
                    pushModLog({ action: 'auto-close-hostless', room: r.name, by: 'system', details: { host: r.host, coHosts: r.coHosts || [] } });
                    continue;
                }
            } else {
                if (_hostlessSince.has(r.name)) {
                    _hostlessSince.delete(r.name);
                    _hostlessWarned.delete(r.name);
                    broadcastModBot(r.name, `✅ Ev sahibi geri döndü, oda devam ediyor.`);
                }
            }
        } else {
            _hostlessSince.delete(r.name);
            _hostlessWarned.delete(r.name);
        }
        toKeep.push(r);
    }
    if (removed > 0) {
        await db.saveUserRooms(toKeep);
        roomCache.ts = 0;
    }
}
setInterval(autoCloseEmptyRooms, 60 * 1000);

// Stage periodic cleanup (every 20s)
setInterval(async () => {
    const svc = getRoomServiceClient();
    if (!svc) return;
    for (const [roomName, stage] of _roomStages.entries()) {
        if (speakerCount(stage) === 0 && stage.queue.length === 0) continue;
        let participants;
        try { participants = await svc.listParticipants(roomName); }
        catch { continue; }
        const livingMap = new Map();
        participants.forEach(p => livingMap.set(p.identity.toLowerCase(), p));

        const def = await findRoomDef(roomName);
        const now = Date.now();
        const timeLimit = def?.speaker_time_limit || 0;
        const silenceKick = def?.silence_kick_seconds || 0;

        for (const identity of Object.keys(stage.speakers)) {
            if (!livingMap.has(identity.toLowerCase())) {
                delete stage.speakers[identity];
                _persistStages();
                continue;
            }
            const sp = stage.speakers[identity];
            const livingP = livingMap.get(identity.toLowerCase());
            if (timeLimit > 0 && (now - sp.ts) / 1000 > timeLimit && !sp.timeWarned) {
                sp.timeWarned = true;
                const users = await db.loadUsers();
                const u = users.find(x => x.nick.toLowerCase() === identity.toLowerCase());
                if (u) {
                    await pushNotification(u.id, 'system', {
                        title: `⏰ Sahne süren doluyor`,
                        body: `"${roomName}" odasında ${Math.floor(timeLimit / 60)} dk'dan fazla konuşuyorsun — biraz toparla, sıradakilere yer aç.`,
                        link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(identity),
                    });
                }
            }
            if (silenceKick > 0) {
                const audioTracks = (livingP.tracks || []).filter(t => t.type === 1);
                const anyAudioActive = audioTracks.some(t => !t.muted);
                if (anyAudioActive) {
                    sp.lastSpeakTs = now;
                    sp.silenceWarned = false;
                } else if ((now - (sp.lastSpeakTs || sp.ts)) / 1000 > silenceKick && !sp.silenceWarned) {
                    sp.silenceWarned = true;
                    const users = await db.loadUsers();
                    for (const p of livingMap.values()) {
                        const u = users.find(x => x.nick.toLowerCase() === p.identity.toLowerCase());
                        if (u && (u.role === 'admin' || u.role === 'mod')) {
                            await pushNotification(u.id, 'system', {
                                title: `🤫 Sessiz konuşmacı`,
                                body: `"${roomName}" odasında @${identity} ${Math.floor(silenceKick / 60)} dk'dır konuşmuyor — indirmek isteyebilirsin.`,
                                link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(p.identity),
                            });
                        }
                    }
                }
            }
        }

        const before = stage.queue.length;
        stage.queue = stage.queue.filter(q => livingMap.has(q.identity.toLowerCase()));
        if (before !== stage.queue.length) {
            _persistStages();
        }

        if (def && def.auto_stage !== false && stage.queue.length > 0 && speakerCount(stage) < ((def.max_speakers ?? 6))) {
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
}, 20000);


// ============ REPORT LOG HOOKS ============
const _reportLog = (() => {
    try {
        if (!fs.existsSync(REPORTS_FILE)) return [];
        return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8')) || [];
    } catch { return []; }
})();
function _persistReportLog() {
    try {
        if (_persistReportLog._t) return;
        _persistReportLog._t = setTimeout(async () => {
            _persistReportLog._t = null;
            try { await ensureDataDir(); } catch {}
            try { await atomicWriteJson(REPORTS_FILE, _reportLog); } catch {}
        }, 2000);
    } catch {}
}
const _reportHistory = new Map();
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
async function aiKickFromRoom(room, nick, reason) {
    const svc = getRoomServiceClient();
    if (!svc) return;
    try {
        await svc.removeParticipant(room, nick);
    } catch {}
}
async function aiBanUser(nick, durationMs, reason, category) {
    try {
        const bans = await db.loadBans();
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
        await db.saveBans(bans);
        await pushNotificationByNick(nick, 'ban_warn', {
            title: `⛔ Yasaklandın`,
            body: `Sebep: ${reason || 'Kural ihlali'}${expiresAt ? ' — Bitiş: ' + new Date(expiresAt).toLocaleString('tr-TR') : ' — Kalıcı yasak'}`,
            link: null,
            from: 'RetroModBot',
        });
    } catch {}
    const svc = getRoomServiceClient();
    if (svc) {
        try {
            const live = await svc.listRooms();
            for (const r of live) {
                try { await svc.removeParticipant(r.name, nick); } catch {}
            }
        } catch {}
    }
}
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


// ============ API ROUTES ============

// GET /api/rooms - list all rooms
router.get('/rooms', async (req, res) => {
    try {
        const baseRooms = await fetchRoomData();
        const rooms = baseRooms.map(r => ({
            ...r,
            users: Array.isArray(r.users) ? [...r.users] : [],
        }));
        for (const room of rooms) {
            const realCount = room.participants || 0;
            const allBots = HOUSE_BOTS.filter(b => b.room === room.name);
            const visibleBots = realCount >= BOT_HIDE_THRESHOLD ? allBots.filter(b => b.alwaysShow) : allBots;
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

// GET /api/rooms/categories
router.get('/rooms/categories', async (req, res) => {
    res.json({ success: true, categories: ROOM_CATEGORIES });
});

// POST /api/rooms/create
router.post('/rooms/create', roomCreateLimiter, requireAuth, async (req, res) => {
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
        invitedList = [...new Set(invitedNicks
            .filter(n => typeof n === 'string')
            .map(n => n.trim().toLowerCase())
            .filter(n => n.length >= 2 && n.length <= 30)
        )].slice(0, 30);
        if (invitedList.length === 0) {
            return res.status(400).json({ success: false, error: 'Geçerli nick listesi gerekli.' });
        }
    }

    const existing = ROOM_DEFS.find(r => r.name.toLowerCase() === cleanName.toLowerCase())
                  || (await db.loadUserRooms()).find(r => r.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
        return res.status(409).json({ success: false, error: 'Bu isimde oda zaten var.' });
    }
    const myActive = (await db.loadUserRooms()).filter(r => r.hostId === req.user.id).length;
    if (myActive >= 2) {
        return res.status(429).json({ success: false, error: 'En fazla 2 aktif oda — bir önceki odanı kapat.' });
    }
    if (is_18_plus) {
        const hostUser = (await db.loadUsers()).find(u => u.id === req.user.id);
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
        access: accessMode,
        passwordHash,
        invitedNicks: invitedList,
        coHosts: [],
        is_18_plus: !!is_18_plus,
        theme: safeTheme,
    });
    if (cam_mode && ['camera','host_only','none'].includes(cam_mode)) {
        applyCamMode(newRoom, cam_mode);
    }
    const rooms = await db.loadUserRooms();
    rooms.push(newRoom);
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    const accessLabel = { public: 'açık', password: '🔒 şifreli', invite: '📨 davetli', friends: '👥 arkadaşlar' }[accessMode];
    console.log(`[ROOM] Üye oda açıldı: ${cleanName} (host: ${req.user.nick}, ${accessLabel})`);
    try { pushActivity(`${req.user.nick} yeni oda açtı: ${cat.icon} ${cleanName}`, '🚪'); } catch {}
    const { passwordHash: _, ...safeRoom } = newRoom;
    res.json({ success: true, room: safeRoom });
});

// DELETE /api/rooms/:name
router.delete('/rooms/:name', requireAuth, async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const rooms = await db.loadUserRooms();
    const idx = rooms.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı.' });
    const room = rooms[idx];
    if (room.hostId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Bu oda senin değil.' });
    }
    rooms.splice(idx, 1);
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    clearRoomBans(name);
    const svc = getRoomServiceClient();
    if (svc) { svc.deleteRoom(name).catch(() => {}); }
    console.log(`[ROOM] Oda kapatıldı: ${name}`);
    res.json({ success: true });
});

// GET /api/rooms/mine
router.get('/rooms/mine', requireAuth, async (req, res) => {
    const rooms = (await db.loadUserRooms()).filter(r => r.hostId === req.user.id);
    const safe = rooms.map(({ passwordHash, ...r }) => r);
    res.json({ success: true, rooms: safe });
});

// PUT /api/rooms/:name/settings
router.put('/rooms/:name/settings', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const rooms = await db.loadUserRooms();
    const idx = rooms.findIndex(r => r.name === roomName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Üye odası değil ya da bulunamadı' });
    const room = rooms[idx];
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    if (room.hostId !== req.user.id && !isStaff) {
        return res.status(403).json({ success: false, error: 'Sadece oda kurucusu ayarları değiştirebilir.' });
    }
    const {
        desc, mic_policy, cam_policy, max_speakers, max_cameras,
        speaker_time_limit, silence_kick_seconds, ai_level,
        access, password, theme, cam_mode
    } = req.body || {};
    const VALID_MIC_POL_USER = ['open', 'request', 'invite_only'];
    const VALID_CAM_POL_USER = ['speakers_only', 'mod_only'];
    const VALID_AI_USER = ['off', 'standard', 'strict'];
    if (mic_policy && !VALID_MIC_POL_USER.includes(mic_policy)) return res.status(400).json({ success: false, error: 'Geçersiz mic_policy' });
    if (cam_policy && !VALID_CAM_POL_USER.includes(cam_policy)) return res.status(400).json({ success: false, error: 'Geçersiz cam_policy' });
    if (ai_level && !VALID_AI_USER.includes(ai_level)) return res.status(400).json({ success: false, error: 'Geçersiz ai_level' });
    if (access && !['public', 'password', 'invite', 'friends'].includes(access)) return res.status(400).json({ success: false, error: 'Geçersiz access' });
    if (theme && !VALID_ROOM_THEMES.has(theme)) return res.status(400).json({ success: false, error: 'Geçersiz tema' });
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
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    const changedFields = ['desc','mic_policy','cam_policy','max_speakers','max_cameras','speaker_time_limit','silence_kick_seconds','ai_level','access','theme','cam_mode']
        .filter(k => req.body && req.body[k] !== undefined);
    pushModLog({ action: 'settings-changed', room: roomName, by: req.user.nick, details: { changed: changedFields } });
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const { passwordHash: _, ...safeRoom } = room;
            const payload = Buffer.from(JSON.stringify({ type: 'settings_changed', room: safeRoom, changed: changedFields, by: req.user.nick }));
            await svc.sendData(roomName, payload, 0);
        }
        const labelMap = {
            desc: 'açıklama', mic_policy: 'mikrofon', cam_policy: 'kamera politikası',
            max_speakers: 'max konuşmacı', max_cameras: 'max kamera',
            speaker_time_limit: 'konuşma süresi', silence_kick_seconds: 'sessizlik indirme',
            ai_level: 'AI seviyesi', access: 'erişim modu', theme: 'tema', cam_mode: 'kamera modu',
        };
        const labels = changedFields.map(f => labelMap[f] || f).join(', ');
        if (changedFields.length) broadcastModBot(roomName, `⚙️ Host (${req.user.nick}) oda ayarlarını değiştirdi: ${labels}.`);
    } catch {}
    const { passwordHash, ...safe } = room;
    res.json({ success: true, room: safe });
});

// POST /api/rooms/:name/check-access
router.post('/rooms/:name/check-access', passwordAccessLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { password } = req.body || {};
    const roomDef = await findRoomDef(roomName);
    if (!roomDef) return res.status(404).json({ success: false, error: 'Oda yok' });
    if (roomDef.access !== 'password' || !roomDef.passwordHash) {
        return res.json({ success: true, access: 'ok', info: 'Şifresiz oda.' });
    }
    if (!password) return res.status(400).json({ success: false, error: 'Oda şifreli — şifre gerekli.' });
    const ok = await bcrypt.compare(String(password), roomDef.passwordHash);
    if (!ok) return res.status(401).json({ success: false, error: 'Yanlış şifre' });
    const acToken = jwt.sign({
        kind: 'room-access', room: roomName, nick: req.user.nick, ts: Date.now()
    }, JWT_SECRET, { expiresIn: '15m' });
    res.json({ success: true, access: 'ok', token: acToken });
});

// GET /api/rooms/:name/invites
router.get('/rooms/:name/invites', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda bulunamadı' });
    if (!isRoomHost(def, req.user.nick) && req.user.role !== 'admin' && req.user.role !== 'mod') {
        return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
    }
    res.json({ success: true, invited: def.invitedNicks || [] });
});

// POST /api/rooms/:name/invites
router.post('/rooms/:name/invites', inviteLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { nick, action } = req.body || {};
    if (!nick || !['add', 'remove'].includes(action)) {
        return res.status(400).json({ success: false, error: 'nick ve action (add/remove) gerekli' });
    }
    const rooms = await db.loadUserRooms();
    const idx = rooms.findIndex(r => r.name === roomName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Üye odası değil' });
    const room = rooms[idx];
    if (!isRoomHost(room, req.user.nick) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Yetkiniz yok' });
    }
    const cleanNick = String(nick).trim().toLowerCase();
    room.invitedNicks = room.invitedNicks || [];
    if (action === 'add') {
        const users = await db.loadUsers();
        const target = users.find(u => u.nick.toLowerCase() === cleanNick);
        if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
        if (!room.invitedNicks.includes(cleanNick)) {
            if (room.invitedNicks.length >= 50) return res.status(400).json({ success: false, error: 'En fazla 50 davetli ekleyebilirsin.' });
            room.invitedNicks.push(cleanNick);
            await pushNotification(target.id, 'system', {
                title: `📨 Özel odaya davet edildin`,
                body: `"${roomName}" özel odasına host @${req.user.nick} tarafından davet edildin.`,
                link: `/?room=${encodeURIComponent(roomName)}`,
                from: req.user.nick
            });
        }
    } else {
        room.invitedNicks = room.invitedNicks.filter(n => n !== cleanNick);
    }
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    res.json({ success: true, invited: room.invitedNicks });
});

// POST /api/room/:name/host-kick
router.post('/room/:name/host-kick', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity, reason } = req.body || {};
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece oda host\'u veya admin atabilir.' });
    if (identity.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini atamazsın.' });
    }
    if (def.host && def.host.toLowerCase() === identity.toLowerCase() && !isStaff) {
        return res.status(403).json({ success: false, error: 'Host\'u atamazsın.' });
    }
    const stage = getRoomStage(roomName);
    if (stage.speakers[identity]) {
        delete stage.speakers[identity];
        _persistStages();
        try { await updateLiveKitPermission(roomName, identity, false); } catch {}
    }
    const svc = getRoomServiceClient();
    if (svc) {
        try { await svc.removeParticipant(roomName, identity); } catch {}
    }
    addRoomBan(roomName, identity, req.user.nick, String(reason || '').slice(0, 100));
    pushModLog({ action: 'host-kick', room: roomName, by: req.user.nick, target: identity, reason });
    try {
        const u = (await db.loadUsers()).find(x => x.nick.toLowerCase() === identity.toLowerCase());
        if (u) await pushNotification(u.id, 'room_kick', {
            title: `🚪 Odadan çıkarıldın`,
            body: `"${roomName}" odasının yönetimi seni 1 saatliğine uzaklaştırdı.${reason ? ' Sebep: ' + reason : ''}`,
            from: req.user.nick,
        });
    } catch {}
    res.json({ success: true, banUntilTs: Date.now() + ROOM_BAN_TTL_MS });
});

// POST /api/room/:name/co-host
router.post('/room/:name/co-host', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { nick, action } = req.body || {};
    if (!nick || !['add', 'remove'].includes(action)) {
        return res.status(400).json({ success: false, error: 'nick ve action (add/remove) gerekli' });
    }
    const rooms = await db.loadUserRooms();
    const idx = rooms.findIndex(r => r.name === roomName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Üye odası değil' });
    const room = rooms[idx];
    const isStaff = req.user.role === 'admin';
    if (room.hostId !== req.user.id && !isStaff) {
        return res.status(403).json({ success: false, error: 'Sadece kurucu co-host atayabilir.' });
    }
    const cleanNick = String(nick).trim();
    room.coHosts = room.coHosts || [];
    if (action === 'add') {
        if (room.coHosts.length >= 2) return res.status(400).json({ success: false, error: 'En fazla 2 co-host atayabilirsin.' });
        if (cleanNick.toLowerCase() === room.host.toLowerCase()) return res.status(400).json({ success: false, error: 'Kendini co-host atayamazsın.' });
        if (!room.coHosts.some(n => n.toLowerCase() === cleanNick.toLowerCase())) {
            room.coHosts.push(cleanNick);
            pushModLog({ action: 'co-host-add', room: roomName, by: req.user.nick, target: cleanNick });
            broadcastModBot(roomName, `👑 @${cleanNick} artık bu odanın co-host'u (yardımcı yöneticisi).`);
        }
    } else {
        room.coHosts = room.coHosts.filter(n => n.toLowerCase() !== cleanNick.toLowerCase());
        pushModLog({ action: 'co-host-remove', room: roomName, by: req.user.nick, target: cleanNick });
        broadcastModBot(roomName, `👑 @${cleanNick} co-host yetkisi kaldırıldı.`);
    }
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    res.json({ success: true, coHosts: room.coHosts });
});

// POST /api/room/:name/chat-mute
router.post('/room/:name/chat-mute', requireAuth, async (req, res) => {
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
    broadcastModBot(roomName, `🔇 @${nick} sohbet susturuldu (${dur ? dur + ' dk' : 'süresiz'}). Sebep: ${reason || 'belirtilmedi'}`);
    try {
        const svc = getRoomServiceClient();
        if (svc) {
            const payload = Buffer.from(JSON.stringify({ type: 'chat_mute', target: nick, until, by: req.user.nick, reason }));
            await svc.sendData(roomName, payload, 0);
        }
    } catch {}
    res.json({ success: true, until });
});

// DELETE /api/room/:name/chat-mute/:nick
router.delete('/room/:name/chat-mute/:nick', requireAuth, async (req, res) => {
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
    } catch {}
    res.json({ success: true });
});

// DELETE /api/room/:name/message
router.delete('/room/:name/message', requireAuth, async (req, res) => {
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
            const payload = Buffer.Buffer.from(JSON.stringify({ type: 'msg_delete', msgId, by: req.user.nick }));
            await svc.sendData(roomName, payload, 0);
        }
    } catch {}
    res.json({ success: true });
});

// GET /api/room/:name/host-bans
router.get('/room/:name/host-bans', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });

    const now = Date.now();
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
    for (const [key, val] of _extendedBans.entries()) {
        if (!key.startsWith(roomName + '::')) continue;
        if (val.until && val.until < now) continue;
        const nick = key.split('::')[1];
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

// DELETE /api/room/:name/host-ban/:nick
router.delete('/room/:name/host-ban/:nick', requireAuth, async (req, res) => {
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
    const roomBansMap = _roomBans.get(roomName);
    if (roomBansMap && roomBansMap.delete(nickLower)) { _persistRoomBans(); removed = true; }
    _loadExtendedBansOnce();
    if (_extendedBans.delete(key)) { _persistExtendedBans(); removed = true; }
    if (removed) {
        pushModLog({ action: 'host-unban', room: roomName, by: req.user.nick, target: nick });
        broadcastModBot(roomName, `✅ @${nick} yasağı kaldırıldı (host: ${req.user.nick}).`);
    }
    res.json({ success: true, removed });
});

// POST /api/room/:name/host-ban
const HOST_BAN_DURATIONS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, 'perm': null };
router.post('/room/:name/host-ban', requireAuth, async (req, res) => {
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
    const stage = getRoomStage(roomName);
    if (stage.speakers[nick]) {
        delete stage.speakers[nick];
        _persistStages();
        try { await updateLiveKitPermission(roomName, nick, false); } catch {}
    }
    const svc = getRoomServiceClient();
    if (svc) try { await svc.removeParticipant(roomName, nick); } catch {}
    const ms = HOST_BAN_DURATIONS[duration];
    addRoomBan(roomName, nick, req.user.nick, reason);
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

// POST /api/room/:name/mute-all
router.post('/room/:name/mute-all', requireAuth, async (req, res) => {
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
        if (identity.toLowerCase() === req.user.nick.toLowerCase()) continue;
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
    broadcastModBot(roomName, `🔇 Host tüm konuşmacıları susturdu. (${muted} kişi)`);
    res.json({ success: true, muted });
});

// POST /api/room/:name/host-lock
router.post('/room/:name/host-lock', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { locked } = req.body || {};
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, req.user.nick);
    if (!isStaff && !isHost) return res.status(403).json({ success: false, error: 'Sadece host/mod' });
    try {
        const locks = await db.loadLocks();
        if (locked) {
            locks[roomName] = { lockedBy: req.user.nick, lockedAt: new Date().toISOString() };
        } else {
            delete locks[roomName];
        }
        await db.saveLocks(locks);
        pushModLog({ action: locked ? 'host-lock' : 'host-unlock', room: roomName, by: req.user.nick });
        broadcastModBot(roomName, locked ? `🔒 Oda kilitlendi (yeni kimse giremez)` : `🔓 Oda kilidi kaldırıldı`);
        res.json({ success: true, locked: !!locked });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/room/:name/chat-mutes
router.get('/room/:name/chat-mutes', requireAuth, async (req, res) => {
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

// GET /api/room/:name/stage
router.get('/room/:name/stage', requireAuth, async (req, res) => {
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
            coHosts: Array.isArray(def.coHosts) ? def.coHosts : [],
            desc: def.desc || '',
            max: def.max || 100,
            isUserRoom: !!def.host,
            theme: (def.theme && VALID_ROOM_THEMES.has(def.theme)) ? def.theme : 'classic',
            access: def.access || 'public',
        },
        settings: {
            max_speakers: (def.max_speakers ?? 6),
            max_cameras: (def.max_cameras ?? 4),
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

// POST /api/room/:name/raise-hand
router.post('/room/:name/raise-hand', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    if (def.mic_policy === 'invite_only' && req.user.role !== 'admin' && req.user.role !== 'mod') {
        const isHost = isRoomHost(def, req.user.nick);
        if (!isHost) return res.status(403).json({ success: false, error: 'Bu oda davete dayalı — host seni davet etmeli.' });
    }
    const stage = getRoomStage(roomName);
    const me = req.user.nick;
    if (stage.speakers[me]) {
        return res.status(409).json({ success: false, error: 'Zaten sahnedesin.' });
    }
    const existing = stage.queue.findIndex(q => q.identity.toLowerCase() === me.toLowerCase());
    if (existing >= 0) {
        return res.json({ success: true, in_queue: true, position: existing + 1, message: 'Zaten kuyruktasın.' });
    }
    stage.queue.push({ identity: me, ts: Date.now() });
    _persistStages();
    console.log(`[STAGE] ${me} söz istedi: ${roomName} (kuyrukta ${stage.queue.length})`);
    if (def.auto_stage !== false && speakerCount(stage) < ((def.max_speakers ?? 6))) {
        const modPresent = await hasModInRoom(roomName);
        if (!modPresent) {
            try {
                await grantStageInternal(roomName, me, 'mic');
                return res.json({ success: true, granted: true, message: 'Sahneye alındın — mikrofonun açık.' });
            } catch (e) {
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

// POST /api/room/:name/reject-hand
router.post('/room/:name/reject-hand', requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isHost = isRoomHost(def, req.user.nick);
    const isModerator = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isHost && !isModerator) return res.status(403).json({ success: false, error: 'Sadece host/mod reddedebilir.' });
    const stage = getRoomStage(roomName);
    const before = stage.queue.length;
    stage.queue = stage.queue.filter(q => q.identity.toLowerCase() !== identity.toLowerCase());
    if (stage.queue.length === before) return res.status(404).json({ success: false, error: 'Bu kullanıcı kuyrukta değil.' });
    _persistStages();
    console.log(`[STAGE] ${req.user.nick} kuyruktan reddetti: ${identity} @ ${roomName}`);
    res.json({ success: true });
});

// POST /api/room/:name/cancel-hand
router.post('/room/:name/cancel-hand', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const stage = getRoomStage(roomName);
    const me = req.user.nick;
    const idx = stage.queue.findIndex(q => q.identity.toLowerCase() === me.toLowerCase());
    if (idx < 0) return res.status(404).json({ success: false, error: 'Kuyrukta değilsin.' });
    stage.queue.splice(idx, 1);
    _persistStages();
    res.json({ success: true });
});

// POST /api/room/:name/grant-stage
router.post('/room/:name/grant-stage', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity, type } = req.body;
    if (!identity) return res.status(400).json({ success: false, error: 'identity gerekli' });
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isHost = isRoomHost(def, req.user.nick);
    const isModerator = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isHost && !isModerator) return res.status(403).json({ success: false, error: 'Sadece host/mod sahneye alabilir.' });
    const stage = getRoomStage(roomName);
    if (speakerCount(stage) >= ((def.max_speakers ?? 6))) {
        return res.status(429).json({ success: false, error: `Sahne dolu (${def.max_speakers} kişi limit).` });
    }
    if (stage.speakers[identity]) return res.status(409).json({ success: false, error: 'Bu kullanıcı zaten sahnede.' });
    try {
        await grantStageInternal(roomName, identity, type || 'mic');
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Sahneye alınamadı: ' + e.message });
    }
    const users = await db.loadUsers();
    const target = users.find(u => u.nick.toLowerCase() === identity.toLowerCase());
    if (target) {
        await pushNotification(target.id, 'system', {
            title: '🎤 Sahneye alındın',
            body: `"${roomName}" odasında ${req.user.nick} seni sahneye aldı — mikrofonun açık.`,
            link: '/oda?room=' + encodeURIComponent(roomName) + '&nick=' + encodeURIComponent(identity),
            from: req.user.nick,
        });
    }
    res.json({ success: true, speakers: speakerCount(stage), max: def.max_speakers });
});

// POST /api/room/:name/revoke-stage
router.post('/room/:name/revoke-stage', stageLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    const target = identity || req.user.nick;
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isSelf = target.toLowerCase() === req.user.nick.toLowerCase();
    const isHost = isRoomHost(def, req.user.nick);
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

    const stage = getRoomStage(roomName);
    if (def.auto_stage !== false && stage.queue.length > 0 && speakerCount(stage) < ((def.max_speakers ?? 6))) {
        const modPresent = await hasModInRoom(roomName);
        if (!modPresent) {
            const next = stage.queue[0];
            try { await grantStageInternal(roomName, next.identity, 'mic'); } catch {}
        }
    }
    res.json({ success: true });
});

// POST /api/room/:name/cam-grant
router.post('/room/:name/cam-grant', camLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const me = req.user.nick;
    const stage = getRoomStage(roomName);
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    const isHost = isRoomHost(def, me);
    const maxCams = def.max_cameras ?? 0;
    if (maxCams === 0) return res.status(403).json({ success: false, error: 'Bu oda kamerasız ayarlanmış.' });
    const cp = def.cam_policy || 'speakers_only';
    if (cp === 'mod_only' && !isStaff && !isHost) return res.status(403).json({ success: false, error: 'Bu odada kamera sadece host/mod için.' });
    if (cp === 'speakers_only' && !stage.speakers[me]) return res.status(403).json({ success: false, error: 'Önce sahneye çık (söz iste), sonra kamera aç.' });
    const camCount = cameraCount(stage);
    const already = stage.speakers[me] && (stage.speakers[me].type === 'cam' || stage.speakers[me].type === 'both');
    if (!already && camCount >= maxCams) return res.status(429).json({ success: false, error: `Kamera dolu (${maxCams} kişi limit).` });
    if (!stage.speakers[me]) {
        stage.speakers[me] = { ts: Date.now(), lastSpeakTs: Date.now(), type: 'cam' };
    } else {
        stage.speakers[me].type = 'both';
    }
    const newType = stage.speakers[me].type;
    const sources = newType === 'cam' ? ['camera'] : ['microphone', 'camera'];
    try {
        await updateLiveKitPermission(roomName, me, { canPublish: true, sources });
    } catch (e) {
        if (newType === 'cam') delete stage.speakers[me];
        else stage.speakers[me].type = 'mic';
        return res.status(500).json({ success: false, error: 'Kamera izni LiveKit\'e iletilemedi: ' + e.message });
    }
    _persistStages();
    console.log(`[CAM] ${me} kamera açtı: ${roomName} (${cameraCount(stage)}/${maxCams}, type=${newType})`);
    res.json({ success: true, cameras: cameraCount(stage), max: maxCams });
});

// POST /api/room/:name/cam-revoke
router.post('/room/:name/cam-revoke', camLimiter, requireAuth, async (req, res) => {
    const roomName = decodeURIComponent(req.params.name);
    const { identity } = req.body;
    const target = identity || req.user.nick;
    const def = await findRoomDef(roomName);
    if (!def) return res.status(404).json({ success: false, error: 'Oda yok' });
    const isSelf = target.toLowerCase() === req.user.nick.toLowerCase();
    const isHost = isRoomHost(def, req.user.nick);
    const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
    if (!isSelf && !isHost && !isStaff) return res.status(403).json({ success: false, error: 'Sadece kendini ya da host/mod başkasının kamerasını kapatabilir.' });
    const stage = getRoomStage(roomName);
    const sp = stage.speakers[target];
    if (!sp || (sp.type !== 'cam' && sp.type !== 'both')) return res.json({ success: true, noop: true });
    const prevType = sp.type;
    if (sp.type === 'cam') {
        delete stage.speakers[target];
        _persistStages();
        try {
            await updateLiveKitPermission(roomName, target, { canPublish: false, sources: [] });
        } catch (e) {
            stage.speakers[target] = { ...sp, type: prevType };
            return res.status(500).json({ success: false, error: 'Kamera kapatma LiveKit\'e iletilemedi: ' + e.message });
        }
    } else {
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

// GET /api/token & GET /getToken
router.get('/getToken', (req, res) => res.redirect(307, '/api/token?' + new URLSearchParams(req.query).toString()));
router.get('/token', async (req, res) => {
    const { room, ac } = req.query;
    if (!room) return res.status(400).json({ success: false, error: 'Eksik parametre: room gerekli' });

    // JWT verification
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Oturum yok — önce giriş yap.' });
    }
    let identity, userRole, decoded;
    try {
        decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        identity = decoded.nick;
        userRole = decoded.role || 'user';
    } catch {
        return res.status(401).json({ success: false, error: 'Oturum geçersiz — tekrar giriş yap.' });
    }
    if (!identity) return res.status(401).json({ success: false, error: 'JWT içinde nick yok.' });

    // Ban checks
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

    // Host-kick checks
    {
        const ban = isRoomBanned(room, identity);
        const userRoomDef = (await db.loadUserRooms()).find(r => r.name === room);
        const isStaffOrHost = userRole === 'admin' || userRole === 'mod' || (userRoomDef && isRoomHost(userRoomDef, identity));
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

    // Room locks
    try {
        const locks = await db.loadLocks();
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

    // 18+ age checks
    try {
        const userRoom = (await db.loadUserRooms()).find(r => r.name === room);
        if (userRoom?.is_18_plus) {
            const u = (await db.loadUsers()).find(u => u.nick.toLowerCase() === identity.toLowerCase());
            if (!isAdult(u?.birthYear)) {
                return res.status(403).json({
                    error: 'Bu oda +18 — yaş doğrulamak için profil ayarlarından doğum yılını gir veya 18 yaşından küçüksen giremezsin.',
                    access: 'adult_only',
                });
            }
        }
    } catch (e) { console.error('[GET_TOKEN] +18 yaş kontrolü hatası:', e); }

    // Custom room access restrictions
    try {
        const userRoom = (await db.loadUserRooms()).find(r => r.name === room);
        if (userRoom && userRoom.access && userRoom.access !== 'public') {
            const isHost = isRoomHost(userRoom, identity);
            const isAdminOrMod = userRole === 'admin' || userRole === 'mod';
            if (!isHost && !isAdminOrMod) {
                if (userRoom.access === 'password') {
                    if (!ac) return res.status(403).json({ success: false, error: 'Şifreli oda — önce şifreyi gir.', access: 'password' });
                    try {
                        const decodedAc = jwt.verify(ac, JWT_SECRET);
                        if (decodedAc.kind !== 'room-access' || decodedAc.room !== room || decodedAc.nick.toLowerCase() !== identity.toLowerCase()) {
                            return res.status(403).json({ success: false, error: 'Erişim tokenı geçersiz.', access: 'password' });
                        }
                    } catch {
                        return res.status(403).json({ success: false, error: 'Erişim tokenı süresi dolmuş — şifreyi tekrar gir.', access: 'password' });
                    }
                } else if (userRoom.access === 'invite') {
                    const allowed = (userRoom.invitedNicks || []).some(n => n.toLowerCase() === identity.toLowerCase());
                    if (!allowed) return res.status(403).json({ success: false, error: 'Bu odaya davetli değilsin.', access: 'invite' });
                } else if (userRoom.access === 'friends') {
                    const hostFriends = (await getFriendsOf(userRoom.hostId)).map(n => n.toLowerCase());
                    if (!hostFriends.includes(identity.toLowerCase())) return res.status(403).json({ success: false, error: 'Sadece host\'un arkadaşları girebilir.', access: 'friends' });
                }
            }
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Erişim kontrolü yapılamadı.' });
    }

    try { pushActivity(`${identity} → ${room} odasına katıldı`, '🚪'); } catch {}

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) return res.status(500).json({ success: false, error: 'LiveKit API bilgileri .env dosyasında tanımlı değil' });

    let canPublish = false;
    let stageEntryReason = 'dinleyici';
    try {
        const roomDef = await findRoomDef(room);
        const policy = roomDef?.mic_policy || 'request';
        const isHostOfRoom = roomDef ? isRoomHost(roomDef, identity) : false;
        const isStaffRole = userRole === 'admin' || userRole === 'mod';
        if (policy === 'open') {
            canPublish = true;
            stageEntryReason = 'open_policy';
        } else if (isHostOfRoom || isStaffRole) {
            canPublish = true;
            stageEntryReason = isHostOfRoom ? 'host' : 'mod_role';
        }
        if (canPublish && roomDef) {
            const stage = getRoomStage(room);
            if (!stage.speakers[identity]) {
                stage.speakers[identity] = { ts: Date.now(), lastSpeakTs: Date.now(), type: 'mic' };
                _persistStages();
            }
        }
    } catch {}

    try {
        const u = (await db.loadUsers()).find(usr => usr.nick.toLowerCase() === identity.toLowerCase());
        const userAvatarPhoto = u && u.avatarPhoto ? `/assets/avatars/${u.avatarPhoto}` : '';
        const userAvatar = u ? (u.avatar || 'default') : 'default';

        const token = new (require('livekit-server-sdk').AccessToken)(apiKey, apiSecret, {
            identity, name: identity, ttl: '2h',
            metadata: JSON.stringify({ avatarPhoto: userAvatarPhoto, avatar: userAvatar, role: userRole, googleLinked: u && !!u.google_sub })
        });
        token.addGrant({
            roomJoin: true, room,
            canPublish,
            canPublishSources: canPublish ? toTrackSources(['microphone']) : [],
            canSubscribe: true,
            canPublishData: true,
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
        res.status(500).json({ success: false, error: 'Token oluşturulamadı: ' + err.message });
    }
});

// ============ ADMIN / MODERATOR ROOM LOGIC ============
router.get('/admin/rooms', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    res.json({ success: true, rooms: ROOM_DEFS });
});

router.post('/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const { name, max, icon, category, badge, desc } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'Oda adı gerekli' });
    const exists = ROOM_DEFS.find(r => r.name.toLowerCase() === name.toLowerCase())
                  || (await db.loadUserRooms()).find(r => r.name.toLowerCase() === name.toLowerCase());
    if (exists) return res.status(409).json({ success: false, error: 'Bu isimde oda zaten var' });
    const newRoom = applyPreset({
        name,
        max: parseInt(max) || 50,
        icon: icon || '🚪',
        category: category || 'free',
        badge: badge || null,
        desc: desc || '',
        host: 'RetroBot',
        createdAt: new Date().toISOString(),
    });
    ROOM_DEFS.push(newRoom);
    await db.saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    console.log(`[ADMIN-ROOM] Yeni sistem odası oluşturuldu: ${name} (by ${req.user.nick})`);
    res.json({ success: true, room: newRoom });
});

router.put('/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const { oldName, name, max, icon, category, badge, desc, settings } = req.body || {};
    const idx = ROOM_DEFS.findIndex(r => r.name === oldName);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Sistem odası bulunamadı' });
    const target = ROOM_DEFS[idx];
    if (name) target.name = name;
    if (max) target.max = parseInt(max);
    if (icon) target.icon = icon;
    if (category) target.category = category;
    if (badge !== undefined) target.badge = badge;
    if (desc !== undefined) target.desc = desc;
    if (settings) {
        if (settings.max_speakers !== undefined) target.max_speakers = settings.max_speakers;
        if (settings.max_cameras !== undefined) target.max_cameras = settings.max_cameras;
        if (settings.mic_policy) target.mic_policy = settings.mic_policy;
        if (settings.cam_policy) target.cam_policy = settings.cam_policy;
    }
    await db.saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    res.json({ success: true, room: target });
});

router.delete('/admin/rooms', requireAuth, requireRole('admin'), async (req, res) => {
    const { name } = req.body || {};
    const idx = ROOM_DEFS.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Sistem odası bulunamadı' });
    ROOM_DEFS.splice(idx, 1);
    await db.saveSystemRooms(ROOM_DEFS);
    roomCache.ts = 0;
    const svc = getRoomServiceClient();
    if (svc) { svc.deleteRoom(name).catch(() => {}); }
    console.log(`[ADMIN-ROOM] Sistem odası silindi: ${name} (by ${req.user.nick})`);
    res.json({ success: true });
});

router.post('/kick', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room, identity, reason } = req.body || {};
    if (!room || !identity) return res.status(400).json({ success: false, error: 'room ve identity gerekli' });
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    try {
        const stage = getRoomStage(room);
        if (stage.speakers[identity]) {
            delete stage.speakers[identity];
            _persistStages();
            try { await updateLiveKitPermission(room, identity, false); } catch {}
        }
        await svc.removeParticipant(room, identity);
        addRoomBan(room, identity, req.user.nick, `[KICK] ${reason || 'Yönetici kararı'}`);
        pushModLog({ action: 'admin-kick', room, by: req.user.nick, target: identity, reason });
        console.log(`[KICK] ${identity}@${room} (by ${req.user.nick}, reason: ${reason || '-'})`);
        broadcastModBot(room, `🚪 @${identity} odadan uzaklaştırıldı.`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/mute', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room, identity, trackSid, mute } = req.body || {};
    if (!room || !identity || !trackSid) return res.status(400).json({ success: false, error: 'room, identity ve trackSid gerekli' });
    const svc = getRoomServiceClient();
    if (!svc) return res.status(500).json({ success: false, error: 'LiveKit bağlantısı yok' });
    try {
        await svc.mutePublishedTrack(room, identity, trackSid, !!mute);
        pushModLog({ action: mute ? 'admin-mute' : 'admin-unmute', room, by: req.user.nick, target: identity, details: { trackSid } });
        console.log(`[MUTE] ${identity}@${room} track ${trackSid} -> ${mute} (by ${req.user.nick})`);
        broadcastModBot(room, mute ? `🔇 @${identity} mikrofonu kapatıldı.` : `🎙️ @${identity} mikrofon kilidi açıldı.`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: user rooms list
router.get('/admin/user-rooms', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const rooms = (await db.loadUserRooms()).map(({ passwordHash, ...r }) => r);
    res.json({ success: true, rooms });
});

// Admin: delete user room
router.delete('/admin/user-rooms/:name', requireAuth, requireRole('admin'), async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const rooms = await db.loadUserRooms();
    const idx = rooms.findIndex(r => r.name === name);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Oda bulunamadı' });
    const room = rooms[idx];
    rooms.splice(idx, 1);
    await db.saveUserRooms(rooms);
    roomCache.ts = 0;
    const svc = getRoomServiceClient();
    if (svc) { svc.deleteRoom(name).catch(() => {}); }
    console.log(`[ADMIN] Üye odası zorla silindi: ${name} (host: ${room.host}, by ${req.user.nick})`);
    pushModLog({ action: 'admin-room-delete', room: name, by: req.user.nick, target: room.host || null, details: { type: 'user-room' } });
    res.json({ success: true });
});

// Admin: room participants list
router.get('/admin/room/:name/participants', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
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

// ============ LOBBY CHAT ROUTES ============
router.get('/lobby-chat', (req, res) => {
    res.json({ success: true, messages: lobbyChat });
});

router.post('/lobby-chat', requireAuth, async (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Mesaj boş' });
    if (req.user.role === 'guest') return res.status(403).json({ success: false, error: 'Misafirler lobi sohbetine yazamaz. Kayıt ol!' });
    const trimmed = message.trim().slice(0, 200);
    const now = Date.now();
    const recent = lobbyChat.filter(m => m.userId === req.user.id && now - m.ts < 3000);
    if (recent.length > 0) return res.status(429).json({ success: false, error: 'Çok hızlı yazıyorsun, biraz bekle' });
    const banned = await isUserBanned(req.user.nick);
    if (banned) return res.status(403).json({ success: false, error: 'Yasaklı kullanıcılar yazamaz' });
    const msg = {
        id: now + '_' + Math.random().toString(36).slice(2, 6),
        nick: req.user.nick,
        role: req.user.role,
        userId: req.user.id,
        avatar: null,
        text: trimmed,
        ts: now
    };
    try {
        const users = await db.loadUsers();
        const u = users.find(x => x.id === req.user.id);
        if (u) {
            msg.avatar = u.avatar || null;
            msg.avatarPhoto = u.avatarPhoto ? `/assets/avatars/${u.avatarPhoto}` : null;
        }
    } catch {}
    lobbyChat.push(msg);
    if (lobbyChat.length > LOBBY_CHAT_MAX) lobbyChat.shift();
    pushActivity(`${req.user.nick} lobide yazdı: "${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}"`, '💬');
    res.json({ success: true, message: msg });
});

// GET /api/activity
router.get('/activity', async (req, res) => {
    res.json({ success: true, items: require('../services/shared').ACTIVITY_FEED });
});

// GET /api/discover
router.get('/discover', async (req, res) => {
    try {
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

        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const users = await db.loadUsers();
        const newUsers = users
            .filter(u => u.createdAt && new Date(u.createdAt).getTime() > dayAgo)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10)
            .map(u => ({
                nick: u.nick,
                createdAt: u.createdAt,
                avatar: u.avatar || null,
                avatarPhoto: u.avatarPhoto ? `/assets/avatars/${u.avatarPhoto}` : null,
                bio: (u.bio || '').slice(0, 60),
            }));

        const userRooms = await db.loadUserRooms();
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

// POST /api/chat/moderate
router.post('/chat/moderate', require('../services/shared').chatModerateLimiter, requireAuth, async (req, res) => {
    const { room, text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'text gerekli' });
    const nick = req.user.nick;
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
    const roomDef = room ? await findRoomDef(room) : null;
    const aiLevel = roomDef?.ai_level || 'standard';
    const result = await Moderation.moderateMessage({ nick, text, room, aiLevel });

    const BLOCK_ACTIONS = new Set(['silenced', 'warn', 'final_warn', 'mute_5m', 'mute_15m', 'mute_1h', 'kick', 'ban_24h', 'ban_perm']);
    const blocked = !result.safe && BLOCK_ACTIONS.has(result.action);
    console.log(`[MOD] nick=${nick}, safe=${result.safe}, action=${result.action}, blocked=${blocked}`);

    if (!result.safe) {
        switch (result.action) {
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

// POST /api/report-user
router.post('/report-user', require('../services/shared').reportLimiter, requireAuth, async (req, res) => {
    const reporter = req.user.nick;
    const { reported, room, reason, audio, audioMime, image, imageMime } = req.body;
    if (!reported || typeof reported !== 'string') return res.status(400).json({ success: false, error: 'reported (kullanıcı nick) gerekli.' });
    if (reported.toLowerCase() === reporter.toLowerCase()) return res.status(400).json({ success: false, error: 'Kendini bildiremezsin.' });
    if (!audio && !image) return res.status(400).json({ success: false, error: 'Ses veya görüntü kanıtı gerekli.' });
    const rl = checkReportRate(reporter, reported);
    if (!rl.ok) return res.status(429).json({ success: false, error: rl.reason });
    const audioSize = audio ? audio.length : 0;
    const imageSize = image ? image.length : 0;
    if (audioSize > 1500000 || imageSize > 1000000) return res.status(413).json({ success: false, error: 'Kanıt boyutu çok büyük.' });

    console.log(`[REPORT] ${reporter} → ${reported} (sebep: ${reason || 'belirtilmedi'}, ses:${audioSize}B, görsel:${imageSize}B)`);

    const aiResult = await Moderation.analyzeReport({
        audioB64: audio || null,
        audioMime: audioMime || 'audio/webm',
        imageB64: image || null,
        imageMime: imageMime || 'image/jpeg',
        reporter, reported, reason,
    });

    _reportLog.unshift({
        ts: new Date().toISOString(),
        reporter, reported, room, reason,
        ai: aiResult ? { action: aiResult.action, severity: aiResult.severity, reason: aiResult.reason, category: aiResult.category, transcript: aiResult.transcript } : null,
    });
    if (_reportLog.length > 100) _reportLog.length = 100;
    _persistReportLog();

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

// Admin: son raporlar listesi
router.get('/admin/reports', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    res.json({ success: true, reports: _reportLog });
});

// Admin: rapor sil
router.delete('/admin/reports/:index', requireAuth, requireRole('admin'), async (req, res) => {
    const i = parseInt(req.params.index);
    if (isNaN(i) || i < 0 || i >= _reportLog.length) return res.status(404).json({ success: false, error: 'Rapor yok' });
    _reportLog.splice(i, 1);
    _persistReportLog();
    res.json({ success: true });
});

// Admin: oda kilitle
router.post('/admin/room/lock', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'Oda adı gerekli' });

    try {
        const locks = await db.loadLocks();
        locks[room] = { lockedBy: req.user.nick, lockedAt: new Date().toISOString() };
        await db.saveLocks(locks);

        pushModLog({ action: 'admin-lock', room, by: req.user.nick });
        broadcastModBot(room, `🔒 Bu oda yöneticiler tarafından geçici olarak kilitlendi.`);

        res.json({ success: true, message: `"${room}" odası başarıyla kilitlendi.` });
    } catch (err) {
        console.error('[API] /api/admin/room/lock error:', err);
        res.status(500).json({ success: false, error: 'Oda kilitlenemedi' });
    }
});

// Admin: oda kilidini kaldır
router.post('/admin/room/unlock', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    const { room } = req.body;
    if (!room) return res.status(400).json({ success: false, error: 'Oda adı gerekli' });

    try {
        const locks = await db.loadLocks();
        if (locks[room]) {
            delete locks[room];
            await db.saveLocks(locks);
            pushModLog({ action: 'admin-unlock', room, by: req.user.nick });
            broadcastModBot(room, `🔓 Oda kilidi kaldırıldı.`);
            res.json({ success: true, message: `"${room}" odasının kilidi kaldırıldı.` });
        } else {
            res.json({ success: true, message: `Oda zaten kilitli değil.` });
        }
    } catch (err) {
        console.error('[API] /api/admin/room/unlock error:', err);
        res.status(500).json({ success: false, error: 'Oda kilidi kaldırılamadı' });
    }
});

// Admin: moderasyon logları listesi
router.get('/admin/mod-log', requireAuth, requireRole('admin', 'mod'), async (req, res) => {
    try {
        const { room, action, limit } = req.query;
        const allLogs = await db.loadModLog();
        const total = allLogs.length;

        // Apply filters
        let filtered = allLogs;
        if (room) {
            filtered = filtered.filter(l => l.room && l.room.toLowerCase().includes(room.toLowerCase()));
        }
        if (action) {
            filtered = filtered.filter(l => l.action && l.action === action);
        }

        const filteredCount = filtered.length;
        const limitNum = parseInt(limit) || 300;
        const sliced = filtered.slice(0, limitNum);

        res.json({
            success: true,
            items: sliced,
            total,
            filtered: filteredCount
        });
    } catch (err) {
        console.error('[API] /api/admin/mod-log error:', err);
        res.status(500).json({ success: false, error: 'Moderasyon kayıtları alınamadı' });
    }
});

module.exports = {
    router,
    fetchRoomData
};
