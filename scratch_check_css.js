const fs = require('fs');
const html = fs.readFileSync('room.html', 'utf8');
const regex = /\.opb-rel-\d\s*\{[^}]*\}/g;
let match;
while ((match = regex.exec(html)) !== null) {
    console.log(match[0]);
}
