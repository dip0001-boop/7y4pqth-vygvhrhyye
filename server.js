const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Engine State
const documents = new Map(); // docId -> { url, title, snippet, wordCount }
const invertedIndex = new Map(); // term -> Map(docId -> termFrequency)
let docIdCounter = 0;

const STOP_WORDS = new Set(['the', 'is', 'at', 'which', 'and', 'a', 'an', 'in', 'to', 'of', 'for', 'on', 'with', 'as', 'by', 'this', 'it', 'from']);

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, ' ')
        .split(/\s+/)
        .filter(token => token.length > 0 && !STOP_WORDS.has(token));
}

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
    'https://developer.mozilla.org/'
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
                const response = await axios.get(url, {
                    timeout: 4000,
                    headers: { 'User-Agent': `SnubCrawlerAgent-${agentId}/2.0` }
                });

                const $ = cheerio.load(response.data);
                const title = $('title').text().trim() || url;

                $('script').remove();
                $('style').remove();
                $('nav').remove();
                $('footer').remove();
                $('header').remove();

                const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
                const snippet = bodyText.substring(0, 200) + '...';

                if (bodyText.length > 100) {
                    const docId = ++docIdCounter;
                    documents.set(docId, { url, title, snippet, wordCount: bodyText.length });

                    const tokens = tokenize(bodyText);
                    const termFreqs = new Map();
                    tokens.forEach(token => {
                        termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
                    });

                    termFreqs.forEach((tf, term) => {
                        if (!invertedIndex.has(term)) {
                            invertedIndex.set(term, new Map());
                        }
                        invertedIndex.get(term).set(docId, tf);
                    });
                }

                // Extract links to expand queue
                $('a[href]').each((_, element) => {
                    let href = $(element).attr('href');
                    if (href && href.startsWith('http') && !globalVisited.has(href)) {
                        urlQueue.push(href);
                    }
                });

                sitesCrawled++;
            } catch (error) {
                // Skip failed requests silently to maintain crawler velocity
            }
        }

        // Refill queue if running low
        if (urlQueue.length < 50) {
            urlQueue.push('https://en.wikipedia.org/wiki/Special:Random');
            urlQueue.push('https://github.com/explore');
        }

        console.log(`Crawler Agent [${agentId}] completed batch of ${sitesCrawled} sites. Resting for 2 minutes.`);
        await new Promise(resolve => setTimeout(resolve, REST_TIME_MS));
    }
}

// TF-IDF Ranking Engine
function rankDocuments(query) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || documents.size === 0) return [];

    const scores = new Map();
    const totalDocs = documents.size;

    queryTokens.forEach(term => {
        if (!invertedIndex.has(term)) return;

        const postingList = invertedIndex.get(term);
        const docFrequency = postingList.size;
        const idf = Math.log(1 + (totalDocs / docFrequency));

        postingList.forEach((tf, docId) => {
            const doc = documents.get(docId);
            const tfidf = (tf / doc.wordCount) * idf * 10000;
            scores.set(docId, (scores.get(docId) || 0) + tfidf);
        });
    });

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([docId, score]) => {
            const doc = documents.get(docId);
            return {
                title: doc.title,
                url: doc.url,
                snippet: doc.snippet,
                score: score.toFixed(2)
            };
        });
}

// API Endpoints
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    const startTime = process.hrtime();
    const results = rankDocuments(query);
    const diff = process.hrtime(startTime);
    const searchTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

    res.json({
        query,
        count: results.length,
        indexedDocs: documents.size,
        timeMs: searchTimeMs,
        results
    });
});

// Boot up 35 parallel crawler agents
for (let i = 1; i <= NUM_CRAWLERS; i++) {
    runCrawlerAgent(i);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Snub Search Engine and Browser running on port ${PORT}`);
});
