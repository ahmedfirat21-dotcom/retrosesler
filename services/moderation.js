/**
 * RetroSesler — Otomatik Moderasyon Servisi
 * ═══════════════════════════════════════════
 * 1. Türkçe-aware küfür filtresi (BAD_WORDS — SopranoChat'ten)
 * 2. 3-strike sistemi (in-memory, nick → strike count + reset timer)
 * 3. Opsiyonel: Gemini API ile bağlamsal analiz (env'de GEMINI_API_KEY varsa)
 *
 * Sonuç: { safe, severity (0-3), reason, action ('warn'|'delete'|'mute_5m') }
 */

// === SopranoChat'ten alınan Türkçe küfür listesi ===
const BAD_WORDS = [
    'amk', 'aq', 'amq', 'amınakoyim', 'aminakoyim', 'amına', 'amina',
    'ananı', 'anani', 'ananızı', 'ananizi',
    'orospu', 'oruspu', 'orosbu', 'orospuçocuğu', 'orospucocugu',
    'piç', 'pic', 'piçlik',
    'siktir', 'siktirgit', 'sikeyim', 'sikerim', 'sikik', 'sikiş',
    'yarrak', 'yarak', 'yarrağ',
    'götveren',
    'pezevenk', 'pezeveng',
    'gavat', 'ibne', 'götoş', 'godoş',
    'kaltak', 'kahpe', 'fahişe', 'sürtük', 'surtuk',
    'gerizekalı', 'gerizekali',
    'haysiyetsiz', 'şerefsiz', 'serefsiz', 'namussuz',
    'taşak', 'tasak', 'taşşak',
    'amcık', 'amcik',
    'ananıskim', 'ananiskim', 'ananiskm',
    'hassiktir', 'hssktr',
    'yavşak', 'yavsak',
    'puşt', 'pust',
    'dalyarak', 'dallama',
    'kodumun',
    'oç', 'oc',
    'sg', 'sktir', 'sktr',
    // İngilizce hafif
    'fuck', 'shit', 'bitch', 'asshole',
];

// Türkçe-aware word boundary regex
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function buildPattern() {
    const lookBehind = '(?<![a-zA-ZçğıöüşÇĞİÖÜŞ0-9])';
    const lookAhead = '(?![a-zA-ZçğıöüşÇĞİÖÜŞ0-9])';
    return new RegExp(BAD_WORDS.map(w => `${lookBehind}${escapeRegex(w)}${lookAhead}`).join('|'), 'gi');
}
const BAD_PATTERN = buildPattern();

function filterBadWords(text) {
    if (!text) return text;
    BAD_PATTERN.lastIndex = 0;
    return text.replace(BAD_PATTERN, (m) => m.length <= 2 ? '*'.repeat(m.length) : m[0] + '*'.repeat(m.length - 2) + m[m.length - 1]);
}

function containsBadWords(text) {
    if (!text) return false;
    BAD_PATTERN.lastIndex = 0;
    return BAD_PATTERN.test(text);
}

function countBadWords(text) {
    if (!text) return 0;
    BAD_PATTERN.lastIndex = 0;
    let count = 0;
    while (BAD_PATTERN.exec(text) !== null) count++;
    return count;
}

// === 3-strike sistem (in-memory, nick bazlı) ===
const _strikes = new Map(); // nick → { count, lastResetAt, mutedUntil, totalOffenses }
const STRIKE_RESET_MS = 30 * 60 * 1000;  // 30 dk strike dinlenir
const MUTE_DURATION_MS = 5 * 60 * 1000;  // 3 strike → 5 dk mute
const MAX_STRIKES = 3;

// Süreli mute helper (server tarafı 15dk/1saat için kullanır)
const MUTE_DURATIONS = {
    mute_5m:  5  * 60 * 1000,
    mute_15m: 15 * 60 * 1000,
    mute_1h:  60 * 60 * 1000,
};
function applyMute(nick, action) {
    const s = _getStrike(nick);
    const dur = MUTE_DURATIONS[action] || MUTE_DURATIONS.mute_5m;
    s.mutedUntil = Date.now() + dur;
    return Math.round(dur / 1000);
}

