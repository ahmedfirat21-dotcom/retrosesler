const fs = require('fs');
const crypto = require('crypto');
const d = JSON.parse(fs.readFileSync('data/users.json', 'utf8'));
let count = 0;
d.forEach(u => {
    if (!u.sessionId) {
        u.sessionId = crypto.randomBytes(16).toString('hex');
        count++;
    }
});
fs.writeFileSync('data/users.json', JSON.stringify(d, null, 2));
console.log('Updated', count, 'users with sessionId');
