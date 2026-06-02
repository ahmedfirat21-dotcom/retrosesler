const fs = require('fs');

const content = fs.readFileSync('profil.html', 'utf8');
const lines = content.split('\n');

const keywords = ['mobile-tabbar', 'timeline', 'zaman tüneli', 'mt-btn'];

lines.forEach((line, idx) => {
    const lineLower = line.toLowerCase();
    keywords.forEach(kw => {
        if (lineLower.includes(kw)) {
            console.log(`${idx + 1}: [KW: ${kw}] ${line.trim()}`);
        }
    });
});
