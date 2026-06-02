const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));

files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('mobile-tabbar')) {
        console.log(`Found mobile-tabbar in: ${file}`);
        // Count button elements inside it
        const matches = content.match(/<nav[^>]*class="[^"]*mobile-tabbar"[\s\S]*?<\/nav>/gi);
        if (matches) {
            matches.forEach(m => {
                const btnCount = (m.match(/<button/gi) || []).length;
                console.log(`  Buttons count: ${btnCount}`);
            });
        }
    }
});
