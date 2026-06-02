const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
content.split('\n').forEach((line, idx) => {
    if (line.includes('rs_mtab') || line.includes('setMobileTab(')) {
        if (!line.includes('function') && !line.includes('button') && !line.includes('onclick')) {
            console.log(`${idx + 1}: ${line.trim()}`);
        }
    }
});
