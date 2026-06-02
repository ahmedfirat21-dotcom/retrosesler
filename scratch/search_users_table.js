const Database = require('better-sqlite3');
const db = new Database('C:/Users/yogun/retrosesler-v2/data/retrosesler.db');
const user = db.prepare("SELECT * FROM users WHERE nick = 'retrobot2' OR nick LIKE '%retrobot%'").all();
console.log('User matching retrobot:', user);
