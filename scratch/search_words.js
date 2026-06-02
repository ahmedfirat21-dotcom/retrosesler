const fs = require('fs');

const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');

const keywords = ['kamera', 'müzik', 'popüler', 'metinler', 'kategoriler'];

lines.forEach((line, idx) => {
    const lineLower = line.toLowerCase();
    keywords.forEach(kw => {
        if (lineLower.includes(kw)) {
            console.log(`${idx + 1}: [KW: ${kw}] ${line.trim()}`);
        }
    });
});
