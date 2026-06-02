const fs = require('fs');

const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');

let inMediaQuery = false;
lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.includes('@media') && trimmed.includes('max-width: 768px')) {
        inMediaQuery = true;
    }
    if (inMediaQuery && trimmed === '}') {
        // Simple heuristic for end of media query
        // inMediaQuery = false;
    }
    if (inMediaQuery && (trimmed.includes('win-panel') || trimmed.includes('win-body') || trimmed.includes('rooms-panel'))) {
        console.log(`${idx + 1}: ${line.trim()}`);
    }
});
