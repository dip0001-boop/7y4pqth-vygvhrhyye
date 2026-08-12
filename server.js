const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Search Engine State
const documents = new Map(); // docId -> { url, title, snippet, wordCount }
const invertedIndex = new Map(); // term -> Map(docId -> termFrequency)
let docIdCounter = 0;

// Stop words filter for cleaner index quality
const STOP_WORDS = new Set(['the', 'is', 'at', 'which', 'and', 'a', 'an', 'in', 'to', 'of', 'for', 'on', 'with', 'as', 'by', 'this', 'it', 'from']);

function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2 && !STOP_WORDS.has(token));
}

// High Performance Asynchronous Crawler & Indexer
async function crawlAndIndex(startUrl, maxDepth = 2) {
    const visited = new Set();
    const queue = [{ url: startUrl, depth: 0 }];

    console.log(`Starting crawl process from seed: ${startUrl}`);

    while (queue.length > 0 && visited.size < 50) { // Limit initial crawl size for fast execution on Render free tier
        const { url, depth } = queue.shift();

        if (visited.has(url) || depth > maxDepth) continue;
        visited.add(url);

        try {
            const response = await axios.get(url, { 
                timeout: 5000,
                headers: { 'User-Agent': 'SnubBot/1.0 (Autonomous Web Crawler)' }
            });

            const $ = cheerio.load(response.data);
            const title = $('title').text().trim() || url;
            
            // Remove scripts, styles, and junk tags
            $('script').remove();
            $('style').remove();
            $('nav').remove();
            $('footer').remove();

            const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
            const snippet = bodyText.substring(0, 180) + '...';

            const docId = ++docIdCounter;
            documents.set(docId, { url, title, snippet, wordCount: bodyText.length });

            // Tokenize and build Inverted Index
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

            // Extract links for crawler recursion
            if (depth < maxDepth) {
                $('a[href]').each((_, element) => {
                    let href = $(element).attr('href');
                    try {
                        if (href && href.startsWith('http')) {
                            queue.push({ url: href, depth: depth + 1 });
                        }
                    } catch (e) {
                        // Skip malformed links
                    }
                });
            }

            console.log(`Indexed [Doc ${docId}]: ${url}`);
        } catch (error) {
            console.error(`Failed to crawl ${url}: ${error.message}`);
        }
    }
    console.log(`Crawl completed. Total indexed documents: ${documents.size}`);
}

// TF-IDF Ranking Engine
function rankDocuments(query) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || documents.size === 0) return [];

    const scores = new Map(); // docId -> score
    const totalDocs = documents.size;

    queryTokens.forEach(term => {
        if (!invertedIndex.has(term)) return;

        const postingList = invertedIndex.get(term);
        const docFrequency = postingList.size;
        
        // Inverse Document Frequency (IDF)
        const idf = Math.log(1 + (totalDocs / docFrequency));

        postingList.forEach((tf, docId) => {
            // Term Frequency (TF) normalized by document length factor
            const doc = documents.get(docId);
            const tfidf = (tf / doc.wordCount) * idf * 10000; 

            scores.set(docId, (scores.get(docId) || 0) + tfidf);
        });
    });

    // Sort results by highest score descending
    const rankedResults = Array.from(scores.entries())
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

    return rankedResults;
}

// API Routes
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    const startTime = process.hrtime();
    
    const results = rankDocuments(query);
    
    const diff = process.hrtime(startTime);
    const searchTimeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

    res.json({
        query,
        count: results.length,
        timeMs: searchTimeMs,
        results
    });
});

app.post('/api/crawl', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    // Trigger background crawl
    crawlAndIndex(url, 1);
    res.json({ status: 'Crawling initiated in background', url });
});

// Seed initial popular URLs on startup so search returns immediate results
const SEED_URLS = [
    'https://en.wikipedia.org/wiki/Web_crawler',
    'https://en.wikipedia.org/wiki/Search_engine_indexing',
    'https://en.wikipedia.org/wiki/Information_retrieval'
];

async function seedEngine() {
    for (const url of SEED_URLS) {
        await crawlAndIndex(url, 0);
    }
}

seedEngine().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Snub Engine running on port ${PORT}`);
    });
});
