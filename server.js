const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { URL } = require('url');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Engine State
const documents = new Map(); // docId -> { url, title, snippet, wordCount, incomingLinks }
const invertedIndex = new Map(); // term -> Map(docId -> termFrequency)
let docIdCounter = 0;

const STOP_WORDS = new Set(['the', 'is', 'at', 'which', 'and', 'a', 'an', 'in', 'to', 'of', 'for', 'on', 'with', 'as', 'by', 'this', 'it', 'from', 'or', 'be', 'that']);

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
                    headers: { 'User-Agent': `SnubCrawlerAgent-${agentId}/3.0 (Enterprise Search Indexer)` }
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
                    const docId = ++docIdCounter;
                    documents.set(docId, { url, title, snippet, wordCount: bodyText.length, incomingLinks: 1 });

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

                // Robust Link Extraction with Absolute URL resolution
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
                // Suppress network timeouts to keep crawler cycle smooth
            }
        }

        if (urlQueue.length < 50) {
            urlQueue.push('https://en.wikipedia.org/wiki/Special:Random');
            urlQueue.push('https://github.com/explore');
        }

        await new Promise(resolve => setTimeout(resolve, REST_TIME_MS));
    }
}

// Enterprise TF-IDF and Authority Ranking Engine
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
            const finalScore = tfidf * Math.log(1 + doc.incomingLinks);
            scores.set(docId, (scores.get(docId) || 0) + finalScore);
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

// Boot up 35 autonomous crawler agents
for (let i = 1; i <= NUM_CRAWLERS; i++) {
    runCrawlerAgent(i);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Snub Search Engine running on port ${PORT}`);
});
