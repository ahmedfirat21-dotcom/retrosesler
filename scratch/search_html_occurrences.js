const fs = require('fs');

const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');

let inScript = false;
lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('<script') || trimmed.includes('<script>')) {
        inScript = true;
    }
    if (trimmed.includes('</script>')) {
        inScript = false;
        return;
    }

    if (!inScript) {
        const lineLower = line.toLowerCase();
        const keywords = ['kamera', 'müzik', 'popüler', 'metinler', 'kategori'];
        keywords.forEach(kw => {
            if (lineLower.includes(kw)) {
                console.log(`${idx + 1}: ${line.trim()}`);
            }
        });
    }
});
