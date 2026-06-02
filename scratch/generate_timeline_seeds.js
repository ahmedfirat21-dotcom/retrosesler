require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ai = require('../services/ai');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SEED_FILE = path.join(DATA_DIR, 'timeline_seed.json');

const TIMELINE_YEARS = Array.from({length: 51}, (_, i) => 2010 - i); // 2010 down to 1960

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('=== RETRO TÜNEL OPTIMIZED SEED DATA GENERATOR ===');
    console.log(`Target Years: 1960 to 2010 (${TIMELINE_YEARS.length} years)`);
    
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    let seedData = {};
    if (fs.existsSync(SEED_FILE)) {
        try {
            seedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) || {};
            console.log(`Loaded existing seed file with ${Object.keys(seedData).length} years.`);
        } catch (e) {
            console.warn('Failed to parse existing seed file, starting fresh.');
        }
    }

    for (let idx = 0; idx < TIMELINE_YEARS.length; idx++) {
        const year = TIMELINE_YEARS[idx];
        if (seedData[year] && Array.isArray(seedData[year].music) && seedData[year].music.length >= 10) {
            console.log(`[${idx + 1}/${TIMELINE_YEARS.length}] Year ${year} already generated. Skipping.`);
            continue;
        }

        console.log(`\n[${idx + 1}/${TIMELINE_YEARS.length}] Generating data for Year ${year}...`);
        
        let attempts = 0;
        let success = false;
        while (attempts < 5 && !success) {
            attempts++;
            try {
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

                const jsonText = await ai.generateText({
                    prompt: promptText,
                    responseMimeType: 'application/json',
                    model: 'gemini-2.5-flash'
                });

                const parsed = JSON.parse(jsonText.trim());
                if (!parsed.music || parsed.music.length === 0) {
                    throw new Error('Parsed object has no music records');
                }

                seedData[year] = parsed;
                fs.writeFileSync(SEED_FILE, JSON.stringify(seedData, null, 2), 'utf8');
                console.log(`-> Successfully saved Year ${year} (Music: ${parsed.music.length}, Movies: ${parsed.movies?.length || 0})`);
                success = true;

            } catch (err) {
                console.error(`-> Attempt ${attempts} failed for Year ${year}:`, err.message);
                if (attempts < 5) {
                    const waitSec = attempts * 15;
                    console.log(`Waiting ${waitSec} seconds before retry...`);
                    await sleep(waitSec * 1000);
                }
            }
        }

        if (!success) {
            console.error(`Critical error: Failed to generate Year ${year} after 5 attempts.`);
            process.exit(1);
        }

        // Add rate-limiting delay between years
        await sleep(4000);
    }

    console.log('\n=== GENERATION COMPLETED SUCCESSFULLY ===');
    process.exit(0);
}

main();