function _getStrike(nick) {
    const now = Date.now();
    let s = _strikes.get(nick);
    if (!s) {
        s = { count: 0, lastResetAt: now, mutedUntil: 0, totalOffenses: 0 };
        _strikes.set(nick, s);
    } else if (now - s.lastResetAt > STRIKE_RESET_MS) {
        // Strike soğumuş
        s.count = 0;
        s.lastResetAt = now;
    }
    return s;
}

// Toplam suç sayısı — kalıcı eskalasyon kararı için (tekrar suçlular = anında daha sert)
function getTotalOffenses(nick) {
    const s = _strikes.get(nick);
    return s ? (s.totalOffenses || 0) : 0;
}

function addStrike(nick) {
    const s = _getStrike(nick);
    s.count++;
    s.totalOffenses = (s.totalOffenses || 0) + 1;
    s.lastResetAt = Date.now();
    let action = 'warn';
    if (s.count >= MAX_STRIKES) {
        s.mutedUntil = Date.now() + MUTE_DURATION_MS;
        s.count = 0; // sıfırla — bir sonraki strike turuna gir
        action = 'mute_5m';
    } else if (s.count === MAX_STRIKES - 1) {
        action = 'final_warn';
    }
    return { count: s.count, mutedUntil: s.mutedUntil, action };
}

function isMuted(nick) {
    const s = _strikes.get(nick);
    if (!s) return false;
    return s.mutedUntil > Date.now();
}

function muteRemainingSec(nick) {
    const s = _strikes.get(nick);
    if (!s || s.mutedUntil <= Date.now()) return 0;
    return Math.ceil((s.mutedUntil - Date.now()) / 1000);
}

// === Spam tespit (aynı mesaj 3 defa, 60sn içinde) ===
const _msgHistory = new Map(); // nick → [{text, ts}]
function detectSpam(nick, text) {
    const now = Date.now();
    const hist = (_msgHistory.get(nick) || []).filter(m => now - m.ts < 60_000);
    const sameCount = hist.filter(m => m.text === text).length;
    hist.push({ text, ts: now });
    if (hist.length > 10) hist.shift();
    _msgHistory.set(nick, hist);
    return sameCount >= 2; // 3. tekrar = spam
}

// === ALL-CAPS detect (yumuşak) ===
function isShouting(text) {
    if (!text || text.length < 8) return false;
    const letters = text.replace(/[^a-zA-ZçğıöüşÇĞİÖÜŞ]/g, '');
    if (letters.length < 8) return false;
    const upper = letters.replace(/[a-zçğıöüş]/g, '');
    return upper.length / letters.length > 0.85;
}

// === Gemini API ile bağlamsal analiz (opsiyonel) ===
// Sadece env'de GEMINI_API_KEY varsa kullanılır
// aiLevel: 'off' (AI çağrılmaz), 'standard' (default), 'strict' (küçük ihlalleri de yakala)
async function analyzeWithGemini(text, context = {}) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const aiLevel = context.aiLevel || 'standard';
    if (aiLevel === 'off') return null;
    try {
        const prevOffenses = context.totalOffenses || 0;
        const toneLine = aiLevel === 'strict'
            ? 'Hassas bir okuma odası — küçük argo/imalı dile bile SERT davran; tehdit, cinsel ima, ırkçılık, sürekli hakaret, çocuk istismarı temasına 0 tolerans.'
            : 'Hafif şakaya/argo\'ya tahammül et ama gerçek tehdit, cinsel taciz, ırkçılık, sürekli hakaret, çocuk istismarı temasına SERT davran.';
        const prompt = `Sen RetroSesler adlı Türk nostaljik sohbet sitesinin moderasyon AI'sısın. ${toneLine}

Bu kullanıcının daha önce ${prevOffenses} kez kuralı çiğnediği biliniyor (sicil bilgisi).

Mesajı değerlendir. SADECE JSON dön (başka hiçbir metin yok):
{"safe": true/false, "severity": 0-3, "category": "spam|hakaret|tehdit|cinsel|irkcilik|sair", "reason": "<10 kelime tek cümle", "action": "none|warn|mute_15m|mute_1h|kick|ban_24h|ban_perm"}

Aksiyon ölçeği:
- "none": temiz mesaj
- "warn": hafif/sınırda — uyarı
- "mute_15m": orta seviye hakaret/spam
- "mute_1h": tekrarlayan veya sert hakaret
- "kick": ağır taciz, tehdit
- "ban_24h": cinsel taciz, ırkçı, ölüm tehdidi
- "ban_perm": çocuk istismarı, terör övgüsü, ölümcül tehdit
Sicili kabarık kullanıcılar için bir tık üstüne çık.

Mesaj: "${text.replace(/"/g, "'").slice(0, 400)}"`;
        // gemini-2.5-flash-lite — free tier'da yeterli kota + moderasyon için yeterince akıllı + hızlı
        const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + encodeURIComponent(key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 180 },
            }),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        // JSON parse — Gemini bazen markdown sarmalı koyar
        const json = out.replace(/^```json\s*|\s*```$/g, '').trim();
        const parsed = JSON.parse(json);
        const validActions = ['none', 'warn', 'mute_15m', 'mute_1h', 'kick', 'ban_24h', 'ban_perm'];
        const aiAction = validActions.includes(parsed.action) ? parsed.action : 'warn';
        return {
            safe: !!parsed.safe,
            severity: Math.max(0, Math.min(3, parsed.severity || 0)),
            category: String(parsed.category || 'sair').slice(0, 20),
            reason: String(parsed.reason || '').slice(0, 100),
            action: aiAction,
        };
    } catch (err) {
        console.warn('[Moderation] Gemini hatası:', err.message);
        return null;
    }
}

