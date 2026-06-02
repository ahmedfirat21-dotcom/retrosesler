const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, 'retrosesler.db');
const db = new Database(DB_FILE);

// Pragmas for performance and concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ============ TABLE SCHEMAS ============
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nick TEXT UNIQUE,
    password TEXT,
    role TEXT,
    birthYear INTEGER,
    email TEXT,
    google_sub TEXT,
    display_name TEXT,
    createdAt TEXT,
    invited_by TEXT,
    invite_code TEXT,
    avatar TEXT,
    avatarPhoto TEXT,
    bio TEXT,
    status TEXT,
    personal_msg TEXT,
    about TEXT,
    city TEXT,
    musicTaste TEXT,
    instagram TEXT,
    twitter TEXT,
    tiktok TEXT,
    youtube TEXT,
    discord TEXT,
    profileTheme TEXT,
    profileMusic TEXT,
    profileMusicName TEXT,
    moodEmoji TEXT,
    moodText TEXT,
    sessionId TEXT,
    privacy TEXT
);

CREATE TABLE IF NOT EXISTS user_rooms (
    name TEXT PRIMARY KEY,
    host TEXT,
    category TEXT,
    max INTEGER,
    password TEXT,
    desc TEXT,
    icon TEXT,
    badge TEXT,
    theme TEXT,
    coHosts TEXT,
    mic_policy TEXT,
    cam_policy TEXT,
    max_speakers INTEGER,
    max_cameras INTEGER,
    auto_stage INTEGER,
    speaker_time_limit INTEGER,
    silence_kick_seconds INTEGER,
    ai_level TEXT,
    cam_mode TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS system_rooms (
    name TEXT PRIMARY KEY,
    host TEXT,
    category TEXT,
    max INTEGER,
    password TEXT,
    desc TEXT,
    icon TEXT,
    badge TEXT,
    theme TEXT,
    coHosts TEXT,
    mic_policy TEXT,
    cam_policy TEXT,
    max_speakers INTEGER,
    max_cameras INTEGER,
    auto_stage INTEGER,
    speaker_time_limit INTEGER,
    silence_kick_seconds INTEGER,
    ai_level TEXT,
    cam_mode TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS dms (
    id TEXT PRIMARY KEY,
    from_nick TEXT,
    to_nick TEXT,
    body TEXT,
    ts INTEGER,
    read INTEGER
);

CREATE TABLE IF NOT EXISTS friends (
    user1 TEXT,
    user2 TEXT,
    PRIMARY KEY (user1, user2)
);

CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_nick TEXT,
    to_nick TEXT,
    ts INTEGER
);

CREATE TABLE IF NOT EXISTS blocks (
    user TEXT,
    blocked_user TEXT,
    PRIMARY KEY (user, blocked_user)
);

CREATE TABLE IF NOT EXISTS locks (
    room_name TEXT PRIMARY KEY,
    is_locked INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT,
    type TEXT,
    title TEXT,
    body TEXT,
    link TEXT,
    fromNick TEXT,
    ts INTEGER,
    read INTEGER
);

CREATE TABLE IF NOT EXISTS resets (
    email TEXT PRIMARY KEY,
    code TEXT,
    expires INTEGER
);

CREATE TABLE IF NOT EXISTS guestbook (
    id TEXT PRIMARY KEY,
    profile_nick TEXT,
    author TEXT,
    body TEXT,
    ts INTEGER
);

CREATE TABLE IF NOT EXISTS global_bans (
    nick TEXT PRIMARY KEY,
    reason TEXT,
    by_nick TEXT,
    createdAt TEXT,
    expiresAt TEXT
);

CREATE TABLE IF NOT EXISTS dead_yt_ids (
    ytId TEXT PRIMARY KEY,
    addedBy TEXT,
    ts INTEGER
);

CREATE TABLE IF NOT EXISTS mod_log (
    id TEXT PRIMARY KEY,
    ts INTEGER,
    action TEXT,
    room TEXT,
    by_nick TEXT,
    target TEXT,
    reason TEXT,
    details TEXT
);

CREATE TABLE IF NOT EXISTS room_bans (
    roomName TEXT,
    nick TEXT,
    ts INTEGER,
    by_nick TEXT,
    reason TEXT,
    PRIMARY KEY (roomName, nick)
);

CREATE TABLE IF NOT EXISTS room_stages (
    roomName TEXT PRIMARY KEY,
    stageData TEXT
);

CREATE TABLE IF NOT EXISTS timeline_memories (
    id TEXT PRIMARY KEY,
    year INTEGER,
    nick TEXT,
    body TEXT,
    reactions TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS timeline_summaries (
    year INTEGER PRIMARY KEY,
    summary TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS timeline_details (
    query TEXT PRIMARY KEY,
    details TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS timeline_history20 (
    date_str TEXT PRIMARY KEY,
    data TEXT,
    createdAt TEXT
);

DROP TABLE IF EXISTS okey_tables;
DROP TABLE IF EXISTS okey_games;
`);

// ============ AUTO MIGRATION LOGIC ============
const migrateJsonToDb = () => {
    try {
        db.transaction(() => {
            // Helper checking if table is empty
            const isEmpty = (table) => {
                const row = db.prepare(`SELECT count(*) as count FROM ${table}`).get();
                return row.count === 0;
            };

            // 1) Users
            const usersFile = path.join(DATA_DIR, 'users.json');
            if (isEmpty('users') && fs.existsSync(usersFile)) {
                console.log('[DB-MIGRATE] Migrating users.json...');
                const data = JSON.parse(fs.readFileSync(usersFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO users (id, nick, password, role, birthYear, email, google_sub, display_name, createdAt, invited_by, invite_code, avatar, avatarPhoto, bio, status, personal_msg, about, city, musicTaste, instagram, twitter, tiktok, youtube, discord, profileTheme, profileMusic, profileMusicName, moodEmoji, moodText, sessionId, privacy)
                    VALUES (@id, @nick, @password, @role, @birthYear, @email, @google_sub, @display_name, @createdAt, @invited_by, @invite_code, @avatar, @avatarPhoto, @bio, @status, @personal_msg, @about, @city, @musicTaste, @instagram, @twitter, @tiktok, @youtube, @discord, @profileTheme, @profileMusic, @profileMusicName, @moodEmoji, @moodText, @sessionId, @privacy)
                `);
                for (const u of data) {
                    stmt.run({
                        id: u.id,
                        nick: u.nick,
                        password: u.password || null,
                        role: u.role || 'user',
                        birthYear: u.birthYear || null,
                        email: u.email || null,
                        google_sub: u.google_sub || null,
                        display_name: u.display_name || null,
                        createdAt: u.createdAt || null,
                        invited_by: u.invited_by || null,
                        invite_code: u.invite_code || null,
                        avatar: u.avatar || 'default',
                        avatarPhoto: u.avatarPhoto || null,
                        bio: u.bio || null,
                        status: u.status || 'online',
                        personal_msg: u.personal_msg || null,
                        about: u.about || null,
                        city: u.city || null,
                        musicTaste: u.musicTaste || null,
                        instagram: u.instagram || null,
                        twitter: u.twitter || null,
                        tiktok: u.tiktok || null,
                        youtube: u.youtube || null,
                        discord: u.discord || null,
                        profileTheme: u.profileTheme || 'default',
                        profileMusic: u.profileMusic || null,
                        profileMusicName: u.profileMusicName || null,
                        moodEmoji: u.moodEmoji || null,
                        moodText: u.moodText || null,
                        sessionId: u.sessionId || null,
                        privacy: u.privacy ? JSON.stringify(u.privacy) : null
                    });
                }
            }

            // 2) User Rooms
            const userRoomsFile = path.join(DATA_DIR, 'user_rooms.json');
            if (isEmpty('user_rooms') && fs.existsSync(userRoomsFile)) {
                console.log('[DB-MIGRATE] Migrating user_rooms.json...');
                const data = JSON.parse(fs.readFileSync(userRoomsFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO user_rooms (name, host, category, max, password, desc, icon, badge, theme, coHosts, mic_policy, cam_policy, max_speakers, max_cameras, auto_stage, speaker_time_limit, silence_kick_seconds, ai_level, cam_mode, createdAt)
                    VALUES (@name, @host, @category, @max, @password, @desc, @icon, @badge, @theme, @coHosts, @mic_policy, @cam_policy, @max_speakers, @max_cameras, @auto_stage, @speaker_time_limit, @silence_kick_seconds, @ai_level, @cam_mode, @createdAt)
                `);
                for (const r of data) {
                    stmt.run({
                        name: r.name,
                        host: r.host || null,
                        category: r.category || 'free',
                        max: r.max || 10,
                        password: r.password || null,
                        desc: r.desc || '',
                        icon: r.icon || '💬',
                        badge: r.badge || null,
                        theme: r.theme || 'classic',
                        coHosts: r.coHosts ? JSON.stringify(r.coHosts) : '[]',
                        mic_policy: r.mic_policy || 'open',
                        cam_policy: r.cam_policy || 'speakers_only',
                        max_speakers: r.max_speakers !== undefined ? r.max_speakers : 6,
                        max_cameras: r.max_cameras !== undefined ? r.max_cameras : 3,
                        auto_stage: r.auto_stage === false ? 0 : 1,
                        speaker_time_limit: r.speaker_time_limit || 0,
                        silence_kick_seconds: r.silence_kick_seconds || 0,
                        ai_level: r.ai_level || 'standard',
                        cam_mode: r.cam_mode || 'camera',
                        createdAt: r.createdAt || new Date().toISOString()
                    });
                }
            }

            // 3) System Rooms
            const sysRoomsFile = path.join(DATA_DIR, 'system_rooms.json');
            if (isEmpty('system_rooms') && fs.existsSync(sysRoomsFile)) {
                console.log('[DB-MIGRATE] Migrating system_rooms.json...');
                const data = JSON.parse(fs.readFileSync(sysRoomsFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO system_rooms (name, host, category, max, password, desc, icon, badge, theme, coHosts, mic_policy, cam_policy, max_speakers, max_cameras, auto_stage, speaker_time_limit, silence_kick_seconds, ai_level, cam_mode, createdAt)
                    VALUES (@name, @host, @category, @max, @password, @desc, @icon, @badge, @theme, @coHosts, @mic_policy, @cam_policy, @max_speakers, @max_cameras, @auto_stage, @speaker_time_limit, @silence_kick_seconds, @ai_level, @cam_mode, @createdAt)
                `);
                for (const r of data) {
                    stmt.run({
                        name: r.name,
                        host: r.host || null,
                        category: r.category || 'free',
                        max: r.max || 10,
                        password: r.password || null,
                        desc: r.desc || '',
                        icon: r.icon || '💬',
                        badge: r.badge || null,
                        theme: r.theme || 'classic',
                        coHosts: r.coHosts ? JSON.stringify(r.coHosts) : '[]',
                        mic_policy: r.mic_policy || 'open',
                        cam_policy: r.cam_policy || 'speakers_only',
                        max_speakers: r.max_speakers !== undefined ? r.max_speakers : 6,
                        max_cameras: r.max_cameras !== undefined ? r.max_cameras : 3,
                        auto_stage: r.auto_stage === false ? 0 : 1,
                        speaker_time_limit: r.speaker_time_limit || 0,
                        silence_kick_seconds: r.silence_kick_seconds || 0,
                        ai_level: r.ai_level || 'standard',
                        cam_mode: r.cam_mode || 'camera',
                        createdAt: r.createdAt || new Date().toISOString()
                    });
                }
            }

            // 4) DMs
            const dmsFile = path.join(DATA_DIR, 'dms.json');
            if (isEmpty('dms') && fs.existsSync(dmsFile)) {
                console.log('[DB-MIGRATE] Migrating dms.json...');
                const data = JSON.parse(fs.readFileSync(dmsFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO dms (id, from_nick, to_nick, body, ts, read)
                    VALUES (@id, @from_nick, @to_nick, @body, @ts, @read)
                `);
                for (const d of data) {
                    stmt.run({
                        id: d.id,
                        from_nick: d.from,
                        to_nick: d.to,
                        body: d.body,
                        ts: d.ts,
                        read: d.read ? 1 : 0
                    });
                }
            }

            // 5) Friends
            const friendsFile = path.join(DATA_DIR, 'friends.json');
            if (isEmpty('friends') && fs.existsSync(friendsFile)) {
                console.log('[DB-MIGRATE] Migrating friends.json...');
                const data = JSON.parse(fs.readFileSync(friendsFile, 'utf8')) || {};
                const stmt = db.prepare(`INSERT OR IGNORE INTO friends (user1, user2) VALUES (?, ?)`);
                for (const [userId, list] of Object.entries(data)) {
                    if (Array.isArray(list)) {
                        for (const peerNick of list) {
                            stmt.run(userId, peerNick);
                        }
                    }
                }
            }

            // 6) Blocks
            const blocksFile = path.join(DATA_DIR, 'blocks.json');
            if (isEmpty('blocks') && fs.existsSync(blocksFile)) {
                console.log('[DB-MIGRATE] Migrating blocks.json...');
                const data = JSON.parse(fs.readFileSync(blocksFile, 'utf8')) || {};
                const stmt = db.prepare(`INSERT OR IGNORE INTO blocks (user, blocked_user) VALUES (?, ?)`);
                for (const [userId, list] of Object.entries(data)) {
                    if (Array.isArray(list)) {
                        for (const peer of list) {
                            stmt.run(userId, peer);
                        }
                    }
                }
            }

            // 7) Friend Requests
            const frFile = path.join(DATA_DIR, 'friend_requests.json');
            if (isEmpty('friend_requests') && fs.existsSync(frFile)) {
                console.log('[DB-MIGRATE] Migrating friend_requests.json...');
                const data = JSON.parse(fs.readFileSync(frFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO friend_requests (id, from_nick, to_nick, ts)
                    VALUES (?, ?, ?, ?)
                `);
                for (const r of data) {
                    stmt.run(r.id, r.fromNick, r.toNick, r.ts);
                }
            }

            // 8) Locks
            const locksFile = path.join(DATA_DIR, 'locks.json');
            if (isEmpty('locks') && fs.existsSync(locksFile)) {
                console.log('[DB-MIGRATE] Migrating locks.json...');
                const data = JSON.parse(fs.readFileSync(locksFile, 'utf8')) || {};
                const stmt = db.prepare(`INSERT OR REPLACE INTO locks (room_name, is_locked) VALUES (?, ?)`);
                for (const [roomName, val] of Object.entries(data)) {
                    stmt.run(roomName, val ? 1 : 0);
                }
            }

            // 9) Notifications
            const notifFile = path.join(DATA_DIR, 'notifications.json');
            if (isEmpty('notifications') && fs.existsSync(notifFile)) {
                console.log('[DB-MIGRATE] Migrating notifications.json...');
                const data = JSON.parse(fs.readFileSync(notifFile, 'utf8')) || {};
                const stmt = db.prepare(`
                    INSERT INTO notifications (id, userId, type, title, body, link, fromNick, ts, read)
                    VALUES (@id, @userId, @type, @title, @body, @link, @fromNick, @ts, @read)
                `);
                for (const [userId, list] of Object.entries(data)) {
                    if (Array.isArray(list)) {
                        for (const n of list) {
                            stmt.run({
                                id: n.id,
                                userId: userId,
                                type: n.type,
                                title: n.title || '',
                                body: n.body || '',
                                link: n.link || null,
                                fromNick: n.from || null,
                                ts: n.ts,
                                read: n.read ? 1 : 0
                            });
                        }
                    }
                }
            }

            // 10) Guestbook
            const gbFile = path.join(DATA_DIR, 'guestbook.json');
            if (isEmpty('guestbook') && fs.existsSync(gbFile)) {
                console.log('[DB-MIGRATE] Migrating guestbook.json...');
                const data = JSON.parse(fs.readFileSync(gbFile, 'utf8')) || {};
                const stmt = db.prepare(`
                    INSERT INTO guestbook (id, profile_nick, author, body, ts)
                    VALUES (@id, @profile_nick, @author, @body, @ts)
                `);
                for (const [profileNick, list] of Object.entries(data)) {
                    if (Array.isArray(list)) {
                        for (const entry of list) {
                            stmt.run({
                                id: entry.id,
                                profile_nick: profileNick,
                                author: entry.author,
                                body: entry.body,
                                ts: entry.ts
                            });
                        }
                    }
                }
            }

            // 11) Resets
            const resetsFile = path.join(DATA_DIR, 'resets.json');
            if (isEmpty('resets') && fs.existsSync(resetsFile)) {
                console.log('[DB-MIGRATE] Migrating resets.json...');
                const data = JSON.parse(fs.readFileSync(resetsFile, 'utf8')) || [];
                const stmt = db.prepare(`INSERT INTO resets (email, code, expires) VALUES (?, ?, ?)`);
                for (const r of data) {
                    stmt.run(r.email, r.code, r.expires);
                }
            }

            // 12) Global Bans
            const bansFile = path.join(DATA_DIR, 'bans.json');
            if (isEmpty('global_bans') && fs.existsSync(bansFile)) {
                console.log('[DB-MIGRATE] Migrating bans.json...');
                const data = JSON.parse(fs.readFileSync(bansFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO global_bans (nick, reason, by_nick, createdAt, expiresAt)
                    VALUES (@nick, @reason, @by_nick, @createdAt, @expiresAt)
                `);
                for (const b of data) {
                    stmt.run({
                        nick: b.nick,
                        reason: b.reason || '',
                        by_nick: b.by || '',
                        createdAt: b.createdAt || null,
                        expiresAt: b.expiresAt || null
                    });
                }
            }

            // 13) Mod Log
            const modLogFile = path.join(DATA_DIR, 'mod_log.json');
            if (isEmpty('mod_log') && fs.existsSync(modLogFile)) {
                console.log('[DB-MIGRATE] Migrating mod_log.json...');
                const data = JSON.parse(fs.readFileSync(modLogFile, 'utf8')) || [];
                const stmt = db.prepare(`
                    INSERT INTO mod_log (id, ts, action, room, by_nick, target, reason, details)
                    VALUES (@id, @ts, @action, @room, @by_nick, @target, @reason, @details)
                `);
                for (const log of data) {
                    stmt.run({
                        id: log.id,
                        ts: log.ts,
                        action: log.action,
                        room: log.room || null,
                        by_nick: log.by,
                        target: log.target || null,
                        reason: log.reason || '',
                        details: log.details ? JSON.stringify(log.details) : null
                    });
                }
            }

            // 14) Room Bans
            const roomBansFile = path.join(DATA_DIR, 'room_bans.json');
            if (isEmpty('room_bans') && fs.existsSync(roomBansFile)) {
                console.log('[DB-MIGRATE] Migrating room_bans.json...');
                const data = JSON.parse(fs.readFileSync(roomBansFile, 'utf8')) || {};
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO room_bans (roomName, nick, ts, by_nick, reason)
                    VALUES (@roomName, @nick, @ts, @by_nick, @reason)
                `);
                for (const [roomName, entries] of Object.entries(data)) {
                    for (const [nick, v] of Object.entries(entries || {})) {
                        stmt.run({
                            roomName,
                            nick,
                            ts: v.ts,
                            by_nick: v.by,
                            reason: v.reason || ''
                        });
                    }
                }
            }

            // 15) Room Stages
            const roomStagesFile = path.join(DATA_DIR, 'room_stages.json');
            if (isEmpty('room_stages') && fs.existsSync(roomStagesFile)) {
                console.log('[DB-MIGRATE] Migrating room_stages.json...');
                const data = JSON.parse(fs.readFileSync(roomStagesFile, 'utf8')) || {};
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO room_stages (roomName, stageData)
                    VALUES (?, ?)
                `);
                for (const [roomName, val] of Object.entries(data)) {
                    stmt.run(roomName, JSON.stringify(val));
                }
            }

            console.log('[DB-MIGRATE] All auto-migrations checked and completed successfully.');
        });
    } catch (e) {
        console.error('[DB-MIGRATE] Migration failed:', e.message);
    }
};

migrateJsonToDb();

// ============ DB API HELPERS ============

// Helper to convert row database fields to clean objects (backwards compatible)
const mapUser = (row) => {
    if (!row) return null;
    return {
        ...row,
        birthYear: row.birthYear ? parseInt(row.birthYear) : null,
        googleLinked: row.google_sub ? true : false,
        privacy: row.privacy ? JSON.parse(row.privacy) : { dmFrom: 'all' }
    };
};

const mapRoom = (row) => {
    if (!row) return null;
    return {
        ...row,
        max: parseInt(row.max),
        max_speakers: parseInt(row.max_speakers),
        max_cameras: parseInt(row.max_cameras),
        auto_stage: row.auto_stage === 1,
        speaker_time_limit: parseInt(row.speaker_time_limit),
        silence_kick_seconds: parseInt(row.silence_kick_seconds),
        coHosts: row.coHosts ? JSON.parse(row.coHosts) : [],
        isUserRoom: true // for frontend templates
    };
};

// Users
async function loadUsers() {
    const rows = db.prepare(`SELECT * FROM users`).all();
    return rows.map(mapUser);
}

async function saveUsers(usersList) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO users (id, nick, password, role, birthYear, email, google_sub, display_name, createdAt, invited_by, invite_code, avatar, avatarPhoto, bio, status, personal_msg, about, city, musicTaste, instagram, twitter, tiktok, youtube, discord, profileTheme, profileMusic, profileMusicName, moodEmoji, moodText, sessionId, privacy)
        VALUES (@id, @nick, @password, @role, @birthYear, @email, @google_sub, @display_name, @createdAt, @invited_by, @invite_code, @avatar, @avatarPhoto, @bio, @status, @personal_msg, @about, @city, @musicTaste, @instagram, @twitter, @tiktok, @youtube, @discord, @profileTheme, @profileMusic, @profileMusicName, @moodEmoji, @moodText, @sessionId, @privacy)
    `);
    db.transaction(() => {
        for (const u of usersList) {
            stmt.run({
                id: u.id,
                nick: u.nick,
                password: u.password || null,
                role: u.role || 'user',
                birthYear: u.birthYear || null,
                email: u.email || null,
                google_sub: u.google_sub || null,
                display_name: u.display_name || null,
                createdAt: u.createdAt || null,
                invited_by: u.invited_by || null,
                invite_code: u.invite_code || null,
                avatar: u.avatar || 'default',
                avatarPhoto: u.avatarPhoto || null,
                bio: u.bio || null,
                status: u.status || 'online',
                personal_msg: u.personal_msg || null,
                about: u.about || null,
                city: u.city || null,
                musicTaste: u.musicTaste || null,
                instagram: u.instagram || null,
                twitter: u.twitter || null,
                tiktok: u.tiktok || null,
                youtube: u.youtube || null,
                discord: u.discord || null,
                profileTheme: u.profileTheme || 'default',
                profileMusic: u.profileMusic || null,
                profileMusicName: u.profileMusicName || null,
                moodEmoji: u.moodEmoji || null,
                moodText: u.moodText || null,
                sessionId: u.sessionId || null,
                privacy: u.privacy ? JSON.stringify(u.privacy) : null
            });
        }
    })();
}

// User Rooms
async function loadUserRooms() {
    const rows = db.prepare(`SELECT * FROM user_rooms`).all();
    return rows.map(mapRoom);
}

async function saveUserRooms(roomsList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM user_rooms`).run();
        const stmt = db.prepare(`
            INSERT INTO user_rooms (name, host, category, max, password, desc, icon, badge, theme, coHosts, mic_policy, cam_policy, max_speakers, max_cameras, auto_stage, speaker_time_limit, silence_kick_seconds, ai_level, cam_mode, createdAt)
            VALUES (@name, @host, @category, @max, @password, @desc, @icon, @badge, @theme, @coHosts, @mic_policy, @cam_policy, @max_speakers, @max_cameras, @auto_stage, @speaker_time_limit, @silence_kick_seconds, @ai_level, @cam_mode, @createdAt)
        `);
        for (const r of roomsList) {
            stmt.run({
                name: r.name,
                host: r.host || null,
                category: r.category || 'free',
                max: r.max || 10,
                password: r.password || null,
                desc: r.desc || '',
                icon: r.icon || '💬',
                badge: r.badge || null,
                theme: r.theme || 'classic',
                coHosts: r.coHosts ? JSON.stringify(r.coHosts) : '[]',
                mic_policy: r.mic_policy || 'open',
                cam_policy: r.cam_policy || 'speakers_only',
                max_speakers: r.max_speakers !== undefined ? r.max_speakers : 6,
                max_cameras: r.max_cameras !== undefined ? r.max_cameras : 3,
                auto_stage: r.auto_stage ? 1 : 0,
                speaker_time_limit: r.speaker_time_limit || 0,
                silence_kick_seconds: r.silence_kick_seconds || 0,
                ai_level: r.ai_level || 'standard',
                cam_mode: r.cam_mode || 'camera',
                createdAt: r.createdAt || new Date().toISOString()
            });
        }
    })();
}

// System Rooms
async function loadSystemRooms() {
    const rows = db.prepare(`SELECT * FROM system_rooms`).all();
    return rows.map(mapRoom);
}

async function saveSystemRooms(roomsList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM system_rooms`).run();
        const stmt = db.prepare(`
            INSERT INTO system_rooms (name, host, category, max, password, desc, icon, badge, theme, coHosts, mic_policy, cam_policy, max_speakers, max_cameras, auto_stage, speaker_time_limit, silence_kick_seconds, ai_level, cam_mode, createdAt)
            VALUES (@name, @host, @category, @max, @password, @desc, @icon, @badge, @theme, @coHosts, @mic_policy, @cam_policy, @max_speakers, @max_cameras, @auto_stage, @speaker_time_limit, @silence_kick_seconds, @ai_level, @cam_mode, @createdAt)
        `);
        for (const r of roomsList) {
            stmt.run({
                name: r.name,
                host: r.host || null,
                category: r.category || 'free',
                max: r.max || 10,
                password: r.password || null,
                desc: r.desc || '',
                icon: r.icon || '💬',
                badge: r.badge || null,
                theme: r.theme || 'classic',
                coHosts: r.coHosts ? JSON.stringify(r.coHosts) : '[]',
                mic_policy: r.mic_policy || 'open',
                cam_policy: r.cam_policy || 'speakers_only',
                max_speakers: r.max_speakers !== undefined ? r.max_speakers : 6,
                max_cameras: r.max_cameras !== undefined ? r.max_cameras : 3,
                auto_stage: r.auto_stage ? 1 : 0,
                speaker_time_limit: r.speaker_time_limit || 0,
                silence_kick_seconds: r.silence_kick_seconds || 0,
                ai_level: r.ai_level || 'standard',
                cam_mode: r.cam_mode || 'camera',
                createdAt: r.createdAt || new Date().toISOString()
            });
        }
    })();
}

// DMs
async function loadDMs() {
    const rows = db.prepare(`SELECT * FROM dms`).all();
    return rows.map(r => ({
        id: r.id,
        from: r.from_nick,
        to: r.to_nick,
        body: r.body,
        ts: parseInt(r.ts),
        read: r.read === 1
    }));
}

async function saveDMs(dmsList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM dms`).run();
        const stmt = db.prepare(`
            INSERT INTO dms (id, from_nick, to_nick, body, ts, read)
            VALUES (@id, @from_nick, @to_nick, @body, @ts, @read)
        `);
        for (const d of dmsList) {
            stmt.run({
                id: d.id,
                from_nick: d.from,
                to_nick: d.to,
                body: d.body,
                ts: d.ts,
                read: d.read ? 1 : 0
            });
        }
    })();
}

// Friends
async function loadFriends() {
    const rows = db.prepare(`SELECT * FROM friends`).all();
    const data = {};
    for (const r of rows) {
        if (!data[r.user1]) data[r.user1] = [];
        data[r.user1].push(r.user2);
    }
    return data;
}

async function saveFriends(friendsData) {
    db.transaction(() => {
        db.prepare(`DELETE FROM friends`).run();
        const stmt = db.prepare(`INSERT OR IGNORE INTO friends (user1, user2) VALUES (?, ?)`);
        for (const [userId, list] of Object.entries(friendsData)) {
            if (Array.isArray(list)) {
                for (const peerNick of list) {
                    stmt.run(userId, peerNick);
                }
            }
        }
    })();
}

// Blocks
async function loadBlocks() {
    const rows = db.prepare(`SELECT * FROM blocks`).all();
    const data = {};
    for (const r of rows) {
        if (!data[r.user]) data[r.user] = [];
        data[r.user].push(r.blocked_user);
    }
    return data;
}

async function saveBlocks(blocksData) {
    db.transaction(() => {
        db.prepare(`DELETE FROM blocks`).run();
        const stmt = db.prepare(`INSERT OR IGNORE INTO blocks (user, blocked_user) VALUES (?, ?)`);
        for (const [userId, list] of Object.entries(blocksData)) {
            if (Array.isArray(list)) {
                for (const peer of list) {
                    stmt.run(userId, peer);
                }
            }
        }
    })();
}

// Friend Requests
async function loadFR() {
    const rows = db.prepare(`SELECT * FROM friend_requests`).all();
    return rows.map(r => ({
        id: r.id,
        fromNick: r.from_nick,
        toNick: r.to_nick,
        ts: parseInt(r.ts)
    }));
}

async function saveFR(frList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM friend_requests`).run();
        const stmt = db.prepare(`
            INSERT INTO friend_requests (id, from_nick, to_nick, ts)
            VALUES (?, ?, ?, ?)
        `);
        for (const r of frList) {
            stmt.run(r.id, r.fromNick, r.toNick, r.ts);
        }
    })();
}

