const express = require('express');
const router = express.Router();
const db = require('../services/db');
const {
    requireAuth,
    pushNotification,
} = require('../services/shared');

// We will require this from rooms.js later to get the live room data for status checking
let fetchRoomData = null;
try {
    fetchRoomData = require('./rooms').fetchRoomData;
} catch (e) {
    // Will be loaded dynamically
}

// ============ HELPERS ============
async function getFriendsOf(userId) {
    const all = await db.loadFriends();
    return all[userId] || [];
}

async function getBlocksOf(userId) {
    const all = await db.loadBlocks();
    return all[userId] || [];
}

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

async function addMutualFriend(idA, nickA, idB, nickB) {
    const all = await db.loadFriends();
    if (!all[idA]) all[idA] = [];
    if (!all[idB]) all[idB] = [];
    if (!all[idA].some(n => n.toLowerCase() === nickB.toLowerCase())) all[idA].push(nickB);
    if (!all[idB].some(n => n.toLowerCase() === nickA.toLowerCase())) all[idB].push(nickA);
    await db.saveFriends(all);
}

async function removeMutualFriend(idA, nickA, idB, nickB) {
    const all = await db.loadFriends();
    if (all[idA]) all[idA] = all[idA].filter(n => n.toLowerCase() !== nickB.toLowerCase());
    if (all[idB]) all[idB] = all[idB].filter(n => n.toLowerCase() !== nickA.toLowerCase());
    await db.saveFriends(all);
}

// ============ ROUTES ============

