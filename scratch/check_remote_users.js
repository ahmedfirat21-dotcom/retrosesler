const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/retrosesler-v2/data/retrosesler.db');
console.log(db.prepare("SELECT * FROM users WHERE LOWER(nick) = 'firat'").get());
