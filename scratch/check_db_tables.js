const { db } = require('../services/db');
console.log('Active tables:');
const tables = db.prepare('SELECT * FROM okey_tables').all();
console.log(JSON.stringify(tables, null, 2));
process.exit(0);
