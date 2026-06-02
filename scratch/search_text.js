const fs = require('fs');
const path = require('path');

const query = process.argv[2] || '';
const targetFile = process.argv[3] || 'index.html';
const filePath = path.join(__dirname, '..', targetFile);

if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log(`Searching for "${query}" in ${targetFile}...`);

let count = 0;
lines.forEach((line, idx) => {
    if (line.toLowerCase().includes(query.toLowerCase())) {
        console.log(`${idx + 1}: ${line.trim()}`);
        count++;
        if (count > 50) {
            console.log('... truncated (too many matches) ...');
            process.exit(0);
        }
    }
});
