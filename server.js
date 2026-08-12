const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
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

// Initialize Table
db.exec(`
  CREATE TABLE IF NOT EXISTS test_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 2. Serve your HTML files from the root directory
app.use(express.static(__dirname));

// 3. Keep the app alive
app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}...`);
});
