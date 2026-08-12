const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE SETUP ---
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

// Create a table to save search history
db.exec(`
  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- WEB ROUTES ---

// 1. Home Page (The Search Engine UI)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Search Engine</title>
      <style>
        body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #fff; }
        .logo { font-size: 85px; font-weight: bold; margin-bottom: 25px; letter-spacing: -2px; }
        .logo span:nth-child(1) { color: #4285F4; }
        .logo span:nth-child(2) { color: #EA4335; }
        .logo span:nth-child(3) { color: #FBBC05; }
        .logo span:nth-child(4) { color: #4285F4; }
        .logo span:nth-child(5) { color: #34A853; }
        .logo span:nth-child(6) { color: #EA4335; }
        .search-box { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 580px; }
        input[type="text"] { width: 100%; padding: 14px 20px; border: 1px solid #dfe1e5; border-radius: 24px; font-size: 16px; outline: none; margin-bottom: 30px; }
        input[type="text"]:hover, input[type="text"]:focus { box-shadow: 0 1px 6px rgba(32,33,36,.28); border-color: rgba(223,225,229,0); }
        .buttons { display: flex; gap: 12px; }
        button { background-color: #f8f9fa; border: 1px solid #f8f9fa; border-radius: 4px; color: #3c4043; cursor: pointer; font-size: 14px; padding: 10px 20px; }
        button:hover { border: 1px solid #dadce0; box-shadow: 0 1px 1px rgba(0,0,0,.1); color: #202124; }
      </style>
    </head>
    <body>
      <div class="logo">
        <span>S</span><span>e</span><span>a</span><span>r</span><span>c</span><span>h</span>
      </div>
      <form class="search-box" action="/search" method="GET">
        <input type="text" name="q" autofocus autocomplete="off">
        <div class="buttons">
          <button type="submit">Search</button>
          <button type="button" onclick="window.location.href='/history'">View Search History</button>
        </div>
      </form>
    </body>
    </html>
  `);
});

// 2. Search Results Page
app.get('/search', (req, res) => {
  const query = req.query.q || '';
  
  // Save whatever the user searched into the SQLite database!
  if (query) {
    const insert = db.prepare('INSERT INTO search_history (query) VALUES (?)');
    insert.run(query);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${query} - Search Results</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .header { display: flex; align-items: center; border-bottom: 1px solid #ebebeb; padding-bottom: 15px; margin-bottom: 20px; }
        .logo { font-size: 24px; font-weight: bold; margin-right: 30px; text-decoration: none; letter-spacing: -1px; }
        .logo span:nth-child(1) { color: #4285F4; }
        .logo span:nth-child(2) { color: #EA4335; }
        .logo span:nth-child(3) { color: #FBBC05; }
        .logo span:nth-child(4) { color: #4285F4; }
        .logo span:nth-child(5) { color: #34A853; }
        .logo span:nth-child(6) { color: #EA4335; }
        input[type="text"] { width: 400px; padding: 10px 15px; border: 1px solid #dfe1e5; border-radius: 24px; font-size: 16px; outline: none; }
        .results { max-width: 600px; margin-left: 100px; }
        .result-item { margin-bottom: 25px; }
        .result-title { color: #1a0dab; font-size: 20px; text-decoration: none; display: block; margin-bottom: 3px; }
        .result-title:hover { text-decoration: underline; }
        .result-url { color: #202124; font-size: 14px; margin-bottom: 3px; }
        .result-desc { color: #4d5156; font-size: 14px; line-height: 1.4; }
      </style>
    </head>
    <body>
      <div class="header">
        <a href="/" class="logo">
          <span>S</span><span>e</span><span>a</span><span>r</span><span>c</span><span>h</span>
        </a>
        <form action="/search" method="GET">
          <input type="text" name="q" value="${query}">
        </form>
      </div>
      <div class="results">
        <p style="color: #70757a; font-size: 14px;">About 3 results (0.33 seconds)</p>
        
        <div class="result-item">
          <div class="result-url">https://en.wikipedia.org › wiki › ${query}</div>
          <a href="#" class="result-title">${query} - Wikipedia</a>
          <div class="result-desc">Information and history about ${query}. This is a simulated search result generated by your server.</div>
        </div>

        <div class="result-item">
          <div class="result-url">/history</div>
          <a href="/history" class="result-title">View Search History (Database Test)</a>
          <div class="result-desc">Click here to view all previous searches saved to your Render SQLite database.</div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// 3. Database History Page (Proves SQLite is working)
app.get('/history', (req, res) => {
  const records = db.prepare('SELECT * FROM search_history ORDER BY created_at DESC LIMIT 50').all();
  let list = records.map(r => '<li style="margin-bottom: 10px;"><strong>' + r.query + '</strong> <span style="color:#777; font-size:12px;">(' + r.created_at + ')</span></li>').join('');
  if (!list) list = '<li>No searches yet. Go back and search for something!</li>';
  
  res.send(`
    <html><head><title>Search History</title><style>body{font-family:Arial; padding:40px; max-width: 600px; margin: 0 auto;}</style></head>
    <body>
      <h2>Recent Searches (Saved to SQLite Database)</h2>
      <ul style="list-style-type: none; padding: 0;">${list}</ul>
      <br><a href="/" style="color: #1a0dab; text-decoration: none;">&larr; Back to Search</a>
    </body></html>
  `);
});

// Keep the app alive
app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}...`);
});