// Locks
async function loadLocks() {
    const rows = db.prepare(`SELECT * FROM locks`).all();
    const data = {};
    for (const r of rows) {
        data[r.room_name] = r.is_locked === 1;
    }
    return data;
}

async function saveLocks(locksData) {
    db.transaction(() => {
        db.prepare(`DELETE FROM locks`).run();
        const stmt = db.prepare(`INSERT INTO locks (room_name, is_locked) VALUES (?, ?)`);
        for (const [roomName, val] of Object.entries(locksData)) {
            stmt.run(roomName, val ? 1 : 0);
        }
    })();
}

// Notifications
async function loadNotifications() {
    const rows = db.prepare(`SELECT * FROM notifications`).all();
    const data = {};
    for (const r of rows) {
        if (!data[r.userId]) data[r.userId] = [];
        data[r.userId].push({
            id: r.id,
            type: r.type,
            title: r.title,
            body: r.body,
            link: r.link,
            from: r.fromNick,
            ts: parseInt(r.ts),
            read: r.read === 1
        });
    }
    return data;
}

async function saveNotifications(notifsData) {
    db.transaction(() => {
        db.prepare(`DELETE FROM notifications`).run();
        const stmt = db.prepare(`
            INSERT INTO notifications (id, userId, type, title, body, link, fromNick, ts, read)
            VALUES (@id, @userId, @type, @title, @body, @link, @fromNick, @ts, @read)
        `);
        for (const [userId, list] of Object.entries(notifsData)) {
            if (Array.isArray(list)) {
                for (const n of list) {
                    stmt.run({
                        id: n.id,
                        userId: userId,
                        type: n.type,
                        title: n.title || '',
                        body: n.body || '',
                        link: n.link || null,
                        fromNick: n.from || null,
                        ts: n.ts,
                        read: n.read ? 1 : 0
                    });
                }
            }
        }
    })();
}

