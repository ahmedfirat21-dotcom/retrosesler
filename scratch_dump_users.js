const Database = require('better-sqlite3');
const db = new Database('data/retrosesler.db');
const users = db.prepare('SELECT * FROM users').all();
console.log('--- USERS ---');
console.log(users.map(u => ({ id: u.id, nick: u.nick, role: u.role })));
