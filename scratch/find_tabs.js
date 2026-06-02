const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
content.split('\n').forEach((line, idx) => {
    if (line.includes('nav') || line.includes('tab') || line.includes('menu') || line.includes('header')) {
        if (line.includes('<div') || line.includes('<nav') || line.includes('<ul') || line.includes('<button') || line.includes('<a')) {
            if (line.length < 120) {
                console.log(`${idx + 1}: ${line.trim()}`);
            }
        }
    }
});
