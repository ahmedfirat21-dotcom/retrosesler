const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/retrosesler-v2/data/retrosesler.db');
console.log(db.prepare('SELECT year, length(summary) as len FROM timeline_summaries').all());
process.exit(0);
