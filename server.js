const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. DATABASE SETUP (The Brain)
// ==========================================
// We use better-sqlite3 for ultra-fast, synchronous disk writes.
const db = new Database('snub_index.db');

// Enable FTS5 (Full-Text Search) with the Porter stemmer for advanced language processing
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
        url UNINDEXED, 
        title, 
        snippet, 
        content,
        tokenize='porter' 
    );
    CREATE TABLE IF NOT EXISTS crawled_urls (url TEXT PRIMARY KEY);
`);

const insertPage = db.prepare('INSERT INTO pages (url, title, snippet, content) VALUES (?, ?, ?, ?)');
const markCrawled = db.prepare('INSERT OR IGNORE INTO crawled_urls (url) VALUES (?)');
const checkCrawled = db.prepare('SELECT url FROM crawled_urls WHERE url = ?');

// ==========================================
// 2. THE CRAWLER (The Spider)
// ==========================================
// Call this endpoint to feed URLs into your engine.
app.post('/api/crawl', async (req, res) => {
    const { url } = req.body;
    
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (checkCrawled.get(url)) return res.json({ message: 'URL already in index' });

    try {
        console.log(`Crawling: ${url}...`);
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'SnubBot/1.0 (+http://localhost:3000)' },
            timeout: 5000
        });

        const $ = cheerio.load(response.data);
        
        // Remove junk elements that mess up search results
        $('script, style, noscript, nav, footer, iframe').remove();

        const title = $('title').text().trim() || url;
        const rawText = $('body').text().replace(/\s+/g, ' ').trim();
        
        // Create a short description for the search results page
        const metaDesc = $('meta[name="description"]').attr('content');
        const snippet = metaDesc ? metaDesc : rawText.substring(0, 160) + '...';

        if (rawText.length > 50) {
            // Save to our SQLite Full-Text Index
            insertPage.run(url, title, snippet, rawText);
            markCrawled.run(url);
            console.log(`Successfully indexed: ${title}`);
            res.json({ success: true, title, url });
        } else {
            res.json({ success: false, message: 'Not enough text content to index.' });
        }
    } catch (error) {
        console.error(`Failed to crawl ${url}:`, error.message);
        res.status(500).json({ error: 'Crawl failed' });
    }
});

// ==========================================
// 3. THE SEARCH ALGORITHM
// ==========================================
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    if (!query) return res.json({ query: '', count: 0, timeMs: '0.00', results: [] });

    const startTime = process.hrtime();

    try {
        // MATCH uses SQLite's built-in BM25 ranking algorithm to sort by relevance.
        // We use the built-in snippet() function to highlight keywords with <b> tags!
        const searchStmt = db.prepare(`
            SELECT 
                url, 
                title, 
                snippet(pages, 2, '<b>', '</b>', '...', 64) as highlighted_snippet 
            FROM pages 
            WHERE pages MATCH ? 
            ORDER BY rank 
            LIMIT 20
        `);

        // Clean the query to prevent SQLite syntax errors
        const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
        const results = searchStmt.all(safeQuery);

        // Format for the frontend
        const formattedResults = results.map(row => {
            let domain = '';
            try { domain = new URL(row.url).hostname; } catch (e) {}

            return {
                title: row.title,
                url: row.url,
                domain: domain,
                snippet: row.highlighted_snippet, // Native bolding on matched words
                favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : ''
            };
        });

        const diff = process.hrtime(startTime);
        const timeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

        res.json({
            query,
            count: formattedResults.length,
            timeMs,
            results: formattedResults
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Search calculation failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Snub Custom Engine active on http://localhost:${PORT}`);
});
