const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { requireAuth } = require('../services/shared');
const { fetchRoomData } = require('./rooms');

const https = require('https');

const TIMELINE_YEARS = Array.from({length: 51}, (_, i) => 2010 - i);

const aiService = require('../services/ai');

// Hızlı YouTube Video ID Arama (First Search Result)
async function getFirstYoutubeId(query) {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    try {
        const html = await new Promise((resolve, reject) => {
            const req = https.get(searchUrl, { 
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } 
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', (err) => reject(err));
            req.setTimeout(6000, () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
        
        const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        return match ? match[1] : '';
    } catch (e) {
        console.warn(`[TIMELINE] YouTube araması başarısız ("${query}"):`, e.message);
        return '';
    }
}

// Tüm kategoriler için video ID'lerini paralel gruplar halinde çözer
async function resolveYoutubeIdsForSummary(summary) {
    const items = [];
    
    if (Array.isArray(summary.music)) {
        summary.music.forEach(m => {
            items.push({ type: 'music', ref: m, query: `${m.artist} ${m.song} klip` });
        });
    }
    if (Array.isArray(summary.movies)) {
        summary.movies.forEach(m => {
            items.push({ type: 'movies', ref: m, query: `${m.title} fragman` });
        });
    }
    if (Array.isArray(summary.tv)) {
        summary.tv.forEach(t => {
            items.push({ type: 'tv', ref: t, query: `${t.title} jenerik` });
        });
    }
    if (Array.isArray(summary.games)) {
        summary.games.forEach(g => {
            items.push({ type: 'games', ref: g, query: `${g.title} gameplay` });
        });
    }
    // Gündem haberlerine görsel/video desteği
    if (Array.isArray(summary.turkey_news)) {
        summary.turkey_news.forEach(n => {
            if (typeof n === 'object' && n.title) {
                items.push({ type: 'turkey_news', ref: n, query: `${n.title} haber` });
            }
        });
    }
    if (Array.isArray(summary.world_news)) {
        summary.world_news.forEach(n => {
            if (typeof n === 'object' && n.title) {
                items.push({ type: 'world_news', ref: n, query: `${n.title} news` });
            }
        });
    }
    
    // Paralel grup çözümü (10'arlı gruplarla)
    const batchSize = 10;
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(async (item) => {
            const ytId = await getFirstYoutubeId(item.query);
            item.ref.youtubeId = ytId;
        }));
    }
}

// Helper to generate dynamic year summary from AI service
async function generateYearSummary(year) {
    if (!aiService.hasAiService) {
        console.warn(`[TIMELINE] AI servisi yapılandırılmamış, ${year} için varsayılan şablon kullanılıyor.`);
        return getFallbackSummary(year);
    }

    const promptText = `Türkiye'de ${year} yılında popüler kültürde damga vurmuş olayları, müzik hitlerini, popüler sinema filmlerini, televizyon programlarını/dizilerini, video oyunlarını ve önemli haber gündemlerini Türkçe olarak özetle.
    
    Özellikle ve ağırlıklı olarak Türkiye odaklı yerli içeriklere yer ver (yerli sanatçılar ve Türkçe şarkılar, Türk filmleri, Türk televizyon dizileri/programları, Türkiye gündemi gibi).

    Veri hacmini ve çeşitliliğini ZENGİNLEŞTİRMEK için:
    - Müzik bölümü için en az 30 hit şarkı (en az 24 tanesi yerli/Türkçe pop, rock, arabesk, fantezi vb. olsun, en fazla 6 tane çok popüler yabancı hit ekle),
    - Sinema için en az 15 popüler film (en az 10 tanesi yerli Türk filmi olsun),
    - TV için en az 15 popüler dizi veya televizyon programı (en az 12 tanesi yerli Türk yapımı olsun),
    - Oyun için en az 15 popüler video oyunu (o dönem Türkiye internet kafelerinde, atari salonlarında veya evlerinde en çok oynananlar),
    - Gündem için ise en az 15 Türkiye haberi (siyasi, sosyal, spor, kültürel) ve en az 12 dünya haberi döndür.

    Yanıtı mutlaka ve sadece aşağıdaki JSON şemasında dön, başka hiçbir açıklama yazma:
    {
      "music": [
        { "song": "Şarkı Adı", "artist": "Sanatçı Adı" }
      ],
      "movies": [
        { "title": "Film Adı", "director": "Yönetmen ve Detay" }
      ],
      "tv": [
        { "title": "Dizi/Program Adı", "channel": "Kanal ve Detay" }
      ],
      "games": [
        { "title": "Oyun Adı", "platform": "Platformlar" }
      ],
      "world_news": [
        { "title": "Dünyadan önemli olay ve detaylı açıklaması" }
      ],
      "turkey_news": [
        { "title": "Türkiye'den önemli olay ve detaylı açıklaması" }
      ]
    }`;

    try {
        const jsonText = await aiService.generateText({
            prompt: promptText,
            responseMimeType: 'application/json',
            model: 'gemini-2.5-flash'
        });

        const parsed = JSON.parse(jsonText.trim());
        
        // Sunucu tarafında YouTube araması yaparak gerçek video ID'lerini ekle
        console.log(`[TIMELINE] ${year} yılı için YouTube aramaları başlatılıyor...`);
        await resolveYoutubeIdsForSummary(parsed);
        console.log(`[TIMELINE] ${year} yılı için YouTube aramaları tamamlandı.`);
        
        return parsed;
    } catch (e) {
        console.error(`[TIMELINE] AI servis hatası (${year}):`, e.message);
        return getFallbackSummary(year);
    }
}

function getFallbackSummary(year) {
    return {
        music: [],
        movies: [],
        tv: [],
        games: [],
        world_news: [
            { "title": `${year} yılında dünyada önemli gelişmeler yaşandı, ancak şu an veri çekilemedi.`, "youtubeId": "" }
        ],
        turkey_news: [
            { "title": `${year} yılında Türkiye'de önemli olaylar oldu, ancak şu an veri çekilemedi.`, "youtubeId": "" }
        ]
    };
}

// ============ API ROUTES ============

// GET /api/timeline/years — Yıl listesini ve her yıldaki anı sayısını döner
router.get('/timeline/years', async (req, res) => {
    try {
        const counts = {};
        const rows = db.db.prepare(`SELECT year, count(*) as count FROM timeline_memories GROUP BY year`).all();
        for (const row of rows) {
            counts[row.year] = row.count;
        }

        const list = TIMELINE_YEARS.map(y => ({
            year: y,
            memoryCount: counts[y] || 0
        }));

        res.json({ success: true, years: list });
    } catch (err) {
        console.error('[API] /api/timeline/years hatası:', err);
        res.status(500).json({ success: false, error: 'Yıllar alınamadı' });
    }
});

// GET /api/timeline/year/:year — Yılın özetini ve anılarını çeker
router.get('/timeline/year/:year', async (req, res) => {
    const year = parseInt(req.params.year);
    if (!TIMELINE_YEARS.includes(year)) {
        return res.status(400).json({ success: false, error: 'Geçersiz yıl seçimi' });
    }

    try {
        // 1. Özet (Cache veya AI)
        let cached = await db.loadTimelineSummary(year);
        let summary;
        if (cached && cached.summary && Array.isArray(cached.summary.music) && cached.summary.music.length > 0) {
            summary = cached.summary;
        } else {
            summary = await generateYearSummary(year);
            if (summary && Array.isArray(summary.music) && summary.music.length > 0) {
                await db.saveTimelineSummary(year, summary);
            }
        }

        // 2. Anılar (Memories)
        const memories = await db.loadTimelineMemories(year);

        // 3. O yıla özel oda durum kontrolü
        const activeRooms = await fetchRoomData();
        const yearRoom = activeRooms.find(r => 
            r.name.includes(String(year)) || 
            (r.desc && r.desc.includes(String(year)))
        );

        res.json({
            success: true,
            year,
            summary,
            memories,
            activeRoom: yearRoom ? {
                name: yearRoom.name,
                participants: yearRoom.participants || 0
            } : null
        });
    } catch (err) {
        console.error(`[API] /api/timeline/year/${year} hatası:`, err);
        res.status(500).json({ success: false, error: 'Yıl detayları alınamadı' });
    }
});

// POST /api/timeline/memory — Yeni anı bırakır (Auth gereklidir)
router.post('/timeline/memory', requireAuth, async (req, res) => {
    if (req.user.role === 'guest') {
        return res.status(403).json({ success: false, error: 'Misafirler anı paylaşamaz — önce kayıt ol.' });
    }

    const { year, body } = req.body;
    const yearInt = parseInt(year);
    if (!TIMELINE_YEARS.includes(yearInt)) {
        return res.status(400).json({ success: false, error: 'Geçersiz yıl seçimi' });
    }

    if (!body || typeof body !== 'string' || !body.trim()) {
        return res.status(400).json({ success: false, error: 'Anı içeriği boş olamaz' });
    }

    const trimmed = body.trim().slice(0, 500); // Max 500 karakter
    const nick = req.user.nick;

    try {
        const memory = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            year: yearInt,
            nick,
            body: trimmed,
            reactions: { heart: [], sad: [], fire: [] },
            createdAt: new Date().toISOString()
        };

        await db.saveTimelineMemory(memory);
        res.json({ success: true, memory });
    } catch (err) {
        console.error('[API] /api/timeline/memory hatası:', err);
        res.status(500).json({ success: false, error: 'Anı paylaşılamadı' });
    }
});

// POST /api/timeline/memory/:id/react — Anıya reaksiyon bırakır (Auth gereklidir)
router.post('/timeline/memory/:id/react', requireAuth, async (req, res) => {
    const id = req.params.id;
    const { type } = req.body; // 'heart', 'sad', 'fire'
    const validTypes = ['heart', 'sad', 'fire'];

    if (!validTypes.includes(type)) {
        return res.status(400).json({ success: false, error: 'Geçersiz reaksiyon tipi' });
    }

    const nick = req.user.nick;

    try {
        // Anıyı bul
        const row = db.db.prepare(`SELECT * FROM timeline_memories WHERE id = ?`).get(id);
        if (!row) {
            return res.status(404).json({ success: false, error: 'Anı bulunamadı' });
        }

        const reactions = row.reactions ? JSON.parse(row.reactions) : { heart: [], sad: [], fire: [] };
        if (!reactions[type]) reactions[type] = [];

        const index = reactions[type].indexOf(nick);
        if (index > -1) {
            // Zaten reaksiyon vermiş, kaldır
            reactions[type].splice(index, 1);
        } else {
            // Reaksiyon yok, ekle
            reactions[type].push(nick);
        }

        await db.updateTimelineMemoryReactions(id, reactions);
        res.json({ success: true, reactions });
    } catch (err) {
        console.error('[API] /api/timeline/memory/react hatası:', err);
        res.status(500).json({ success: false, error: 'Reaksiyon eklenemedi' });
    }
});

module.exports = router;

module.exports.generateYearSummary = generateYearSummary;
module.exports.resolveYoutubeIdsForSummary = resolveYoutubeIdsForSummary;