// === Eskalasyon kararı — yerel strike count + Gemini hint birleştir ===
// Daha sert ne varsa onu uygula. Local "warn → mute → kick → ban" merdiveni.
const ACTION_SEVERITY = {
    none: 0, warn: 1, final_warn: 1,
    mute_5m: 2, mute_15m: 3, mute_1h: 4,
    kick: 5, ban_24h: 6, ban_perm: 7,
    silenced: 0, gentle_warn: 0,
};
function escalate(localAction, aiAction) {
    if (!aiAction || aiAction === 'none') return localAction;
    const localSev = ACTION_SEVERITY[localAction] ?? 1;
    const aiSev = ACTION_SEVERITY[aiAction] ?? 1;
    return aiSev > localSev ? aiAction : localAction;
}

/**
 * Ana moderasyon fonksiyonu — mesajı analiz et + strike + action belirle
 * @returns {Promise<{safe, severity, reason, action, filteredText, strikes, mutedSec, category}>}
 */
async function moderateMessage({ nick, text, room, aiLevel = 'standard' }) {
    // 1. Mute mı?
    if (isMuted(nick)) {
        return {
            safe: false,
            severity: 3,
            reason: 'Susturulmuş kullanıcı',
            action: 'silenced',
            filteredText: '',
            mutedSec: muteRemainingSec(nick),
            strikes: 0,
        };
    }
    // 2. Spam?
    if (detectSpam(nick, text)) {
        const s = addStrike(nick);
        return {
            safe: false,
            severity: 1,
            reason: 'Spam — aynı mesajı tekrar tekrar yazma',
            action: s.action,
            category: 'spam',
            filteredText: text,
            strikes: s.count,
            mutedSec: muteRemainingSec(nick),
        };
    }
    // 3. Küfür var mı? (filtre + strike — Gemini'ye yine de soruyoruz, eskalasyon için)
    const badCount = countBadWords(text);
    let baseResult = null;
    if (badCount > 0) {
        const s = addStrike(nick);
        baseResult = {
            safe: false,
            severity: badCount >= 2 ? 2 : 1,
            reason: badCount >= 2 ? 'Aşırı küfür' : 'Küfür içeriyor',
            action: s.action,
            category: 'hakaret',
            filteredText: filterBadWords(text),
            strikes: s.count,
            mutedSec: muteRemainingSec(nick),
        };
    }
    // 4. Caps lock / bağırma — küfür yoksa sadece nazik uyarı
    if (!baseResult && isShouting(text)) {
        return {
            safe: true,
            severity: 0,
            reason: 'BÜYÜK harf bağırma',
            action: 'gentle_warn',
            category: 'sair',
            filteredText: text,
            strikes: 0,
        };
    }
    // 5. Gemini AI bağlamsal analiz (varsa) — eskalasyon yapabilir.
    //    aiLevel='off' ise AI çağrısı atlanır (yalnızca local küfür filtresi + strike).
    const totalOffenses = getTotalOffenses(nick);
    const ai = await analyzeWithGemini(text, { totalOffenses, aiLevel });
    if (ai && !ai.safe && ai.severity >= 1) {
        // Strike — eğer küfür filtresi tetiklemediyse şimdi ekle
        const s = baseResult ? { count: baseResult.strikes, action: baseResult.action } : addStrike(nick);
        const localAction = baseResult ? baseResult.action : s.action;
        let finalAction = escalate(localAction, ai.action);
        // mute_15m / mute_1h → süreyi gerçekten uygula
        if (finalAction === 'mute_15m' || finalAction === 'mute_1h') {
            applyMute(nick, finalAction);
        }
        return {
            safe: false,
            severity: Math.max(ai.severity, baseResult?.severity || 0),
            reason: baseResult ? baseResult.reason + ' + AI: ' + ai.reason : 'AI: ' + ai.reason,
            action: finalAction,
            category: ai.category || baseResult?.category || 'sair',
            filteredText: baseResult ? baseResult.filteredText : text,
            strikes: s.count,
            mutedSec: muteRemainingSec(nick),
        };
    }
    // 6. AI temiz dedi ama küfür var → küfür sonucu
    if (baseResult) return baseResult;
    // 7. Tamamen temiz
    return {
        safe: true,
        severity: 0,
        reason: '',
        action: 'none',
        category: 'temiz',
        filteredText: text,
        strikes: 0,
    };
}

