const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'retrosesler.db');
const db = new Database(dbPath);

try {
    const rows = db.prepare("SELECT name, desc FROM system_rooms").all();
    console.log("System Rooms from Database:");
    console.log(JSON.stringify(rows, null, 2));
} catch (e) {
    console.error("Error querying system_rooms:", e.message);
}