// Arkadaş listesi (kendi)
router.get('/friends/list', requireAuth, async (req, res) => {
    const friends = await getFriendsOf(req.user.id);
    const users = await db.loadUsers();
    
    const activeRooms = new Map();
    try {
        if (!fetchRoomData) {
            try {
                fetchRoomData = require('./rooms').fetchRoomData;
            } catch (err) {}
        }
        if (fetchRoomData) {
            const baseRooms = await fetchRoomData();
            for (const r of baseRooms) {
                if (r.users && Array.isArray(r.users)) {
                    for (const u of r.users) {
                        activeRooms.set(u.toLowerCase(), r.name);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[FRIENDS] Odalar çekilirken hata:', e.message);
    }

    const friendsEnriched = friends.map(fName => {
        const fUser = users.find(u => u.nick.toLowerCase() === fName.toLowerCase());
        const fActiveRoom = activeRooms.get(fName.toLowerCase()) || null;
        let fStatus = 'offline';
        if (fActiveRoom) {
            fStatus = fUser?.status === 'invisible' ? 'offline' : (fUser?.status || 'online');
        }
        return {
            nick: fName,
            avatar: fUser?.avatar || 'default',
            status: fStatus,
            moodEmoji: fUser?.moodEmoji || '',
            moodText: fUser?.moodText || '',
            activeRoom: fStatus !== 'offline' ? fActiveRoom : null,
        };
    });

    res.json({ success: true, friends, friendsEnriched });
});

// İstek gönder (karşılıklı onay zorunlu)
router.post('/friends/request', requireAuth, async (req, res) => {
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
    const users = await db.loadUsers();
    const targetUser = users.find(u => u.nick.toLowerCase() === target.toLowerCase());
    if (!targetUser) return res.status(404).json({ success: false, error: 'Bu nick ile kayıtlı kullanıcı yok.' });

    // Zaten arkadaşsa
    if (await areFriends(req.user.id, targetUser.id, req.user.nick, targetUser.nick)) {
        return res.status(409).json({ success: false, error: 'Zaten arkadaşsınız.' });
    }
    // Arkadaş listesi sınırı
    const myFriends = await getFriendsOf(req.user.id);
    if (myFriends.length >= 100) return res.status(429).json({ success: false, error: 'En fazla 100 arkadaşın olabilir.' });

    const requests = await db.loadFR();
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
        await db.saveFR(requests);
        await addMutualFriend(req.user.id, req.user.nick, targetUser.id, targetUser.nick);
        // Karşı tarafa "istek kabul edildi" bildirimi
        await pushNotification(targetUser.id, 'friend_add', {
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
    await db.saveFR(cleaned);
    console.log(`[FR] İstek: ${req.user.nick} → ${targetUser.nick}`);
    // Bildirim — alıcıya
    await pushNotification(targetUser.id, 'friend_add', {
        title: `👥 ${req.user.nick} sana arkadaşlık isteği gönderdi`,
        body: 'Profilinden Kabul Et / Reddet seçeneklerini görebilirsin.',
        link: '/u/' + encodeURIComponent(req.user.nick),
        from: req.user.nick,
    });
    res.json({ success: true, request: newReq });
});

// Bekleyen istekler — { incoming: [...], outgoing: [...] }
router.get('/friends/requests', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') return res.json({ success: true, incoming: [], outgoing: [] });
    const requests = await db.loadFR();
    const incoming = requests.filter(r => r.toId === req.user.id && r.status === 'pending');
    const outgoing = requests.filter(r => r.fromId === req.user.id && r.status === 'pending');
    res.json({ success: true, incoming, outgoing });
});

// İstek kabul et (alıcı)
router.post('/friends/requests/:id/accept', requireAuth, async (req, res) => {
    const requests = await db.loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.toId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'accepted';
    r.acceptedAt = Date.now();
    await db.saveFR(requests);
    await addMutualFriend(r.fromId, r.fromNick, r.toId, r.toNick);
    console.log(`[FR] Kabul: ${r.fromNick} ↔ ${r.toNick}`);
    // Bildirim — istek gönderene
    await pushNotification(r.fromId, 'friend_add', {
        title: `🤝 ${r.toNick} arkadaşlık isteğini kabul etti!`,
        body: 'Artık arkadaşsınız.',
        link: '/u/' + encodeURIComponent(r.toNick),
        from: r.toNick,
    });
    res.json({ success: true });
});

// İstek reddet (alıcı)
router.post('/friends/requests/:id/reject', requireAuth, async (req, res) => {
    const requests = await db.loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.toId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'rejected';
    r.rejectedAt = Date.now();
    await db.saveFR(requests);
    console.log(`[FR] Red: ${r.fromNick} → ${r.toNick}`);
    res.json({ success: true });
});

// İstek geri çek (gönderen)
router.delete('/friends/requests/:id', requireAuth, async (req, res) => {
    const requests = await db.loadFR();
    const r = requests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'İstek bulunamadı.' });
    if (r.fromId !== req.user.id) return res.status(403).json({ success: false, error: 'Bu istek senin değil.' });
    if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'İstek artık bekleyen durumda değil.' });
    r.status = 'canceled';
    r.canceledAt = Date.now();
    await db.saveFR(requests);
    res.json({ success: true });
});

// Arkadaş sil — KARŞILIKLI çıkar
router.post('/friends/remove', requireAuth, async (req, res) => {
    const { nick } = req.body;
    if (!nick) return res.status(400).json({ success: false, error: 'Nick gerekli.' });
    const users = await db.loadUsers();
    const targetUser = users.find(u => u.nick.toLowerCase() === String(nick).toLowerCase());
    const list = await getFriendsOf(req.user.id);
    if (!list.some(f => f.toLowerCase() === String(nick).toLowerCase())) {
        return res.status(404).json({ success: false, error: 'Bu kullanıcı arkadaşın değil.' });
    }
    if (targetUser) {
        await removeMutualFriend(req.user.id, req.user.nick, targetUser.id, targetUser.nick);
    } else {
        // Hedef silinmiş olabilir — sadece kendi listenden çıkar
        const all = await db.loadFriends();
        all[req.user.id] = (all[req.user.id] || []).filter(f => f.toLowerCase() !== String(nick).toLowerCase());
        await db.saveFriends(all);
    }
    res.json({ success: true, friends: await getFriendsOf(req.user.id) });
});

// Engellenen kullanıcıları listele
router.get('/blocks', requireAuth, async (req, res) => {
    res.json({ success: true, blocked: await getBlocksOf(req.user.id) });
});

// Engelle
router.post('/blocks', requireAuth, async (req, res) => {
    const { nick } = req.body || {};
    if (!nick || typeof nick !== 'string') return res.status(400).json({ success: false, error: 'nick gerekli' });
    if (nick.toLowerCase() === req.user.nick.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'Kendini engelleyemezsin' });
    }
    const users = await db.loadUsers();
    const target = users.find(u => u.nick.toLowerCase() === nick.toLowerCase());
    if (!target) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    // admin/mod engellenemez (moderasyon korumalı)
    if (target.role === 'admin' || target.role === 'mod') {
        return res.status(403).json({ success: false, error: 'Yöneticileri engelleyemezsin' });
    }
    const all = await db.loadBlocks();
    if (!all[req.user.id]) all[req.user.id] = [];
    if (!all[req.user.id].some(n => n.toLowerCase() === target.nick.toLowerCase())) {
        all[req.user.id].push(target.nick);
        await db.saveBlocks(all);
    }
    // Engellenen kişi engelleyenle arkadaşsa arkadaşlık da silinsin
    if (await areFriends(req.user.id, target.id, req.user.nick, target.nick)) {
        await removeMutualFriend(req.user.id, req.user.nick, target.id, target.nick);
    }
    console.log(`[BLOCK] ${req.user.nick} → ${target.nick} (engelledi)`);
    res.json({ success: true, blocked: await getBlocksOf(req.user.id) });
});

// Engeli kaldır
router.delete('/blocks/:nick', requireAuth, async (req, res) => {
    const nick = decodeURIComponent(req.params.nick);
    const all = await db.loadBlocks();
    if (!all[req.user.id]) return res.json({ success: true, blocked: [] });
    all[req.user.id] = all[req.user.id].filter(n => n.toLowerCase() !== nick.toLowerCase());
    await db.saveBlocks(all);
    console.log(`[BLOCK] ${req.user.nick} → ${nick} (engel kaldırıldı)`);
    res.json({ success: true, blocked: await getBlocksOf(req.user.id) });
});

module.exports = router;
