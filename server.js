const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// Render sets the 'RENDER' environment variable to 'true' automatically
const isRender = process.env.RENDER === 'true';

// Use the persistent disk path on Render, or a local 'data' folder for development
const dataDir = isRender 
  ? '/opt/render/project/src/data' 
  : path.join(__dirname, 'data');

// Ensure the directory exists (important for local development)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize the database
const dbPath = path.join(dataDir, 'app.db');
const db = new Database(dbPath);

// Enable WAL mode for better SQLite performance and concurrency
db.pragma('journal_mode = WAL');

console.log(`Connected to database at: ${dbPath}`);

// Setup a basic table to verify it works
db.exec(`
  CREATE TABLE IF NOT EXISTS test_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Example: Insert a record on startup to test write access
const insert = db.prepare('INSERT INTO test_records (message) VALUES (?)');
insert.run('App started up successfully!');

// Example: Read records
const getRecords = db.prepare('SELECT * FROM test_records ORDER BY created_at DESC LIMIT 5');
console.log('Recent records:', getRecords.all());

// --- Add the rest of your Express/Fastify/Node.js server code below ---
