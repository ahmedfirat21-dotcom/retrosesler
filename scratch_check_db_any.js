const Database = require('better-sqlite3');
const db = new Database('data/retrosesler.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

tables.forEach(row => {
    try {
        const columns = db.prepare(`PRAGMA table_info(${row.name})`).all();
        columns.forEach(col => {
            const query = `SELECT * FROM ${row.name} WHERE CAST(${col.name} AS TEXT) LIKE '%retrobot2%'`;
            const matches = db.prepare(query).all();
            if (matches.length > 0) {
                console.log(`Found matches in ${row.name}.${col.name}:`, matches);
            }
        });
    } catch (e) {
        // Ignored
    }
});
