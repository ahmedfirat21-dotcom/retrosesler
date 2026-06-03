require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

// Initialize database service on startup
require('./services/db');

// Import modular route handlers
const authRouter = require('./routes/auth');
const roomsRouter = require('./routes/rooms').router;
const dmRouter = require('./routes/dm');
const friendsRouter = require('./routes/friends');
const radioRouter = require('./routes/radio').router;
const timelineRouter = require('./routes/timeline');

const app = express();
app.set('trust proxy', 1); // Trust Nginx proxy for correct rate-limiting IPs

// CORS configuration (allow retrosesler.com and localhost)
const ALLOWED_ORIGINS = [
    'https://retrosesler.com',
    'https://www.retrosesler.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
];
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error('CORS: Bu origin izinli değil'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '2mb' })); // Support base64 audit logs up to 2MB

// HTML page caching blocker middleware
const noCache = (req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.removeHeader('ETag');
    next();
};
app.set('etag', false);

// ============ HTML PAGE ROUTING (Explicit Whitelist serving) ============
const sfOpts = { lastModified: false, etag: false };

app.get('/', noCache, (req, res) => res.sendFile(path.join(__dirname, 'index.html'), sfOpts));
app.get('/giris', noCache, (req, res) => res.sendFile(path.join(__dirname, 'auth.html'), sfOpts));
app.get('/sifre-sifirla', noCache, (req, res) => res.sendFile(path.join(__dirname, 'sifre-sifirla.html'), sfOpts));
app.get('/oda', noCache, (req, res) => res.sendFile(path.join(__dirname, 'room.html'), sfOpts));
app.get('/yonetim-r3tro', noCache, (req, res) => res.sendFile(path.join(__dirname, 'admin.html'), sfOpts));

// Legal and Information pages
app.get('/hakkimizda', noCache, (req, res) => res.sendFile(path.join(__dirname, 'hakkimizda.html')));
app.get('/gizlilik', noCache, (req, res) => res.sendFile(path.join(__dirname, 'gizlilik.html')));
app.get('/kullanim-sartlari', noCache, (req, res) => res.sendFile(path.join(__dirname, 'kullanim-sartlari.html')));

// Dynamic profile and invitation pages
app.get('/u/:nick', noCache, (req, res) => res.sendFile(path.join(__dirname, 'profil.html')));
app.get('/davet/:code', noCache, (req, res) => res.sendFile(path.join(__dirname, 'davet.html')));

// Direct HTML extension block
app.get('*.html', (req, res) => {
    if (req.path === '/index.html') return res.redirect('/');
    return res.status(404).send('Sayfa bulunamadı');
});

// Legacy /getToken redirect
app.get('/getToken', (req, res) => res.redirect(307, '/api/token?' + new URLSearchParams(req.query).toString()));

// ============ STATIC CONTENT SERVING (Whitelist model) ============
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
    maxAge: '7d',
    etag: true,
}));
app.use('/livekit-sdk', express.static(path.join(__dirname, 'node_modules', 'livekit-client', 'dist')));

// ============ MOUNT API ROUTES ============
app.use('/api', authRouter);
app.use('/api', roomsRouter);
app.use('/api', dmRouter);
app.use('/api', friendsRouter);
app.use('/api', radioRouter);
app.use('/api', timelineRouter);

// Giphy and Image Proxy to bypass hotlink block and AdBlockers
const https = require('https');
app.get('/api/proxy-gif', (req, res) => {
    const gifUrl = req.query.url;
    if (!gifUrl) {
        return res.status(400).send('Missing url parameter');
    }
    try {
        const parsed = new URL(gifUrl);
        if (!parsed.hostname.endsWith('giphy.com')) {
            return res.status(400).send('Invalid domain');
        }
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        };
        console.log('[Proxy-GIF] Requesting:', gifUrl);
        https.get(gifUrl, options, (giphyRes) => {
            console.log('[Proxy-GIF] Response status:', giphyRes.statusCode);
            if (giphyRes.statusCode !== 200) {
                return res.status(giphyRes.statusCode).send('Giphy returned error');
            }
            res.setHeader('Content-Type', giphyRes.headers['content-type'] || 'image/gif');
            if (giphyRes.headers['content-length']) {
                res.setHeader('Content-Length', giphyRes.headers['content-length']);
            }
            res.setHeader('Cache-Control', 'public, max-age=86400');
            giphyRes.pipe(res);
        }).on('error', (err) => {
            console.error('[Proxy-GIF] Request error:', err.message);
            res.status(500).send('Proxy error: ' + err.message);
        });
    } catch (e) {
        res.status(400).send('Invalid url');
    }
});

// Health check endpoint (for docker-compose monitoring)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
        version: '2.0.0',
    });
});

// ============ SERVER BOOT ============
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const httpServer = http.createServer(app);

httpServer.listen(PORT, HOST, () => {
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
