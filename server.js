require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

const path = require('path');

const app = express();
app.use(cors());

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

// ============ Sağlık kontrolü ============
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        livekit_url: process.env.LIVEKIT_URL,
        api_key_set: !!process.env.LIVEKIT_API_KEY,
        api_secret_set: !!process.env.LIVEKIT_API_SECRET
    });
});

// ============ Sunucu başlat ============
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Cloud container'lar için gerekli
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