// === Direct enforce APIs — server.js çağırır ===
function forceMute(nick, action) {
    return applyMute(nick, action);
}
function clearStrikes(nick) {
    _strikes.delete(nick);
}

// ═══════════════════════════════════════════════════════
// === MULTIMODAL: Gemini Audio + Image (kullanıcı raporu) ===
// ═══════════════════════════════════════════════════════
// Kullanıcı "🚨 Bildir" basınca → o anki ses snippet'i ve/veya kamera frame'i Gemini'ye gider.

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGeminiMultimodal(parts) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    try {
        const resp = await fetch(GEMINI_URL + '?key=' + encodeURIComponent(key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
            }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            console.warn('[Moderation-MM] Gemini HTTP', resp.status, err.slice(0, 200));
            return null;
        }
        const data = await resp.json();
        const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const json = out.replace(/^```json\s*|\s*```$/g, '').trim();
        const parsed = JSON.parse(json);
        const validActions = ['none', 'warn', 'mute_15m', 'mute_1h', 'kick', 'ban_24h', 'ban_perm'];
        const aiAction = validActions.includes(parsed.action) ? parsed.action : 'warn';
        return {
            safe: !!parsed.safe,
            severity: Math.max(0, Math.min(3, parsed.severity || 0)),
            category: String(parsed.category || 'sair').slice(0, 30),
            reason: String(parsed.reason || '').slice(0, 200),
            transcript: String(parsed.transcript || '').slice(0, 500), // ses ise ne dediği
            action: aiAction,
        };
    } catch (err) {
        console.warn('[Moderation-MM] Hata:', err.message);
        return null;
    }
}

/**
 * Ses snippet'ini Gemini'ye yolla, transkribe et + değerlendir.
 * @param {string} base64Audio — base64 encoded audio (webm/opus/mp4)
 * @param {string} mimeType — örn 'audio/webm;codecs=opus'
 * @param {string} reporterContext — "Tarkan adlı kullanıcı bu kişiyi 'sesli küfür' sebebiyle bildirdi"
 */
async function analyzeAudioReport(base64Audio, mimeType, reporterContext) {
    const mime = (mimeType || 'audio/webm').split(';')[0]; // codec kısmını at
    const prompt = `Sen RetroSesler Türk nostaljik sohbet sitesinin sesli moderasyon AI'sısın.

${reporterContext}

Bu ses kaydını dinle. ÖNCE TRANSKRİBE ET, sonra değerlendir.

Değerlendirme kriterleri:
- Hafif şaka/argo TAHAMMÜL ET (küfür sadece "vurgu" için ise warn yeterli)
- Tehdit, cinsel taciz, ırkçı söylem, çocuk üzerinden taciz, sürekli ağır hakaret SERT cezalandır
- Sessizlik / müzik / gürültü / normal sohbet TEMİZ kabul et
- Kayıt anlaşılmıyorsa safe=true, action=none

SADECE JSON dön:
{"safe": true/false, "severity": 0-3, "category": "spam|hakaret|tehdit|cinsel|irkcilik|sair|temiz", "transcript": "<duyduğun kelimeler — yoksa boş>", "reason": "<10 kelime tek cümle>", "action": "none|warn|mute_15m|mute_1h|kick|ban_24h|ban_perm"}`;

    return callGeminiMultimodal([
        { text: prompt },
        { inline_data: { mime_type: mime, data: base64Audio } },
    ]);
}

