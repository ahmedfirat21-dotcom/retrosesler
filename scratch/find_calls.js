const fs = require('fs');
const lines = fs.readFileSync('index.html', 'utf8').split('\n');
lines.forEach((line, i) => {
    if (line.includes('openRetroDetails(')) {
        console.log(`${i + 1}: ${line.trim()}`);
    }
});
