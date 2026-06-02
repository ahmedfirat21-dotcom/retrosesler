const fs = require('fs');
const vm = require('vm');

function checkFile(filename) {
    console.log(`Checking syntax of script blocks in: ${filename}`);
    try {
        const content = fs.readFileSync(filename, 'utf8');
        let startIdx = 0;
        let blockCount = 0;
        while (true) {
            startIdx = content.indexOf('<script', startIdx);
            if (startIdx === -1) break;
            
            const closeTagEnd = content.indexOf('>', startIdx);
            if (closeTagEnd === -1) break;
            
            const endScript = content.indexOf('</script>', closeTagEnd);
            if (endScript === -1) {
                console.error(`Error: Script block at index ${startIdx} is not closed!`);
                process.exit(1);
            }
            
            const scriptCode = content.substring(closeTagEnd + 1, endScript);
            const startTag = content.substring(startIdx, closeTagEnd + 1);
            
            if (!startTag.includes('src=')) {
                blockCount++;
                try {
                    new vm.Script(scriptCode);
                } catch (err) {
                    console.error(`JS Syntax Error in ${filename} - Script block #${blockCount}:`);
                    console.error(err);
                    process.exit(1);
                }
            }
            startIdx = endScript + 9;
        }
        console.log(`  Success: Checked ${blockCount} inline script blocks.`);
    } catch (e) {
        console.error(`Global Error checking ${filename}:`, e);
        process.exit(1);
    }
}

checkFile('index.html');
checkFile('profil.html');
checkFile('room.html');
console.log("All files syntactically correct!");
