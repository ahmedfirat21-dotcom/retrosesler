const fs = require('fs');
const lines = fs.readFileSync('C:/Users/yogun/.gemini/antigravity/brain/d4d9e61e-8fbb-4a61-a945-610f7af79899/.system_generated/logs/transcript.jsonl', 'utf8').split('\n');

for (const l of lines) {
    if (!l.trim()) continue;
    if (!l.includes('"step_index":14168')) continue;
    try {
        const obj = JSON.parse(l);
        const tc = obj.tool_calls[0];
        const codeStr = tc.args.CodeContent;
        try {
            const cleanCode = JSON.parse('{"code": ' + codeStr + '}').code;
            fs.writeFileSync('scratch/redesign_admin_css.js', cleanCode, 'utf8');
            console.log('Successfully recovered redesign_admin_css.js!');
        } catch (innerErr) {
            console.error('Inner parse error:', innerErr.message);
        }
    } catch(e) {
        console.error('Outer parse error:', e.message);
    }
}
