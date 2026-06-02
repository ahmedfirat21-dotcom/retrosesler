const Database = require('better-sqlite3');
const dbPath = 'C:\\Users\\yogun\\retrosesler-v2\\data\\retrosesler.db';
const db = new Database(dbPath);

console.log("Searching for retrobot2 in database...");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (let t of tables) {
    const columns = db.prepare(`PRAGMA table_info(${t.name})`).all();
    for (let col of columns) {
        try {
            const rows = db.prepare(`SELECT * FROM ${t.name} WHERE ${col.name} LIKE '%retrobot2%'`).all();
            if (rows.length > 0) {
                console.log(`Found in table ${t.name}, column ${col.name}:`, rows);
            }
        } catch (e) {
            // Ignore type mismatches or errors for blob columns
        }
    }
}
console.log("Search completed.");
