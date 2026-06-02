const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
let inSidebar = false;
content.split('\n').forEach((line, idx) => {
    if (line.includes('<aside class="sidebar">') || line.includes('class="sidebar"')) {
        inSidebar = true;
        console.log(`Start Sidebar at ${idx + 1}`);
    }
    if (inSidebar && line.includes('</aside>')) {
        inSidebar = false;
        console.log(`End Sidebar at ${idx + 1}`);
    }
    if (inSidebar) {
        if (line.includes('win-panel') || line.includes('id=')) {
            console.log(`${idx + 1}: ${line.trim()}`);
        }
    }
});