/**
 * Kamera frame'ini Gemini Vision'a yolla.
 * @param {string} base64Image — base64 encoded jpeg/png
 * @param {string} mimeType — örn 'image/jpeg'
 * @param {string} reporterContext
 */
async function analyzeImageReport(base64Image, mimeType, reporterContext) {
    const mime = mimeType || 'image/jpeg';
    const prompt = `Sen RetroSesler Türk nostaljik sohbet sitesinin görsel moderasyon AI'sısın.

${reporterContext}

Bu kamera karesini incele. SİTE KURALLARI:
- Çıplaklık, müstehcen poz, cinsel jest YASAK
- Şiddet/silah/kan YASAK
- Nefret sembolleri, ırkçı işaretler YASAK
- Yüz görünmeyen siyah/boş kare = temiz, sorun değil
- Normal yüz, gülümseme, sohbet eden insan = TEMİZ

SADECE JSON dön:
{"safe": true/false, "severity": 0-3, "category": "ciplaklik|cinsel|siddet|nefret|sair|temiz", "reason": "<10 kelime tek cümle — ne gördüğün>", "action": "none|warn|kick|ban_24h|ban_perm"}

Görseli iyi analiz et — pikselli/karanlık olsa bile şüpheli ise kick öner.`;

    return callGeminiMultimodal([
        { text: prompt },
        { inline_data: { mime_type: mime, data: base64Image } },
    ]);
}

/**
 * Hem ses hem görsel verilirse — birleşik karar.
 * İkisinden hangisi daha ağırsa onu uygula.
 */
async function analyzeReport({ audioB64, audioMime, imageB64, imageMime, reporter, reported, reason }) {
    const ctx = `"${reporter}" adlı kullanıcı, "${reported}" adlı kullanıcıyı "${reason || 'kural ihlali'}" sebebiyle bildirdi.`;
    const results = await Promise.all([
        audioB64 ? analyzeAudioReport(audioB64, audioMime, ctx) : Promise.resolve(null),
        imageB64 ? analyzeImageReport(imageB64, imageMime, ctx) : Promise.resolve(null),
    ]);
    const [audioRes, imageRes] = results;
    // Hiçbir analiz yapılmadıysa veya hepsi null döndüyse → no-op
    if (!audioRes && !imageRes) {
        return { safe: true, action: 'none', reason: 'AI analiz yapılamadı', source: 'none' };
    }
    // Hangisi daha ağırsa onu seç
    const audioSev = ACTION_SEVERITY[audioRes?.action || 'none'] || 0;
    const imageSev = ACTION_SEVERITY[imageRes?.action || 'none'] || 0;
    const winner = imageSev >= audioSev ? imageRes : audioRes;
    const loser = winner === imageRes ? audioRes : imageRes;
    return {
        safe: winner?.safe ?? true,
        severity: winner?.severity || 0,
        category: winner?.category || 'sair',
        reason: winner?.reason || '',
        transcript: audioRes?.transcript || '',
        action: winner?.action || 'none',
        source: winner === imageRes ? 'image' : 'audio',
        secondary: loser ? { action: loser.action, reason: loser.reason, source: winner === imageRes ? 'audio' : 'image' } : null,
    };
}

module.exports = {
    BAD_WORDS,
    filterBadWords,
    containsBadWords,
    countBadWords,
    addStrike,
    isMuted,
    muteRemainingSec,
    detectSpam,
    isShouting,
    moderateMessage,
    forceMute,
    clearStrikes,
    getTotalOffenses,
    analyzeAudioReport,
    analyzeImageReport,
    analyzeReport,
};
