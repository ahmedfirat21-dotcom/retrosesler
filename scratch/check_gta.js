const Database = require('better-sqlite3');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'retrosesler.db');
const db = new Database(DB_FILE, { readonly: true });

const queryKey = '2009_games_gta: vice city';
const row = db.prepare('SELECT * FROM timeline_details WHERE query = ?').get(queryKey);

console.log('--- Database Entry for GTA: Vice City in 2009 ---');
console.log(row ? JSON.stringify(row, null, 2) : 'No entry found.');

const summaryRow = db.prepare('SELECT * FROM timeline_summaries WHERE year = 2009').get();
if (summaryRow) {
    const summary = JSON.parse(summaryRow.summary);
    const game = (summary.games || []).find(g => g.title.toLowerCase().includes('vice'));
    console.log('Summary entry:', JSON.stringify(game, null, 2));
}

db.close();
