const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const path = require('path');
const { URL } = require('url');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. DATABASE & INDEX ENGINE (SQLite FTS5)
// ==========================================
const db = new Database('snub_index.db');

// Virtual table with weighted columns for BM25 ranking
db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
        title,
        snippet,
        content,
        domain UNINDEXED,
        url UNINDEXED,
        tokenize='porter'
    );

    CREATE TABLE IF NOT EXISTS crawled_urls (
        url TEXT PRIMARY KEY,
        crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crawl_queue (
        url TEXT PRIMARY KEY,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

const insertPage = db.prepare('INSERT OR REPLACE INTO pages (title, snippet, content, domain, url) VALUES (?, ?, ?, ?, ?)');
const markCrawled = db.prepare('INSERT OR IGNORE INTO crawled_urls (url) VALUES (?)');
const isCrawled = db.prepare('SELECT url FROM crawled_urls WHERE url = ?');
const enqueueUrl = db.prepare('INSERT OR IGNORE INTO crawl_queue (url) VALUES (?)');
const dequeueUrl = db.prepare('DELETE FROM crawl_queue WHERE url = ?');
const getNextQueue = db.prepare('SELECT url FROM crawl_queue LIMIT 1');

// ==========================================
// 2. RECURSIVE SPIDER / CRAWLER ENGINE
// ==========================================
let isCrawling = false;
let crawlLogs = [];

function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${msg}`;
    console.log(entry);
    crawlLogs.push(entry);
    if (crawlLogs.length > 50) crawlLogs.shift();
}

async function crawlPage(targetUrl) {
    if (isCrawled.get(targetUrl)) return [];

    try {
        addLog(`Crawling: ${targetUrl}`);
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'SnubSpider/2.0 (+http://localhost:3000)' },
            timeout: 6000,
            maxRedirects: 3
        });

        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html')) {
            markCrawled.run(targetUrl);
            return [];
        }

        const $ = cheerio.load(response.data);
        
        // Strip non-content boilerplate
        $('script, style, noscript, nav, footer, iframe, svg, header').remove();

        const title = $('title').text().trim() || targetUrl;
        const metaDesc = $('meta[name="description"]').attr('content') || '';
        const rawText = $('body').text().replace(/\s+/g, ' ').trim();
        const snippetText = metaDesc ? metaDesc : rawText.substring(0, 180) + '...';

        let domain = '';
        try { domain = new URL(targetUrl).hostname; } catch (e) {}

        if (rawText.length > 40) {
            insertPage.run(title, snippetText, rawText, domain, targetUrl);
            markCrawled.run(targetUrl);
            addLog(`✅ Indexed: ${title.substring(0, 45)}...`);
        }

        // Extract internal & external outgoing links for recursive discovery
        const discoveredLinks = [];
        $('a[href]').each((_, el) => {
            let href = $(el).attr('href');
            if (!href) return;

            try {
                const absoluteUrl = new URL(href, targetUrl).href.split('#')[0];
                if (absoluteUrl.startsWith('http://') || absoluteUrl.startsWith('https://')) {
                    if (!isCrawled.get(absoluteUrl)) {
                        enqueueUrl.run(absoluteUrl);
                        discoveredLinks.push(absoluteUrl);
                    }
                }
            } catch (e) {}
        });

        return discoveredLinks;

    } catch (err) {
        addLog(`❌ Failed (${targetUrl}): ${err.message}`);
        markCrawled.run(targetUrl); // Mark to avoid retrying endlessly
        return [];
    }
}

// Background Crawler Loop
async function processCrawlQueue(maxPages = 10) {
    if (isCrawling) return;
    isCrawling = true;
    let pagesCrawled = 0;

    addLog(`Starting crawl batch (Max: ${maxPages} pages)...`);

    while (pagesCrawled < maxPages) {
        const next = getNextQueue.get();
        if (!next) {
            addLog('Crawl queue empty.');
            break;
        }

        const url = next.url;
        dequeueUrl.run(url);
        
        await crawlPage(url);
        pagesCrawled++;

        // Brief delay between requests to be polite to servers
        await new Promise(r => setTimeout(r, 800));
    }

    isCrawling = false;
    addLog(`Crawl batch completed. ${pagesCrawled} pages processed.`);
}

// ==========================================
// 3. API ENDPOINTS
// ==========================================

// Manual Seed / Start Crawl
app.post('/api/crawl/seed', (req, res) => {
    const { url, maxPages = 15 } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    enqueueUrl.run(url);
    processCrawlQueue(parseInt(maxPages, 10));

    res.json({ message: 'Crawl task queued', seedUrl: url });
});

// Real-time Crawl Status
app.get('/api/crawl/status', (req, res) => {
    const queueCount = db.prepare('SELECT COUNT(*) as count FROM crawl_queue').get().count;
    const indexCount = db.prepare('SELECT COUNT(*) as count FROM crawled_urls').get().count;

    res.json({
        isCrawling,
        queueCount,
        indexCount,
        logs: crawlLogs
    });
});

// Database Autocomplete Suggestions
app.get('/api/suggest', (req, res) => {
    const q = req.query.q || '';
    if (!q || q.length < 2) return res.json([]);

    try {
        const safeQ = q.replace(/[^a-zA-Z0-9 ]/g, '').trim();
        const stmt = db.prepare(`
            SELECT DISTINCT title FROM pages 
            WHERE title LIKE ? 
            LIMIT 6
        `);
        const rows = stmt.all(`%${safeQ}%`);
        res.json(rows.map(r => r.title));
    } catch (e) {
        res.json([]);
    }
});

// High-Performance BM25 Search Engine
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    if (!query.trim()) {
        return res.json({ query: '', count: 0, timeMs: '0.00', results: [] });
    }

    const startTime = process.hrtime();

    try {
        const safeQuery = query.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
        if (!safeQuery) return res.json({ query, count: 0, timeMs: '0.00', results: [] });

        // BM25 Column Weights: Title (10.0), Snippet (2.0), Content (1.0)
        const stmt = db.prepare(`
            SELECT 
                url, 
                domain,
                title, 
                snippet(pages, 1, '<b>', '</b>', '...', 40) as matched_snippet,
                bm25(pages, 10.0, 2.0, 1.0) as score
            FROM pages 
            WHERE pages MATCH ? 
            ORDER BY score 
            LIMIT 30
        `);

        // Format terms for FTS search (e.g. "search engines")
        const ftsQuery = safeQuery.split(' ').map(term => `${term}*`).join(' AND ');
        const results = stmt.all(ftsQuery);

        const formattedResults = results.map(row => ({
            title: row.title,
            url: row.url,
            domain: row.domain,
            snippet: row.matched_snippet || row.snippet,
            favicon: row.domain ? `https://www.google.com/s2/favicons?domain=${row.domain}&sz=32` : ''
        }));

        const diff = process.hrtime(startTime);
        const timeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

        res.json({
            query,
            count: formattedResults.length,
            timeMs,
            results: formattedResults
        });

    } catch (error) {
        console.error('Search Execution Error:', error);
        res.status(500).json({ error: 'Search calculation error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Snub Independent Engine active on http://localhost:${PORT}`);
});