// Resets
async function loadResets() {
    const rows = db.prepare(`SELECT * FROM resets`).all();
    return rows.map(r => ({
        email: r.email,
        code: r.code,
        expires: parseInt(r.expires)
    }));
}

async function saveResets(resetsList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM resets`).run();
        const stmt = db.prepare(`INSERT INTO resets (email, code, expires) VALUES (?, ?, ?)`);
        for (const r of resetsList) {
            stmt.run(r.email, r.code, r.expires);
        }
    })();
}

// Guestbook
async function loadGuestbook() {
    const rows = db.prepare(`SELECT * FROM guestbook`).all();
    const data = {};
    for (const r of rows) {
        if (!data[r.profile_nick]) data[r.profile_nick] = [];
        data[r.profile_nick].push({
            id: r.id,
            author: r.author,
            body: r.body,
            ts: parseInt(r.ts)
        });
    }
    return data;
}

async function saveGuestbook(gbData) {
    db.transaction(() => {
        db.prepare(`DELETE FROM guestbook`).run();
        const stmt = db.prepare(`
            INSERT INTO guestbook (id, profile_nick, author, body, ts)
            VALUES (@id, @profile_nick, @author, @body, @ts)
        `);
        for (const [profileNick, list] of Object.entries(gbData)) {
            if (Array.isArray(list)) {
                for (const entry of list) {
                    stmt.run({
                        id: entry.id,
                        profile_nick: profileNick,
                        author: entry.author,
                        body: entry.body,
                        ts: entry.ts
                    });
                }
            }
        }
    })();
}

// Global Bans
async function loadBans() {
    const rows = db.prepare(`SELECT * FROM global_bans`).all();
    return rows.map(r => ({
        nick: r.nick,
        reason: r.reason,
        by: r.by_nick,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt
    }));
}

async function saveBans(bansList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM global_bans`).run();
        const stmt = db.prepare(`
            INSERT INTO global_bans (nick, reason, by_nick, createdAt, expiresAt)
            VALUES (@nick, @reason, @by_nick, @createdAt, @expiresAt)
        `);
        for (const b of bansList) {
            stmt.run({
                nick: b.nick,
                reason: b.reason || '',
                by_nick: b.by || '',
                createdAt: b.createdAt || null,
                expiresAt: b.expiresAt || null
            });
        }
    })();
}

