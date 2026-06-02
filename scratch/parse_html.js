const fs = require('fs');

try {
    const content = fs.readFileSync('index.html', 'utf8');
    console.log("File loaded. Total length:", content.length);
    
    // Find all <script> blocks and parse them to check for Javascript syntax correctness
    let startIdx = 0;
    let blockCount = 0;
    while (true) {
        startIdx = content.indexOf('<script', startIdx);
        if (startIdx === -1) break;
        
        const closeTagEnd = content.indexOf('>', startIdx);
        if (closeTagEnd === -1) break;
        
        const endScript = content.indexOf('</script>', closeTagEnd);
        if (endScript === -1) {
            console.error("Error: Script block at index", startIdx, "is not closed!");
            process.exit(1);
        }
        
        const scriptCode = content.substring(closeTagEnd + 1, endScript);
        
        // Skip script blocks that have src="..."
        const startTag = content.substring(startIdx, closeTagEnd + 1);
        if (!startTag.includes('src=')) {
            blockCount++;
            try {
                // Try compiling script code using Node vm module
                const vm = require('vm');
                new vm.Script(scriptCode);
            } catch (err) {
                console.error(`JS Syntax Error in Script block #${blockCount}:`);
                console.error(err);
                
                // Print surrounding context
                const linesOfBlock = scriptCode.split('\n');
                if (err.stack) {
                    const match = err.stack.match(/evalmachine\.<anonymous>:(\d+)/);
                    if (match) {
                        const lineNum = parseInt(match[1], 10);
                        console.error("Context around error line " + lineNum + ":");
                        const start = Math.max(0, lineNum - 5);
                        const end = Math.min(linesOfBlock.length, lineNum + 5);
                        for (let i = start; i < end; i++) {
                            console.error(`${i + 1}: ${linesOfBlock[i]}`);
                        }
                    }
                }
                process.exit(1);
            }
        }
        
        startIdx = endScript + 9;
    }
    
    console.log(`Success: Checked ${blockCount} inline JavaScript script blocks. All syntactically valid!`);
} catch (e) {
    console.error("Global Error checking index.html syntax:", e);
    process.exit(1);
}
