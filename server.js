const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Persistent SQLite Database on Disk
const dbFile = path.join(__dirname, 'search_index.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Failed to open SQLite database', err.message);
    } else {
        console.log('Connected to persistent SQLite search database.');
    }
});

// Create Database Schema
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE,
        title TEXT,
        snippet TEXT,
        word_count INTEGER,
        incoming_links INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS inverted_index (
        term TEXT,
        doc_id INTEGER,
        tf REAL,
        PRIMARY KEY (term, doc_id)
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_term ON inverted_index(term)`);
});

const STOP_WORDS = new Set(['the', 'is', 'at', 'which', 'and', 'a', 'an', 'in', 'to', 'of', 'for', 'on', 'with', 'as', 'by', 'this', 'it', 'from', 'or', 'be', 'that', 'are', 'was', 'not']);

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, ' ')
        .split(/\s+/)
        .filter(token => token.length > 0 && !STOP_WORDS.has(token));
}

// User-Agent Pool to minimize bot detection blocks
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

// Global Crawler Queue and Visited Registry
const globalVisited = new Set();
const urlQueue = [
    'https://en.wikipedia.org/wiki/Main_Page',
    'https://www.wikipedia.org',
    'https://news.ycombinator.com/',
    'https://github.com/trending',
    'https://www.bbc.com/news',
    'https://www.cnn.com',
    'https://stackoverflow.com/',
    'https://developer.mozilla.org/',
    'https://www.reddit.com/r/technology/'
];

const NUM_CRAWLERS = 35;
const SITES_PER_CYCLE = 100;
const REST_TIME_MS = 120000; // 2 minutes rest

async function runCrawlerAgent(agentId) {
    while (true) {
        let sitesCrawled = 0;

        while (sitesCrawled < SITES_PER_CYCLE && urlQueue.length > 0) {
            const url = urlQueue.shift();
            if (globalVisited.has(url)) continue;
            globalVisited.add(url);

            try {
                const randomAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
                const response = await axios.get(url, {
                    timeout: 4000,
                    headers: { 'User-Agent': randomAgent }
                });

                const $ = cheerio.load(response.data);
                const title = $('title').text().trim() || url;
                const metaDesc = $('meta[name="description"]').attr('content') || '';

                $('script').remove();
                $('style').remove();
                $('nav').remove();
                $('footer').remove();
                $('header').remove();

                const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
                const snippet = metaDesc || (bodyText.substring(0, 200) + '...');

                if (bodyText.length > 50) {
                    const wordCount = bodyText.length;

                    // Insert Document into SQLite
                    db.run(
                        `INSERT OR IGNORE INTO documents (url, title, snippet, word_count) VALUES (?, ?, ?, ?)`,
                        [url, title, snippet, wordCount],
                        function (err) {
                            if (!err && this.lastID) {
                                const docId = this.lastID;
                                const tokens = tokenize(bodyText);
                                const termFreqs = new Map();
                                tokens.forEach(token => {
                                    termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
                                });

                                // Batch insert tokens into inverted index
                                db.serialize(() => {
                                    db.run('BEGIN TRANSACTION');
                                    termFreqs.forEach((tf, term) => {
                                        db.run(
                                            `INSERT OR REPLACE INTO inverted_index (term, doc_id, tf) VALUES (?, ?, ?)`,
                                            [term, docId, tf]
                                        );
                                    });
                                    db.run('COMMIT');
                                });
                            }
                        }
                    );
                }

                // Extract and queue absolute links
                $('a[href]').each((_, element) => {
                    let href = $(element).attr('href');
                    try {
                        if (href) {
                            const absoluteUrl = new URL(href, url).href;
                            if (absoluteUrl.startsWith('http') && !globalVisited.has(absoluteUrl)) {
                                urlQueue.push(absoluteUrl);
                            }
                        }
                    } catch (e) {
                        // Skip malformed links
                    }
                });

                sitesCrawled++;
            } catch (error) {
                // Silently bypass network blocks and timeouts to maintain crawler velocity
            }
        }

        if (urlQueue.length < 50) {
            urlQueue.push('https://en.wikipedia.org/wiki/Special:Random');
            urlQueue.push('https://github.com/explore');
        }

        await new Promise(resolve => setTimeout(resolve, REST_TIME_MS));
    }
}

// Enterprise SQLite TF-IDF and Authority Ranking Engine
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0) {
        return res.json({ query, count: 0, indexedDocs: 0, timeMs: '0.00', results: [] });
    }

    const startTime = process.hrtime();

    // Get total document count
    db.get(`SELECT COUNT(*) as total FROM documents`, (err, row) => {
        if (err || !row || row.total === 0) {
            return res.json({ query, count: 0, indexedDocs: 0, timeMs: '0.00', results: [] });
        }

        const totalDocs = row.total;
        const placeholders = queryTokens.map(() => '?').join(',');

        // Query inverted index for matching documents across search terms
        const sql = `
            RTRIM(i.term)
            SELECT d.id, d.url, d.title, d.snippet, d.word_count, d.incoming_links, i.term, i.tf
            FROM inverted_index i
            JOIN documents d ON i.doc_id = d.id
            WHERE i.term IN (${placeholders})
        `;

        db.all(`SELECT d.id, d.url, d.title, d.snippet, d.word_count, d.incoming_links, i.term, i.tf FROM inverted_index i JOIN documents d ON i.doc_id = d.id WHERE i.term IN (${placeholders})`, queryTokens, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Search index query failed' });
            }

            const scores = new Map();
            const docMeta = new Map();

            // Calculate Document Frequencies and TF-IDF scores
            const termDocCounts = new Map();
            rows.forEach(r => {
                docMeta.set(r.id, { url: r.url, title: r.title, snippet: r.snippet });
                if (!termDocCounts.has(r.term)) termDocCounts.set(r.term, new Set());
                termDocCounts.get(r.term).add(r.id);
            });

            rows.forEach(r => {
                const docFrequency = termDocCounts.get(r.term).size;
                const idf = Math.log(1 + (totalDocs / docFrequency));
                const tfidf = (r.tf / r.word_count) * idf * 10000;
                const finalScore = tfidf * Math.log(1 + r.incoming_links);

                scores.set(r.id, (scores.get(r.id) || 0) + finalScore);
            });

            const results = Array.from(scores.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([docId, score]) => {
                    const meta = docMeta.get(docId);
                    return {
                        title: meta.title,
                        url: meta.url,
                        snippet: meta.snippet,
                        score: score.toFixed(2)
                    };
                });

            const diff = process.hrtime(startTime);
            const searchTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

            res.json({
                query,
                count: results.length,
                indexedDocs: totalDocs,
                timeMs: searchTimeMs,
                results
            });
        });
    });
});

// Boot up 35 autonomous crawler agents
for (let i = 1; i <= NUM_CRAWLERS; i++) {
    runCrawlerAgent(i);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Persistent Snub Search Engine running on port ${PORT}`);
});
