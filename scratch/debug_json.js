const fs = require('fs');
const lines = fs.readFileSync('C:/Users/yogun/.gemini/antigravity/brain/d4d9e61e-8fbb-4a61-a945-610f7af79899/.system_generated/logs/transcript.jsonl', 'utf8').split('\n');
for (const l of lines) {
    if (l.includes('step_index":14168')) {
        console.log('Length:', l.length);
        console.log('Around 2057:', JSON.stringify(l.slice(2040, 2080)));
    }
}
