const Database = require('better-sqlite3');
const db = new Database('C:/Users/yogun/retrosesler-v2/data/retrosesler.db');
const users = db.prepare('SELECT id, nick, role FROM users').all();
console.log('All Users:', users);