// Dead Youtube IDs
async function loadDeadYtIds() {
    const rows = db.prepare(`SELECT * FROM dead_yt_ids`).all();
    return rows.map(r => ({
        ytId: r.ytId,
        addedBy: r.addedBy,
        ts: parseInt(r.ts)
    }));
}

async function saveDeadYtIds(idsList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM dead_yt_ids`).run();
        const stmt = db.prepare(`INSERT INTO dead_yt_ids (ytId, addedBy, ts) VALUES (?, ?, ?)`);
        for (const r of idsList) {
            stmt.run(r.ytId, r.addedBy, r.ts);
        }
    })();
}

// Mod Log
async function loadModLog() {
    const rows = db.prepare(`SELECT * FROM mod_log ORDER BY ts DESC`).all();
    return rows.map(r => ({
        id: r.id,
        ts: parseInt(r.ts),
        action: r.action,
        room: r.room,
        by: r.by_nick,
        target: r.target,
        reason: r.reason,
        details: r.details ? JSON.parse(r.details) : null
    }));
}

async function saveModLog(logList) {
    db.transaction(() => {
        db.prepare(`DELETE FROM mod_log`).run();
        const stmt = db.prepare(`
            INSERT INTO mod_log (id, ts, action, room, by_nick, target, reason, details)
            VALUES (@id, @ts, @action, @room, @by_nick, @target, @reason, @details)
        `);
        for (const log of logList) {
            stmt.run({
                id: log.id,
                ts: log.ts,
                action: log.action,
                room: log.room || null,
                by_nick: log.by,
                target: log.target || null,
                reason: log.reason || '',
                details: log.details ? JSON.stringify(log.details) : null
            });
        }
    })();
}

// Timeline Memories
async function loadTimelineMemories(year) {
    const rows = db.prepare(`SELECT * FROM timeline_memories WHERE year = ? ORDER BY createdAt DESC`).all(year);
    return rows.map(r => ({
        id: r.id,
        year: parseInt(r.year),
        nick: r.nick,
        body: r.body,
        reactions: r.reactions ? JSON.parse(r.reactions) : { heart: [], sad: [], fire: [] },
        createdAt: r.createdAt
    }));
}

async function saveTimelineMemory(memory) {
    db.prepare(`
        INSERT INTO timeline_memories (id, year, nick, body, reactions, createdAt)
        VALUES (@id, @year, @nick, @body, @reactions, @createdAt)
    `).run({
        id: memory.id,
        year: memory.year,
        nick: memory.nick,
        body: memory.body,
        reactions: memory.reactions ? JSON.stringify(memory.reactions) : JSON.stringify({ heart: [], sad: [], fire: [] }),
        createdAt: memory.createdAt || new Date().toISOString()
    });
}

async function updateTimelineMemoryReactions(id, reactions) {
    db.prepare(`UPDATE timeline_memories SET reactions = ? WHERE id = ?`).run(JSON.stringify(reactions), id);
}

// Timeline Summaries
async function loadTimelineSummary(year) {
    const row = db.prepare(`SELECT * FROM timeline_summaries WHERE year = ?`).get(year);
    if (!row) return null;
    return {
        year: parseInt(row.year),
        summary: JSON.parse(row.summary),
        createdAt: row.createdAt
    };
}

async function saveTimelineSummary(year, summary) {
    db.prepare(`
        INSERT OR REPLACE INTO timeline_summaries (year, summary, createdAt)
        VALUES (?, ?, ?)
    `).run(year, JSON.stringify(summary), new Date().toISOString());
}

async function loadTimelineDetails(query) {
    const row = db.prepare(`SELECT * FROM timeline_details WHERE query = ?`).get(query);
    if (!row) return null;
    return {
        query: row.query,
        details: JSON.parse(row.details),
        createdAt: row.createdAt
    };
}

async function saveTimelineDetails(query, details) {
    db.prepare(`
        INSERT OR REPLACE INTO timeline_details (query, details, createdAt)
        VALUES (?, ?, ?)
    `).run(query, JSON.stringify(details), new Date().toISOString());
}

async function loadTimelineHistory20(dateStr) {
    const row = db.prepare(`SELECT * FROM timeline_history20 WHERE date_str = ?`).get(dateStr);
    if (!row) return null;
    return {
        dateStr: row.date_str,
        data: JSON.parse(row.data),
        createdAt: row.createdAt
    };
}

async function saveTimelineHistory20(dateStr, data) {
    db.prepare(`
        INSERT OR REPLACE INTO timeline_history20 (date_str, data, createdAt)
        VALUES (?, ?, ?)
    `).run(dateStr, JSON.stringify(data), new Date().toISOString());
}

module.exports = {
    db,
    loadUsers,
    saveUsers,
    loadUserRooms,
    saveUserRooms,
    loadSystemRooms,
    saveSystemRooms,
    loadDMs,
    saveDMs,
    loadFriends,
    saveFriends,
    loadBlocks,
    saveBlocks,
    loadFR,
    saveFR,
    loadLocks,
    saveLocks,
    loadNotifications,
    saveNotifications,
    loadResets,
    saveResets,
    loadGuestbook,
    saveGuestbook,
    loadBans,
    saveBans,
    loadDeadYtIds,
    saveDeadYtIds,
    loadModLog,
    saveModLog,
    loadTimelineMemories,
    saveTimelineMemory,
    updateTimelineMemoryReactions,
    loadTimelineSummary,
    saveTimelineSummary,
    loadTimelineDetails,
    saveTimelineDetails,
    loadTimelineHistory20,
    saveTimelineHistory20
};

