const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
// Render provides process.env.PORT automatically
const PORT = process.env.PORT || 3000;

// 1. Database Setup
const isRender = process.env.RENDER === 'true';
const dataDir = isRender 
  ? '/opt/render/project/src/data' 
  : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log(`Connected to database at: ${dbPath}`);

// 2. Initialize Table
db.exec(`
  CREATE TABLE IF NOT EXISTS test_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Insert a test record every time the server boots
const insert = db.prepare('INSERT INTO test_records (message) VALUES (?)');
insert.run('Server booted and staying alive!');

// 3. Web Server Routes
app.get('/', (req, res) => {
  // Fetch the latest 5 records to prove the database is working
  const records = db.prepare('SELECT * FROM test_records ORDER BY created_at DESC LIMIT 5').all();
  
  res.send(`
    App is running!
    Database connected successfully. Recent records:
    ${JSON.stringify(records, null, 2)}
  `);
});

// 4. Keep the app alive by listening on the port
app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}...`);
});
