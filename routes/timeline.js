const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { requireAuth } = require('../services/shared');
const { fetchRoomData } = require('./rooms');

const https = require('https');

const TIMELINE_YEARS = Array.from({length: 51}, (_, i) => 2010 - i);

const aiService = require('../services/ai');

const activeResolutions = new Set();

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
            req.setTimeout(2500, () => { // 2.5s limit to prevent hanging
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

// Haber başlıklarından YouTube araması için temiz ve kısa sorgu üretir
function cleanNewsQuery(title) {
    if (!title) return '';
    // Colon, dash, period ile bölüp ilk kısmı al
    let clean = title.split(/[:\-\.]/)[0].trim();
    if (clean.length < 15 && title.includes(':')) {
        // İlk kısım çok kısaysa tamamını kullan
        clean = title.trim();
    }
    return clean.slice(0, 80).trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tüm kategoriler için video ID'lerini paralel gruplar halinde çözer
async function resolveYoutubeIdsForSummary(summary) {
    const items = [];
    
    if (Array.isArray(summary.music)) {
        summary.music.forEach(m => {
            if (m.youtubeId === undefined) {
                items.push({ type: 'music', ref: m, query: `${m.artist} ${m.song} klip` });
            }
        });
    }
    if (Array.isArray(summary.movies)) {
        summary.movies.forEach(m => {
            if (m.youtubeId === undefined) {
                items.push({ type: 'movies', ref: m, query: `${m.title} fragman` });
            }
        });
    }
    if (Array.isArray(summary.tv)) {
        summary.tv.forEach(t => {
            if (t.youtubeId === undefined) {
                items.push({ type: 'tv', ref: t, query: `${t.title} jenerik` });
            }
        });
    }
    if (Array.isArray(summary.games)) {
        summary.games.forEach(g => {
            if (g.youtubeId === undefined) {
                items.push({ type: 'games', ref: g, query: `${g.title} gameplay` });
            }
        });
    }
    // Gündem haberlerine görsel/video desteği (temizlenmiş sorgularla)
    if (Array.isArray(summary.turkey_news)) {
        summary.turkey_news.forEach(n => {
            if (typeof n === 'object' && n.title && n.youtubeId === undefined) {
                const cleanTitle = cleanNewsQuery(n.title);
                items.push({ type: 'turkey_news', ref: n, query: `${cleanTitle} haber` });
            }
        });
    }
    if (Array.isArray(summary.world_news)) {
        summary.world_news.forEach(n => {
            if (typeof n === 'object' && n.title && n.youtubeId === undefined) {
                const cleanTitle = cleanNewsQuery(n.title);
                items.push({ type: 'world_news', ref: n, query: `${cleanTitle} news` });
            }
        });
    }
    
    // Paralel grup çözümü (8'li gruplarla, 400ms bekleme ile YouTube rate limit'i engellenir)
    const batchSize = 8;
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(async (item) => {
            const ytId = await getFirstYoutubeId(item.query);
            item.ref.youtubeId = ytId;
        }));
        if (i + batchSize < items.length) {
            await sleep(400);
        }
    }
}

// Helper to generate dynamic year summary from AI service
async function generateYearSummary(year) {
    const provider = process.env.TIMELINE_AI_PROVIDER || 'gemini';
    const apiKey = process.env.TIMELINE_AI_KEY;
    const baseUrl = process.env.TIMELINE_AI_BASE_URL;
    const model = process.env.TIMELINE_AI_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');

    const hasTimelineAi = apiKey || aiService.hasAiService;

    if (!hasTimelineAi) {
        console.warn(`[TIMELINE] AI servisi yapılandırılmamış, ${year} için varsayılan şablon kullanılıyor.`);
        return getFallbackSummary(year);
    }

    const promptText = `Türkiye'de ${year} yılında popüler kültürde damga vurmuş olayları, müzik hitlerini, popüler sinema filmlerini, televizyon programlarını/dizilerini, video oyunlarını ve önemli haber gündemlerini Türkçe olarak özetle.
    
    Özellikle ve ağırlıklı olarak Türkiye odaklı yerli içeriklere yer ver (yerli sanatçılar ve Türkçe şarkılar, Türk filmleri, Türk televizyon dizileri/programları, Türkiye gündemi gibi).

    Veri büyüklüğünü dengeli tutmak ve kota sınırlarını aşmamak için şu sayılara sadık kal:
    - Müzik: En az 16 hit şarkı (en az 12 yerli, en fazla 4 yabancı),
    - Sinema: En az 10 popüler film (en az 7 yerli),
    - TV: En az 10 popüler dizi veya televizyon programı (en az 8 yerli),
    - Oyun: En az 10 popüler video oyunu,
    - Gündem: En az 10 Türkiye haberi ve en az 8 dünya haberi döndür.

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
            model: model,
            apiKey: apiKey,
            baseUrl: baseUrl
        });

        const parsed = JSON.parse(jsonText.trim());
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

// GET & POST /api/timeline/resolve-item — Tıklanan öğenin YouTube ID'sini bulur ve kalıcı olarak DB'ye kaydeder (Self-learning Cache)
router.all('/timeline/resolve-item', async (req, res) => {
    const year = req.method === 'POST' ? req.body.year : req.query.year;
    const category = req.method === 'POST' ? req.body.category : req.query.category;
    const index = req.method === 'POST' ? req.body.index : req.query.index;
    const query = req.method === 'POST' ? req.body.query : (req.query.q || req.query.query);

    const yearInt = parseInt(year);
    if (!yearInt || !category || index === undefined || !query) {
        return res.status(400).json({ success: false, error: 'Parametreler eksik' });
    }

    try {
        const ytId = await getFirstYoutubeId(query);
        
        // Veritabanındaki özeti güncelle ve kalıcı kaydet
        let cached = await db.loadTimelineSummary(yearInt);
        if (cached && cached.summary) {
            const summary = cached.summary;
            const list = summary[category];
            const idx = parseInt(index);
            if (list && list[idx]) {
                list[idx].youtubeId = ytId;
                await db.saveTimelineSummary(yearInt, summary);
                console.log(`[TIMELINE] Kalıcı Önbellek Güncellendi: ${yearInt} ${category}[${idx}] -> youtubeId: ${ytId}`);
            }
        }

        res.json({ success: true, youtubeId: ytId });
    } catch (err) {
        console.error('[API] /api/timeline/resolve-item hatası:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

async function searchWikiImageLang(query, lang = 'tr') {
    try {
        const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=5`;
        const searchJson = await new Promise((resolve, reject) => {
            const req = https.get(searchUrl, {
                headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
        
        const searchData = JSON.parse(searchJson);
        const searchResults = searchData.query?.search || [];
        if (searchResults.length === 0) return null;

        const titlesParam = searchResults.map(r => r.title).join('|');
        const imgUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titlesParam)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`;
        
        const imgJson = await new Promise((resolve, reject) => {
            const req = https.get(imgUrl, {
                headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
        
        const imgData = JSON.parse(imgJson);
        const pages = imgData.query?.pages || {};
        
        for (const result of searchResults) {
            const page = Object.values(pages).find(p => p.title === result.title);
            if (page && page.thumbnail && page.thumbnail.source) {
                return page.thumbnail.source;
            }
        }
        return null;
    } catch (e) {
        console.warn(`[TIMELINE-WIKI-IMAGE] Wikipedia search failed for lang=${lang}:`, e.message);
        return null;
    }
}

// Dynamic Wikipedia Image Search (Keyless API)
async function searchImageWikipedia(query) {
    // Try Turkish Wikipedia first
    let url = await searchWikiImageLang(query, 'tr');
    if (url) return url;
    // Fallback to English Wikipedia
    return await searchWikiImageLang(query, 'en');
}

// GET /api/timeline/details — Tıklanan öğenin ansiklopedik detaylarını ve görselini döner (Dynamic Encyclopedia)
// Helper to fetch rich details from Wikipedia (Keyless search and extract)
async function fetchWikipediaDetails(title) {
    try {
        const searchUrl = `https://tr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&utf8=1&format=json`;
        const searchJson = await new Promise((resolve, reject) => {
            const req = require('https').get(searchUrl, {
                headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
        
        const searchData = JSON.parse(searchJson);
        let matchedTitle = title;
        if (searchData.query && searchData.query.search && searchData.query.search.length > 0) {
            matchedTitle = searchData.query.search[0].title;
        }

        const detailUrl = `https://tr.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(matchedTitle)}&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1`;
        const detailJson = await new Promise((resolve, reject) => {
            const req = require('https').get(detailUrl, {
                headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
        });

        const detailData = JSON.parse(detailJson);
        let extract = '';
        if (detailData.query && detailData.query.pages) {
            const pages = detailData.query.pages;
            for (const key in pages) {
                if (pages[key].extract) {
                    extract = pages[key].extract.trim();
                    break;
                }
            }
        }
        
        if (!extract) {
            const enSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&utf8=1&format=json`;
            const enSearchJson = await new Promise((resolve, reject) => {
                const req = require('https').get(enSearchUrl, {
                    headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('error', reject);
                req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
            });
            
            const enSearchData = JSON.parse(enSearchJson);
            if (enSearchData.query && enSearchData.query.search && enSearchData.query.search.length > 0) {
                const enTitle = enSearchData.query.search[0].title;
                const enDetailUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enTitle)}&prop=extracts&exintro=1&explaintext=1&format=json&redirects=1`;
                const enDetailJson = await new Promise((resolve, reject) => {
                    const req = require('https').get(enDetailUrl, {
                        headers: { 'User-Agent': 'RetroSeslerTimeline/1.0 (http://retrosesler.com; info@retrosesler.com)' }
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(data));
                    });
                    req.on('error', reject);
                    req.setTimeout(2000, () => { req.destroy(); reject(new Error('Timeout')); });
                });

                const enDetailData = JSON.parse(enDetailJson);
                if (enDetailData.query && enDetailData.query.pages) {
                    const enPages = enDetailData.query.pages;
                    for (const key in enPages) {
                        if (enPages[key].extract) {
                            extract = enPages[key].extract.trim();
                            break;
                        }
                    }
                }
            }
        }
        return extract || null;
    } catch (e) {
        console.error('[TIMELINE-WIKI-SUMMARY] Wikipedia extract failed for:', title, e.message);
        return null;
    }
}

// Duplicate fetchWikipediaDetails function removed (single declaration at top is used)

// GET /api/timeline/details — Tıklanan öğenin ansiklopedik detaylarını ve görselini döner (Dynamic Encyclopedia)
router.get('/timeline/details', async (req, res) => {
    const { year, category, title, youtubeId } = req.query;
    if (!year || !category || !title) {
        return res.status(400).json({ success: false, error: 'Parametreler eksik' });
    }

    const queryKey = `${year}_${category}_${title}`.trim().toLowerCase();

    try {
        // Sunucu taraflı yedek youtubeId çözme (Cache asenkron çalıştığından istemci eski boş ID yollayabilir)
        let resolvedYtId = youtubeId || '';
        if (!resolvedYtId) {
            const cachedSummary = await db.loadTimelineSummary(parseInt(year));
            if (cachedSummary && cachedSummary.summary) {
                const list = cachedSummary.summary[category];
                if (Array.isArray(list)) {
                    const item = list.find(i => {
                        const itemTitleTest = category === 'music' ? `${i.artist} - ${i.song}` : (i.title || '');
                        return itemTitleTest.toLowerCase() === title.toLowerCase();
                    });
                    if (item && item.youtubeId) {
                        resolvedYtId = item.youtubeId;
                    }
                }
            }
        }

        // Eğer hala YouTube ID'si yoksa dinamik olarak ara ve bul
        if (!resolvedYtId) {
            try {
                const searchQ = category === 'music' ? `${title} klip` : (category === 'movies' ? `${title} fragman` : (category === 'tv' ? `${title} jenerik` : `${title} gameplay`));
                resolvedYtId = await getFirstYoutubeId(searchQ);
            } catch (ytErr) {
                console.warn('[TIMELINE-DETAILS] Dynamic YouTube ID search failed:', ytErr.message);
            }
        }

        // 1. Önbellekten kontrol et
        const cached = await db.loadTimelineDetails(queryKey);
        if (cached && cached.details) {
            // Önbellekte görsel yoksa ve resolvedYtId varsa, youtube görselini atayarak canlandır
            if (!cached.details.image && resolvedYtId) {
                cached.details.image = `https://img.youtube.com/vi/${resolvedYtId}/mqdefault.jpg`;
            }
            // Dynamic sync of resolvedYtId to cached item if it was missing in cache
            if (!cached.details.youtubeId && resolvedYtId) {
                cached.details.youtubeId = resolvedYtId;
                await db.saveTimelineDetails(queryKey, cached.details);
            }
            if (cached.details.nostalgia_score === undefined) {
                let hash = 0;
                for (let i = 0; i < title.length; i++) {
                    hash = title.charCodeAt(i) + ((hash << 5) - hash);
                }
                cached.details.nostalgia_score = 82 + (Math.abs(hash) % 17);
            }
            return res.json({ success: true, details: cached.details });
        }

        // 2. Önbellekte yoksa, Gemini ile ansiklopedik detay üret
        const provider = process.env.TIMELINE_AI_PROVIDER || 'gemini';
        const apiKey = process.env.TIMELINE_AI_KEY;
        const baseUrl = process.env.TIMELINE_AI_BASE_URL;
        const model = process.env.TIMELINE_AI_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');

        const promptText = `Türkiye'de ve dünyada ${year} yılında popüler olan "${title}" isimli retro öğe (kategori: ${category}) hakkında nostaljik ve ilgi çekici ansiklopedik detaylar sağla.
        
Açıklamaları tamamen Türkçe ve çok sıcak, samimi, nostaljik bir dille yaz.
 
Yanıtı mutlaka ve sadece aşağıdaki JSON şemasında dön, başka hiçbir açıklama veya markdown bloğu yazma:
{
  "description": "Öğenin ne olduğunu, o dönem neden bu kadar sevildiğini ve yarattığı etkiyi anlatan 2-3 cümlelik nostaljik açıklama.",
  "key_figures": ["Bu öğeyle özdeşleşmiş en önemli 2-3 kişi, oyuncu, yönetmen, sanatçı, yapımcı, futbolcu veya karakter ismi"],
  "fun_fact": "Öğe hakkında çok az bilinen, şaşırtıcı ve nostaljik 1 cümlelik ilginç bilgi.",
  "nostalgia_score": 85, // 0 ile 100 arasında bu öğenin retro/nostalji derecesini (bugün hissettirdiği özlemi/etkiyi) temsil eden tam sayı skoru
  "image_search_query": "Bu öğenin orijinal retro görselini (film afişi, albüm kapağı, oyun kutusu veya tarihi fotoğraf) bulmak için kullanılacak İngilizce net bir arama sorgusu (örneğin: 'Hababam Sınıfı 1975 film poster' veya 'Baris Manco album cover')"
}`;

        let hashVal = 0;
        for (let i = 0; i < title.length; i++) {
            hashVal = title.charCodeAt(i) + ((hashVal << 5) - hashVal);
        }
        const fallbackScore = 82 + (Math.abs(hashVal) % 17);

        let detailsObj = {
            description: `"${title}", ${year} yılının en sevilen dots`.replace('dots', category === 'music' ? 'şarkılarından' : category === 'movies' ? 'filmlerinden' : category === 'tv' ? 'programlarından' : category === 'games' ? 'oyunlarından' : 'olaylarından') + ' biriydi.',
            key_figures: [],
            fun_fact: "Nostalji rüzgarlarını hissetmek için oynat butonuna basabilirsiniz.",
            nostalgia_score: fallbackScore,
            image_search_query: title,
            youtubeId: resolvedYtId
        };

        // Load timeline summary to extract metadata for rich fallback enrichment
        let artistName = '';
        let directorName = '';
        let platformName = '';
        let channelName = '';
        try {
            const cachedSummary = await db.loadTimelineSummary(parseInt(year));
            if (cachedSummary && cachedSummary.summary) {
                const list = cachedSummary.summary[category];
                if (Array.isArray(list)) {
                    const item = list.find(i => {
                        const itemTitleTest = category === 'music' ? `${i.artist} - dots`.replace('dots', i.song) : (i.title || '');
                        return itemTitleTest.toLowerCase() === title.toLowerCase();
                    });
                    if (item) {
                        if (category === 'music') artistName = item.artist;
                        if (category === 'movies') directorName = item.director;
                        if (category === 'games') platformName = item.platform;
                        if (category === 'tv') channelName = item.channel;
                    }
                }
            }
        } catch (sumErr) {
            console.warn('[TIMELINE-DETAILS] Summary extraction failed for fallback enrichment:', sumErr.message);
        }

        // Enrich fallback fields contextually
        if (artistName) {
            detailsObj.key_figures = [artistName];
            detailsObj.fun_fact = `${artistName} tarafından seslendirilen bu eser, o yıl müzik listelerinde haftalarca bir numarada kaldı.`;
        } else if (directorName) {
            detailsObj.key_figures = [directorName];
            detailsObj.fun_fact = `${directorName} imzasını taşıyan bu yapıt, o dönem sinema salonlarında büyük ilgi görmüştü.`;
        } else if (platformName) {
            detailsObj.fun_fact = `Bu popüler video oyunu, o dönem ${platformName} platformları üzerinde fırtınalar estiriyordu.`;
        } else if (channelName) {
            detailsObj.fun_fact = `Bu yapım, o yıllarda ${channelName} ekranlarında izleyicileri ekran başına kilitleyen en popüler içeriklerden biriydi.`;
        }

        const hasTimelineAi = apiKey || aiService.hasAiService;
        let aiSuccess = false;
        if (hasTimelineAi) {
            try {
                const jsonText = await aiService.generateText({
                    prompt: promptText,
                    responseMimeType: 'application/json',
                    model: model,
                    apiKey: apiKey,
                    baseUrl: baseUrl
                });
                const parsed = JSON.parse(jsonText.trim());
                if (parsed && parsed.description) {
                    detailsObj = {
                        ...detailsObj,
                        ...parsed,
                        nostalgia_score: parsed.nostalgia_score !== undefined ? parseInt(parsed.nostalgia_score) : fallbackScore,
                        youtubeId: resolvedYtId
                    };
                    aiSuccess = true;
                }
            } catch (aiErr) {
                console.error('[TIMELINE-DETAILS] AI generation failed, using fallback text:', aiErr.message);
            }
        }

        // If AI generation failed, use Wikipedia to fetch rich details!
        if (!aiSuccess) {
            console.log(`[TIMELINE-DETAILS] AI başarısız oldu veya kapatıldı, "${title}" için Wikipedia'dan zengin veri çekiliyor...`);
            const wikiExtract = await fetchWikipediaDetails(title);
            if (wikiExtract) {
                let cleanExtract = wikiExtract;
                if (cleanExtract.length > 550) {
                    cleanExtract = cleanExtract.slice(0, 550).trim();
                    const lastPeriod = cleanExtract.lastIndexOf('.');
                    if (lastPeriod > 300) {
                        cleanExtract = cleanExtract.slice(0, lastPeriod + 1);
                    } else {
                        cleanExtract = cleanExtract + '...';
                    }
                }
                detailsObj.description = cleanExtract;
            }
        }

        // 3. Görsel arama sorgusunu kullanarak görsel bul (Wikipedia ve YouTube Önizleme desteğiyle)
        const searchPhrase = detailsObj.image_search_query || title;
        let imageUrl = await searchImageWikipedia(searchPhrase);
        
        // Eğer her ikisi de bulamadıysa ve resolvedYtId varsa, youtube video önizlemesini kullan
        if (!imageUrl && resolvedYtId) {
            imageUrl = `https://img.youtube.com/vi/${resolvedYtId}/mqdefault.jpg`;
        }
        
        detailsObj.image = imageUrl || '';

        // 4. Veritabanına kaydet
        await db.saveTimelineDetails(queryKey, detailsObj);

        res.json({ success: true, details: detailsObj });
    } catch (err) {
        console.error('[API] /api/timeline/details hatası:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/timeline/year/:year', async (req, res) => {
    const year = parseInt(req.params.year);
    if (!TIMELINE_YEARS.includes(year)) {
        return res.status(400).json({ success: false, error: 'Geçersiz yıl seçimi' });
    }

    try {
        // 1. Özet (Cache veya AI veya Seed)
        let cached = await db.loadTimelineSummary(year);
        let summary;
        
        // Önbellek kontrolü ve Eski/Eksik verileri otomatik yükseltme (Sparse cache check)
        const isSparse = cached && cached.summary && (
            !Array.isArray(cached.summary.music) || cached.summary.music.length < 8 ||
            !Array.isArray(cached.summary.turkey_news) || cached.summary.turkey_news.length < 4
        );

        let cacheSaved = true;

        if (cached && cached.summary && !isSparse && req.query.force !== 'true') {
            summary = cached.summary;
        } else {
            // Yapay zeka kullanılabilir mi kontrol et
            const provider = process.env.TIMELINE_AI_PROVIDER || 'gemini';
            const apiKey = process.env.TIMELINE_AI_KEY;
            const hasTimelineAi = apiKey || aiService.hasAiService;

            let aiSuccess = false;

            if (hasTimelineAi && req.query.force_seed !== 'true') {
                console.log(`[TIMELINE] ${year} yılı verisi eksik veya eski formatta. Yapay zeka ile üretiliyor...`);
                try {
                    summary = await generateYearSummary(year);
                    // Yapay zekanın boş/yedek veri döndürmediğini kontrol et
                    if (summary && Array.isArray(summary.music) && summary.music.length > 0) {
                        await db.saveTimelineSummary(year, summary);
                        aiSuccess = true;
                        console.log(`[TIMELINE] ${year} yılı verisi yapay zeka ile başarıyla üretildi ve SQLite'a kaydedildi.`);
                    }
                } catch (aiErr) {
                    console.error(`[TIMELINE] Yapay zeka üretimi başarısız (${year}):`, aiErr.message);
                }
            }

            // AI başarısız olduysa veya yoksa statik seed dosyasına geri dön
            if (!aiSuccess) {
                const fs = require('fs');
                const path = require('path');
                const seedPath = path.join(__dirname, '..', 'data', 'timeline_seed.json');
                let seededData = null;
                if (fs.existsSync(seedPath)) {
                    try {
                        const rawSeeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
                        if (rawSeeds && rawSeeds[year]) {
                            seededData = rawSeeds[year];
                            console.log(`[TIMELINE] ${year} yılı verisi statik seed dosyasından yüklendi.`);
                        }
                    } catch (e) {
                        console.warn('[TIMELINE] Seed file parse failed:', e.message);
                    }
                }

                if (seededData) {
                    summary = seededData;
                    cacheSaved = false; // Background YouTube ID resolution and save will trigger
                } else {
                    summary = getFallbackSummary(year);
                    cacheSaved = false;
                }
            }
        }

        // Arka planda eksik olan YouTube ID'lerini çözüp önbelleği güncelleyen mekanizma (Self-healing Cache)
        let needsResolve = false;
        const categoriesToCheck = ['music', 'movies', 'tv', 'games'];
        for (const cat of categoriesToCheck) {
            if (Array.isArray(summary[cat])) {
                for (const item of summary[cat]) {
                    if (item.youtubeId === undefined) {
                        needsResolve = true;
                        break;
                    }
                }
            }
            if (needsResolve) break;
        }

        if ((needsResolve || !cacheSaved) && !activeResolutions.has(year)) {
            activeResolutions.add(year);
            console.log(`[TIMELINE] ${year} yılı özetinde eksik YouTube video ID'leri tespit edildi. Arka planda çözülüyor...`);
            resolveYoutubeIdsForSummary(summary).then(async () => {
                await db.saveTimelineSummary(year, summary);
                console.log(`[TIMELINE] ${year} yılı özetindeki tüm YouTube ID'leri başarıyla çözüldü ve SQLite'a kalıcı kaydedildi.`);
            }).catch((err) => {
                console.error(`[TIMELINE-AUTO-RESOLVER] Arka plan çözümü başarısız (${year}):`, err.message);
            }).finally(() => {
                activeResolutions.delete(year);
            });
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

const TURKISH_MONTHS = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

function cleanWikiQuery(title) {
    if (!title) return '';
    // Emojileri temizle
    let clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, "").trim();
    // Colon, dash, period, exclamation mark, question mark ile bölüp ilk kısmı al
    clean = clean.split(/[:\-\.!?]/)[0].trim();
    if (clean.length < 10 && title.includes(':')) {
        clean = title.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, "").trim();
    }
    return clean.slice(0, 80).trim();
}

// Gazete görselini Wikipedia'dan manşet başlığına göre çözen yardımcı fonksiyon
async function resolveHistoryImage(data) {
    if (!data) return data;
    
    // 1. Manşet Haber Görselleri
    if (data.headlines && Array.isArray(data.headlines)) {
        for (const hl of data.headlines) {
            if (!hl.image) {
                try {
                    const cleanQuery = cleanWikiQuery(hl.title);
                    hl.image = await searchImageWikipedia(cleanQuery) || '';
                } catch (e) {
                    hl.image = '';
                }
            }
        }
        if (!data.image && data.headlines[0] && data.headlines[0].image) {
            data.image = data.headlines[0].image;
        }
    }

    // 2. Spor Görselleri
    if (data.sports && Array.isArray(data.sports)) {
        for (const sp of data.sports) {
            if (!sp.image) {
                try {
                    const cleanQuery = cleanWikiQuery(sp.title);
                    sp.image = await searchImageWikipedia(cleanQuery) || '';
                } catch (e) {
                    sp.image = '';
                }
            }
        }
        if (!data.sports_image && data.sports[0] && data.sports[0].image) {
            data.sports_image = data.sports[0].image;
        }
    }

    // 3. TV Rehberi Görselleri
    if (data.tv_guide && Array.isArray(data.tv_guide)) {
        for (const tv of data.tv_guide) {
            if (!tv.image) {
                try {
                    const cleanQuery = cleanWikiQuery(tv.title);
                    tv.image = await searchImageWikipedia(cleanQuery) || '';
                } catch (e) {
                    tv.image = '';
                }
            }
        }
    }

    // 4. Müzik Hitleri Görselleri
    if (data.top_hits && Array.isArray(data.top_hits)) {
        for (const hit of data.top_hits) {
            if (!hit.image && hit.youtubeId) {
                hit.image = `https://img.youtube.com/vi/${hit.youtubeId}/mqdefault.jpg`;
            }
        }
    }

    return data;
}

// GET /api/timeline/today-20-years-ago — 20 yıl önce veya belirli bir tarihteki gazete verisini getirir
router.get('/timeline/today-20-years-ago', async (req, res) => {
    try {
        let dateKey;
        let targetDate;
        
        if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
            dateKey = req.query.date;
            const parts = dateKey.split('-');
            targetDate = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
        } else {
            const nowStr = new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" });
            const turkeyDate = new Date(nowStr);
            const year20 = turkeyDate.getFullYear() - 20;
            const monthNum = turkeyDate.getMonth();
            const monthStr = String(monthNum + 1).padStart(2, '0');
            const dayStr = String(turkeyDate.getDate()).padStart(2, '0');
            dateKey = `${year20}-${monthStr}-${dayStr}`;
            targetDate = new Date(Date.UTC(year20, monthNum, turkeyDate.getDate()));
        }

        const targetYear = targetDate.getUTCFullYear();
        const monthNum = targetDate.getUTCMonth();
        const readableDate = `${targetDate.getUTCDate()} ${TURKISH_MONTHS[monthNum]} ${targetYear}`;

        // 1. Önbelleği kontrol et
        const cached = await db.loadTimelineHistory20(dateKey);
        if (cached && cached.data) {
            let updated = false;
            
            // Alt öğelerde resim eksiği var mı kontrol et
            let needsResolution = false;
            if (cached.data.headlines && Array.isArray(cached.data.headlines)) {
                for (const hl of cached.data.headlines) {
                    if (!hl.image) { needsResolution = true; break; }
                }
            }
            if (cached.data.sports && Array.isArray(cached.data.sports)) {
                for (const sp of cached.data.sports) {
                    if (!sp.image) { needsResolution = true; break; }
                }
            }
            if (cached.data.tv_guide && Array.isArray(cached.data.tv_guide)) {
                for (const tv of cached.data.tv_guide) {
                    if (!tv.image) { needsResolution = true; break; }
                }
            }
            if (cached.data.top_hits && Array.isArray(cached.data.top_hits)) {
                for (const hit of cached.data.top_hits) {
                    if (!hit.image && hit.youtubeId) { needsResolution = true; break; }
                }
            }

            if (needsResolution || !cached.data.image || !cached.data.sports_image) {
                await resolveHistoryImage(cached.data);
                updated = true;
            }

            if (updated) {
                await db.saveTimelineHistory20(dateKey, cached.data);
            }
            return res.json({ success: true, dateKey, readableDate, data: cached.data });
        }

        // 2. Önbellekte yoksa AI ile üret
        const provider = process.env.TIMELINE_AI_PROVIDER || 'gemini';
        const apiKey = process.env.TIMELINE_AI_KEY;
        const baseUrl = process.env.TIMELINE_AI_BASE_URL;
        const model = process.env.TIMELINE_AI_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');

        const hasTimelineAi = apiKey || aiService.hasAiService;
        if (!hasTimelineAi) {
            console.warn(`[TIMELINE] AI servisi yapılandırılmamış, 20 yıl öncesi için yedek veri kullanılıyor.`);
            const fallback = getFallbackHistory20(targetYear, readableDate);
            await resolveHistoryImage(fallback);
            return res.json({ success: true, dateKey, readableDate, data: fallback });
        }

        const promptText = `Sen RetroSesler platformu için çalışan bir Nostalji Tarihçisisin.
Görevin, tam olarak ${readableDate} tarihindeki tarihi ve nostaljik bilgileri derlemektir.
Lütfen o tarihteki (veya o haftaki/aydaki) şu bilgileri oluştur:
1. Hava Durumu (weather): İstanbul, Ankara ve İzmir için o tarihe ait gerçek veya mevsime uygun çok gerçekçi sıcaklık ve hava durumu açıklamaları.
2. Manşet Haberler (headlines): O tarihte veya o günlerde Türkiye'de ve dünyada yankı uyandıran 3 önemli gerçek haber başlığı ve kısa (1-2 cümlelik) nostaljik detayları.
3. Spor Gelişmeleri (sports): O dönemdeki spor gelişmeleri (örn. lig durumları, kupalar, transferler veya o günün önemli spor olayları) hakkında 2-3 başlık ve detayı.
4. Haftanın Müzik Hitleri (top_hits): O hafta Türkiye'de en çok dinlenen ve popüler olan 3 hit Türkçe şarkı (sanatçı adı, şarkı adı ve YouTube'da klibini aratmak için kullanılacak query örn: "Tarkan Kuzu Kuzu klip").
5. Televizyon Yayınları (tv_guide): O gün Türkiye televizyonlarında yayınlanan popüler akşam kuşağı (prime time) 3 büyük kanalın dizi/program bilgisi (örn: Kanal D, Show TV, ATV kanallarında o tarihte yayınlanan popüler diziler ve kısa açıklaması).

Lütfen yanıtı mutlaka ve sadece aşağıdaki JSON formatında dön, başka hiçbir açıklama veya markdown bloğu yazma:
{
  "weather": [
    { "city": "İstanbul", "temp": "24°C", "condition": "Güneşli", "desc": "Hafif rüzgarlı şık bir yaz günü..." },
    { "city": "Ankara", "temp": "22°C", "condition": "Açık", "desc": "Gündüz sıcaklığı yerini serin bir akşama bırakıyor..." },
    { "city": "İzmir", "temp": "28°C", "condition": "Sıcak", "desc": "Kordon boyunda meltem rüzgarları esiyor..." }
  ],
  "headlines": [
    { "title": "Haber Başlığı", "desc": "Nostaljik haber açıklaması." }
  ],
  "sports": [
    { "title": "Spor Başlığı", "desc": "Spor haberi açıklaması." }
  ],
  "top_hits": [
    { "song": "Şarkı Adı", "artist": "Sanatçı Adı", "youtube_query": "Sanatçı Adı - Şarkı Adı klip" }
  ],
  "tv_guide": [
    { "channel": "Kanal D", "time": "20:00", "title": "Dizi/Program Adı", "desc": "Televizyon yayını/dizi açıklaması." }
  ]
}`;

        try {
            const jsonText = await aiService.generateText({
                prompt: promptText,
                responseMimeType: 'application/json',
                model: model,
                apiKey: apiKey,
                baseUrl: baseUrl
            });

            const data = JSON.parse(jsonText.trim());
            
            // Popüler hitler için YouTube ID'lerini çöz
            if (data && Array.isArray(data.top_hits)) {
                await Promise.all(data.top_hits.map(async (hit) => {
                    const q = hit.youtube_query || `${hit.artist} ${hit.song} klip`;
                    hit.youtubeId = await getFirstYoutubeId(q);
                }));
            }

            await resolveHistoryImage(data);
            await db.saveTimelineHistory20(dateKey, data);
            res.json({ success: true, dateKey, readableDate, data });
        } catch (aiErr) {
            console.error('[TIMELINE-HISTORY20] AI generation failed, using fallback:', aiErr.message);
            const fallback = getFallbackHistory20(targetYear, readableDate);
            await resolveHistoryImage(fallback);
            res.json({ success: true, dateKey, readableDate, data: fallback });
        }
    } catch (err) {
        console.error('[API] /api/timeline/today-20-years-ago hatası:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

function getFallbackHistory20(year, readableDate) {
    const defaultWeather = [
        { city: "İstanbul", temp: "22°C", condition: "Parçalı Bulutlu", desc: "Mevsim normallerinde tatlı bir retro esintisi..." },
        { city: "Ankara", temp: "19°C", condition: "Açık", desc: "Kuru ve serin Ankara akşamları..." },
        { city: "İzmir", temp: "26°C", condition: "Güneşli", desc: "Ege havası içimizi ısıtmaya devam ediyor..." }
    ];

    if (year < 1970) {
        // 1960'lar
        return {
            weather: defaultWeather,
            headlines: [
                { title: "Kıbrıs Meselesi Gündemde", desc: "Ada genelinde gerginlik tırmanırken diplomatik temaslar sıkılaştırıldı." },
                { title: "İTÜ Televizyonu Deneysel Yayında", desc: "İstanbul Teknik Üniversitesi'nin televizyon yayın denemeleri büyük ilgi topluyor." },
                { title: "Yerli Sanayi Hamlesi", desc: "Türkiye genelinde yerli üretimi teşvik eden yeni sanayi adımları atılıyor." }
            ],
            sports: [
                { title: "Metin Oktay Rüzgarı Esiyor", desc: "Galatasaray'ın efsane golcüsü şık golleriyle ligde zirveyi zorluyor." },
                { title: "Fenerbahçe-Beşiktaş Rekabeti", desc: "Zorlu derbi mücadelesinde tribünler tarihi katılım sağladı." }
            ],
            top_hits: [
                { song: "Samanyolu", artist: "Berkant", youtube_query: "Berkant - Samanyolu klip", youtubeId: "bO10d0Qh2s8" },
                { song: "Her Yerde Kar Var", artist: "Salvatore Adamo", youtube_query: "Salvatore Adamo - Her Yerde Kar Var", youtubeId: "V5iU_rW-48Y" },
                { song: "Deniz Üstü Köpürür", artist: "Cem Karaca", youtube_query: "Cem Karaca - Deniz Ustü Kopurur", youtubeId: "ZleB9fJk3XQ" }
            ],
            tv_guide: [
                { channel: "Ankara Radyosu", time: "20:00", title: "Radyo Tiyatrosu", desc: "Tiyatro eserleri ses efektleriyle evlerimize konuk oluyor." },
                { channel: "İstanbul Radyosu", time: "21:00", title: "Arkası Yarın", desc: "Heyecan verici radyo dizisinin yeni bölümü dinleyicileri kilitledi." },
                { channel: "TRT Radyoları", time: "19:00", title: "Radyo Haber Saati", desc: "Türkiye ve dünyadan önemli gelişmeler tarafsız yayıncılıkla radyoda." }
            ]
        };
    } else if (year < 1980) {
        // 1970'ler
        return {
            weather: defaultWeather,
            headlines: [
                { title: "Boğaziçi Köprüsü Hizmete Açıldı", desc: "Avrupa ile Asya kıtaları ilk kez birbirine kara yolu ile bağlandı." },
                { title: "Kıbrıs Barış Harekatı Gerçekleşti", desc: "Türk Silahlı Kuvvetleri garantörlük hakkını kullanarak adaya çıkarma yaptı." },
                { title: "Siyasi Liderler Sahada", desc: "Ecevit ve Demirel liderliğindeki partiler meydanlarda yoğun miting döneminde." }
            ],
            sports: [
                { title: "Trabzonspor Anadolu İhtilali", desc: "Trabzonspor, üç büyüklerin hegemonyasını yıkarak şampiyonluk yolunda emin adımlarla ilerliyor." },
                { title: "Milli Takım Hazırlıkları", desc: "A Milli Futbol Takımımız uluslararası arenalarda ter dökmeye devam ediyor." }
            ],
            top_hits: [
                { song: "Dağlar Dağlar", artist: "Barış Manço", youtube_query: "Baris Manco - Daglar Daglar klip", youtubeId: "w_M-YfWz5pM" },
                { song: "Anlamazdın", artist: "Semiramis Pekkan", youtube_query: "Semiramis Pekkan - Anlamazdin klip", youtubeId: "W7oR-XvNf-4" },
                { song: "Delisin", artist: "Cici Kızlar", youtube_query: "Cici Kizlar - Delisin klip", youtubeId: "mN22m1JgBik" }
            ],
            tv_guide: [
                { channel: "TRT 1", time: "20:00", title: "Kaçak (The Fugitive)", desc: "Dr. Richard Kimble'ın adalet arayışı ekran başındaki izleyicileri büyülüyor." },
                { channel: "TRT 1", time: "21:00", title: "Oyun Havaları", desc: "Halk dansları ve müzik ekipleri canlı yayında seyircilere keyifli anlar yaşatıyor." },
                { channel: "TRT 1", time: "22:00", title: "Belgesel Saati", desc: "Dünya tarihi ve coğrafya üzerine hazırlanan eğitici kuşak yayında." }
            ]
        };
    } else if (year < 1990) {
        // 1980'ler
        return {
            weather: defaultWeather,
            headlines: [
                { title: "Ekonomik Reformlar Hız Kazanıyor", desc: "Turgut Özal liderliğindeki hükümet serbest piyasa ve döviz reformlarını başlattı." },
                { title: "Renkli Televizyona Geçiş Tamamlanıyor", desc: "TRT ekranları kademeli olarak tamamen renkli yayın hayatına adım atıyor." },
                { title: "Kaset ve Walkman Çılgınlığı", desc: "Sokaklarda ve toplu taşımada walkman kullanan gençlerin sayısı her geçen gün artıyor." }
            ],
            sports: [
                { title: "Cep Herkülü Naim Süleymanoğlu", desc: "Naim Süleymanoğlu halter podyumunda üst üste dünya rekorları kırıyor." },
                { title: "Galatasaray Avrupa Sahnelerinde", desc: "Cevad Prekazi ve arkadaşları Şampiyon Kulüpler Kupası'nda çeyrek finale yürüyor." }
            ],
            top_hits: [
                { song: "Sen Ağlama", artist: "Sezen Aksu", youtube_query: "Sezen Aksu - Sen Aglama klip", youtubeId: "7qJ3vE-rI1Q" },
                { song: "Ele Güne Karşı", artist: "MFÖ", youtube_query: "MFO - Ele Gune Karsi klip", youtubeId: "T7yGqK2t90I" },
                { song: "Arkadaşım Eşek", artist: "Barış Manço", youtube_query: "Baris Manco - Arkadasim Esek klip", youtubeId: "kLh-9X5rS40" }
            ],
            tv_guide: [
                { channel: "TRT 1", time: "20:00", title: "Dallas", desc: "Ewing ailesinin entrikaları ve petrol savaşları ekranlarda izleyicileri kilitliyor." },
                { channel: "TRT 1", time: "21:00", title: "Bizimkiler", desc: "Apartman sakinlerinin eğlenceli ve tanıdık yaşantısı her hafta ekranlara geliyor." },
                { channel: "TRT 1", time: "22:00", title: "Uzay Yolu", desc: "Kaptan Kirk ve ekibi yeni uzay dünyaları ve medeniyetleri keşfediyor." }
            ]
        };
    } else if (year < 2000) {
        // 1990'lar
        return {
            weather: defaultWeather,
            headlines: [
                { title: "Özel Kanalların Yükselişi", desc: "Türkiye'nin ilk özel televizyon kanalları birbiri ardına yayına başlayarak renkli içerikler sunuyor." },
                { title: "Türkçe Pop Müzik Patlaması", desc: "90'lar Türkçe Pop müziği albüm satış rekorları kırıyor ve yeni starlar doğuyor." },
                { title: "İnternet Çağı Türkiye'de", desc: "Türkiye üniversiteler öncülüğünde ilk kez internet bağlantısı ile tanıştı." }
            ],
            sports: [
                { title: "A Milli Takım Euro 96'da", desc: "Tarihimizde ilk kez Avrupa Şampiyonası finallerine katılarak büyük başarı yakaladık." },
                { title: "Süper Lig'de Dört Büyükler Çekişmesi", desc: "Beşiktaş, Galatasaray, Fenerbahçe ve Trabzonspor kıyasıya zirve mücadelesi veriyor." }
            ],
            top_hits: [
                { song: "Abone", artist: "Yonca Evcimik", youtube_query: "Yonca Evcimik - Abone klip", youtubeId: "j6f2w5H0L9I" },
                { song: "Ateşteyim", artist: "Çelik", youtube_query: "Celik - Atesteyim klip", youtubeId: "6K3_4Fm0Y-o" },
                { song: "Araba", artist: "Mustafa Sandal", youtube_query: "Mustafa Sandal - Araba klip", youtubeId: "E0M1Jd7_7_g" }
            ],
            tv_guide: [
                { channel: "Show TV", time: "20:00", title: "Süper Baba", desc: "Fiko ve çocuklarının sıcacık mahalle hikayesi izleyicilere duygusal anlar yaşatıyor." },
                { channel: "ATV", time: "21:00", title: "Mahallenin Muhtarları", desc: "Temel, Fadime ve sevimli mahalle sakinlerinin eğlenceli hikayesi." },
                { channel: "Kanal D", time: "22:30", title: "Yalan Rüzgarı", desc: "Klasik pembe dizinin yeni bölümü heyecan yaratıyor." }
            ]
        };
    } else {
        // 2000'ler ve sonrası
        return {
            weather: defaultWeather,
            headlines: [
                { title: "Nostalji Rüzgarı Esiyor", desc: "RetroSesler zaman tüneli 20 yıl öncesine kapılarını sonuna kadar açtı." },
                { title: "Teknoloji Dünyasında Hareketlilik", desc: "Eski SMS ve internet paketleri üzerinden arkadaşlıklar kurulmaya devam ediliyor." },
                { title: "Kaset ve Vinil Satışlarında Artış", desc: "Retro severlerin plak ve kaset koleksiyonlarına olan ilgisi hızla artış gösteriyor." }
            ],
            sports: [
                { title: "Retro Lig Maçları Başladı", desc: "Eski şampiyonlar nostaljik turnuvalarda karşı karşıya geliyor." },
                { title: "Milli Takım Hazırlıkları", desc: "Nostaljik kadrolar yeşil sahada antrenmanlarına hız kesmeden devam ediyor." }
            ],
            top_hits: [
                { song: "Kuzu Kuzu", artist: "Tarkan", youtube_query: "Tarkan - Kuzu Kuzu klip", youtubeId: "3m0Vv5J0R0I" },
                { song: "Aşkısı", artist: "Serdar Ortaç", youtube_query: "Serdar Ortac - Askisi klip", youtubeId: "9g26eZ8p22I" },
                { song: "Kırmızı", artist: "Hande Yener", youtube_query: "Hande Yener - Kirmizi klip", youtubeId: "Gq3j2gU-45M" }
            ],
            tv_guide: [
                { channel: "Kanal D", time: "20:00", title: "Yabancı Damat", desc: "Gaziantep ve İstanbul arasında geçen eğlenceli aşk ve aile dizisi." },
                { channel: "Show TV", time: "21:00", title: "Kurtlar Vadisi", desc: "Nefes kesen mafya ve aksiyon dizisinde bu hafta heyecan dorukta." },
                { channel: "ATV", time: "20:00", title: "Avrupa Yakası", desc: "Nişantaşı'ndaki eğlenceli ofis ve ev yaşantısı, Aslı ve Volkan'ın maceraları." }
            ]
        };
    }
}

// POST /api/timeline/chat — Zaman Makinesi Yapay Zeka Chatbotu
router.post('/timeline/chat', requireAuth, async (req, res) => {
    const { year, message } = req.body;
    const yearInt = parseInt(year);

    if (!TIMELINE_YEARS.includes(yearInt)) {
        return res.status(400).json({ success: false, error: 'Geçersiz yıl seçimi' });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ success: false, error: 'Mesaj boş olamaz' });
    }

    try {
        // 1. Yıl özetini yükle (AI'a bağlam sağlamak için)
        const cachedSummary = await db.loadTimelineSummary(yearInt);
        const summaryContext = cachedSummary ? JSON.stringify(cachedSummary.summary) : 'Veri yok';

        // 2. Gemini AI'yı çağır
        const provider = process.env.TIMELINE_AI_PROVIDER || 'gemini';
        const apiKey = process.env.TIMELINE_AI_KEY;
        const baseUrl = process.env.TIMELINE_AI_BASE_URL;
        const model = process.env.TIMELINE_AI_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');

        const systemInstruction = `Sen RetroSesler platformunun Yapay Zeka Destekli Zaman Makinesi asistanısın. Görevin, kullanıcının ${yearInt} yılı hakkındaki sorularını yanıtlamaktır.
Kullanıcılara karşı sıcak, samimi ve o dönemi bizzat yaşamış bir retro sever veya nostalji rehberi gibi davran.

İşte ${yearInt} yılına ait özet nostaljik popüler kültür verileri:
${summaryContext}

Yönergeler:
1. Kullanıcının sorusunu bu ${yearInt} yılı bağlamında, o dönemin havasını hissettirecek şekilde yanıtla.
2. Türkçe dilini kusursuz kullan, yanıt metnini 3-4 cümleyi geçmeyecek şekilde samimi tut. HTML veya markdown biçimlendirmesi kullanma, düz metin olsun.
3. Yanıtında şunları da belirle:
   - 'imageSuggestions': Cevabında geçen veya o yıla ait nostaljik öğeleri aramak için kullanılabilecek 1-2 adet net İngilizce görsel arama kelimesi (örn. ["Hababam Sinifi 1975", "Baris Manco album cover"]).
   - 'recommendedRoomsKeywords': Kullanıcının ilgisini çekebilecek sohbet odalarını bulabilmemiz için 1-2 adet Türkçe genel anahtar kelime (örn. ["müzik", "sinema", "rock", "oyun"]).

Lütfen yanıtı mutlaka ve sadece aşağıdaki JSON şemasında dön, başka hiçbir şey yazma:
{
  "reply": "Cevabın...",
  "imageSuggestions": ["sorgu1", "sorgu2"],
  "recommendedRoomsKeywords": ["kelime1", "kelime2"]
}`;

        const promptText = `Kullanıcı Sorusu: "${message.trim()}"`;

        const hasTimelineAi = apiKey || aiService.hasAiService;
        let replyJson = null;

        if (hasTimelineAi) {
            try {
                const jsonText = await aiService.generateText({
                    prompt: promptText,
                    responseMimeType: 'application/json',
                    systemInstruction: systemInstruction,
                    model: model,
                    apiKey: apiKey,
                    baseUrl: baseUrl
                });
                replyJson = JSON.parse(jsonText.trim());
            } catch (aiErr) {
                console.error('[TIMELINE-CHAT] AI generation failed:', aiErr.message);
            }
        }

        if (!replyJson) {
            replyJson = {
                reply: `Bip bop! ${yearInt} yılı arşivlerime erişirken ufak bir bağlantı hatası oluştu. Ama o dönemin harika müziklerini ve anılarını Zaman Tüneli tablarından inceleyebilirsin!`,
                imageSuggestions: [`${yearInt} nostalgia`],
                recommendedRoomsKeywords: ['müzik', 'sohbet']
            };
        }

        // 3. Eşleşen canlı odaları bul (links to related active chat rooms)
        const activeRooms = await fetchRoomData();
        const matchedRooms = [];

        if (Array.isArray(activeRooms)) {
            const keywords = (replyJson.recommendedRoomsKeywords || []).map(k => k.toLowerCase());
            keywords.push(String(yearInt)); // Yılı da anahtar kelime yap

            for (const room of activeRooms) {
                const roomName = (room.name || '').toLowerCase();
                const roomDesc = (room.desc || '').toLowerCase();
                
                const matchesKeyword = keywords.some(kw => roomName.includes(kw) || roomDesc.includes(kw));
                if (matchesKeyword) {
                    matchedRooms.push({
                        name: room.name,
                        participants: room.participants || 0
                    });
                }
            }
        }

        res.json({
            success: true,
            reply: replyJson.reply,
            imageSuggestions: replyJson.imageSuggestions || [],
            recommendedRooms: matchedRooms.slice(0, 3)
        });

    } catch (err) {
        console.error('[API] /api/timeline/chat hatası:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
