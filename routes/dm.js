const express = require('express');
const router = express.Router();
const db = require('../services/db');
const {
    requireAuth,
    dmLimiter,
    pushNotification,
    pushNotificationByNick
} = require('../services/shared');

// ============ HELPERS ============
async function hasBlocked(byUserId, targetNick) {
    if (!byUserId || !targetNick) return false;
    const all = await db.loadBlocks();
    const list = all[byUserId] || [];
    return list.some(n => n.toLowerCase() === targetNick.toLowerCase());
}

async function areFriends(idA, idB, nickA, nickB) {
    const all = await db.loadFriends();
    const listA = all[idA] || [];
    return listA.some(n => n.toLowerCase() === String(nickB).toLowerCase());
}

const _nudgeCooldowns = new Map();
const NUDGE_COOLDOWN_MS = 60 * 1000;

// ============ ROUTES ============

// POST /api/dm/send — auth gerektirir, misafirler yazamaz, rate limit
router.post('/dm/send', dmLimiter, requireAuth, async (req, res) => {
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
    const users = await db.loadUsers();
    const toUser = users.find(u => u.nick.toLowerCase() === to_nick.toLowerCase());
    if (!toUser) {
        return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }
    // Engel kontrolü — iki yönden de.
    const fromUserObj = users.find(u => u.id === req.user.id);
    if (fromUserObj && await hasBlocked(fromUserObj.id, toUser.nick)) {
        return res.status(403).json({ success: false, error: 'Bu kullanıcıyı engellediğin için mesaj atamazsın. Önce engel listeden çıkar.' });
    }
    if (await hasBlocked(toUser.id, fromNick)) {
        // Hedef, gönderici tarafından engellenmiş — gönderici bunu açıkça bilmesin (privacy)
        return res.status(403).json({ success: false, error: 'Bu kullanıcıya şu anda mesaj atılamıyor.' });
    }
    // DM izni kontrolü — toUser ayarına göre.
    const dmFrom = toUser?.privacy?.dmFrom || 'all';
    if (dmFrom === 'none') {
        return res.status(403).json({ success: false, error: 'Bu kullanıcı kimseden DM kabul etmiyor.' });
    }
    if (dmFrom === 'friends') {
        const isFriend = await areFriends(fromUserObj.id, toUser.id, fromNick, toUser.nick);
        const isStaff = req.user.role === 'admin' || req.user.role === 'mod';
        if (!isFriend && !isStaff) {
            return res.status(403).json({ success: false, error: 'Bu kullanıcı sadece arkadaşlarından DM kabul ediyor.' });
        }
    }
    const dms = await db.loadDMs();
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
    await db.saveDMs(dms);
    console.log(`[DM] ${fromNick} → ${toUser.nick}: ${trimmed.slice(0, 40)}`);
    // Bildirim merkezi tetik
    await pushNotification(toUser.id, 'dm', {
        title: `💬 ${fromNick} sana mesaj gönderdi`,
        body: trimmed.slice(0, 100),
        link: '/?dm=' + encodeURIComponent(fromNick),
        from: fromNick,
    });
    res.json({ success: true, message: msg });
});

// GET /api/dm/inbox — thread'lere gruplanmış, her thread'in son mesajı + unread sayısı
router.get('/dm/inbox', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const dms = await db.loadDMs();
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
    const users = await db.loadUsers();
    for (const t of list) {
        const peerLc = t.peer.toLowerCase();
        const peerUser = users.find(u => u.nick.toLowerCase() === peerLc);
        t.peerInfo = peerUser ? {
            avatar: peerUser.avatar || 'default',
            avatarPhoto: peerUser.avatarPhoto ? `/assets/avatars/${peerUser.avatarPhoto}` : '',
            googleLinked: !!peerUser.google_sub
        } : { avatar: 'default', avatarPhoto: '', googleLinked: false };
    }
    const totalUnread = list.reduce((sum, t) => sum + t.unread, 0);
    res.json({ success: true, threads: list, totalUnread });
});

// GET /api/dm/thread/:nick — iki kullanıcı arası tüm mesajlar (kronolojik)
router.get('/dm/thread/:nick', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const peer = req.params.nick.toLowerCase();
    const dms = await db.loadDMs();
    const messages = dms.filter(m => {
        const fl = m.from.toLowerCase(), tl = m.to.toLowerCase();
        return (fl === me && tl === peer) || (fl === peer && tl === me);
    }).sort((a, b) => a.ts - b.ts);
    // Peer info ekle (status + personal msg) — MSN penceresinde göstermek için
    const users = await db.loadUsers();
    const peerUser = users.find(u => u.nick.toLowerCase() === peer);
    const peerInfo = peerUser ? {
        nick: peerUser.nick,
        avatar: peerUser.avatar || 'default',
        avatarPhoto: peerUser.avatarPhoto ? `/assets/avatars/${peerUser.avatarPhoto}` : '',
        googleLinked: !!peerUser.google_sub,
        status: peerUser.status === 'invisible' ? 'online' : (peerUser.status || 'online'),
        personal_msg: peerUser.personal_msg || '',
    } : null;
    res.json({ success: true, messages, me: req.user.nick, peer: peerInfo });
});

// POST /api/dm/read — {nick} thread'indeki bana gelen mesajları okundu işaretle
router.post('/dm/read', requireAuth, async (req, res) => {
    const me = req.user.nick.toLowerCase();
    const peer = (req.body.nick || '').toLowerCase();
    if (!peer) return res.status(400).json({ success: false, error: 'nick gerekli' });
    const dms = await db.loadDMs();
    let changed = 0;
    for (const m of dms) {
        if (m.to.toLowerCase() === me && m.from.toLowerCase() === peer && !m.read) {
            m.read = true;
            changed++;
        }
    }
    if (changed) await db.saveDMs(dms);
    res.json({ success: true, marked: changed });
});

// POST /api/users/:nick/nudge — dürt (nudge) — friend-only + spam koruma
router.post('/users/:nick/nudge', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler dürtemez.' });
    }
    const targetNick = req.params.nick;
    if (targetNick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini dürtemezsin.' });
    }
    const users = await db.loadUsers();
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
    await pushNotification(target.id, 'dm', {
        title: `📳 ${req.user.nick} seni dürttü!`,
        body: 'Dürt — bir merhaba kadar samimi!',
        link: '/?dm=' + encodeURIComponent(req.user.nick),
        from: req.user.nick,
    });
    res.json({ success: true });
});

async function getFriendsOf(userId) {
    const all = await db.loadFriends();
    return all[userId] || [];
}

module.exports = router;
