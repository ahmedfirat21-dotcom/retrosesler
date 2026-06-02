const Database = require('better-sqlite3');
const db = new Database('data/retrosesler.db');
const tables = db.prepare('SELECT * FROM okey_tables').all();
console.log(JSON.stringify(tables, null, 2));
