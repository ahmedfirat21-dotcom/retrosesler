const d = JSON.parse(require('fs').readFileSync('data/users.json','utf8'));
d.forEach(u => console.log(u.nick, u.role, 'sid:', u.sessionId ? u.sessionId.slice(0,8)+'...' : 'YOK'));
