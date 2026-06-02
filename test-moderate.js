require('dotenv').config();
const jwt = require('jsonwebtoken');
const http = require('http');
const fs = require('fs');

// DB'den retrotest'in gerçek sessionId'sini al
const users = JSON.parse(fs.readFileSync('data/users.json','utf8'));
const user = users.find(u => u.nick === 'retrotest');
if (!user) { console.log('retrotest bulunamadı'); process.exit(1); }

const token = jwt.sign({id:user.id, nick:user.nick, role:user.role, sid:user.sessionId}, process.env.JWT_SECRET, {expiresIn:'1h'});

const body = JSON.stringify({ text: 'seni öldürürüm orospu çocuğu', room: 'test' });

const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/chat/moderate',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(body)
    }
}, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', data);
    });
});
req.write(body);
req.end();
