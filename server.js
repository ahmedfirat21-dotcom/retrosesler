require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

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
