const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
content.split('\n').forEach((line, idx) => {
    if (line.includes('data-mtab')) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});
