const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
content.split('\n').forEach((line, idx) => {
    if (line.includes('class="win-panel"') || line.includes('class="rooms-panel"') || line.includes('id="lobby-') || line.includes('tab-')) {
        if (line.includes('div') || line.includes('button') || line.includes('li')) {
            console.log(`${idx + 1}: ${line.trim()}`);
        }
    }
});
