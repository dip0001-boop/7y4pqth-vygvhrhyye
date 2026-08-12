const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 1. Live Autocomplete Endpoint (Google Suggest API)
app.get('/api/suggest', async (req, res) => {
    const query = req.query.q || '';
    if (!query) return res.json([]);

    try {
        const response = await axios.get(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        // Google returns [query, [suggestions...]]
        const suggestions = response.data[1] || [];
        res.json(suggestions.slice(0, 7));
    } catch (err) {
        res.json([]);
    }
});

// 2. High-Performance Live Search with Instant Answers & Pagination
app.get('/api/search', async (req, res) => {
    const query = req.query.q || '';
    const page = parseInt(req.query.page || '1', 10);
    const offset = (page - 1) * 30;

    if (!query) {
        return res.json({ query: '', count: 0, page: 1, timeMs: '0.00', results: [], instantAnswer: null });
    }

    const startTime = process.hrtime();

    try {
        const response = await axios.post('https://html.duckduckgo.com/html/', 
            new URLSearchParams({ q: query, s: offset.toString() }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT
            }
        });

        const $ = cheerio.load(response.data);
        const results = [];
        let instantAnswer = null;

        // Check for quick answer / zero-click box
        const zciEl = $('.zci__result');
        if (zciEl.length > 0) {
            const zciTitle = zciEl.find('.zci__heading').text().trim();
            const zciSnippet = zciEl.find('.zci__result__body').text().trim();
            if (zciSnippet) {
                instantAnswer = {
                    title: zciTitle || 'Quick Answer',
                    snippet: zciSnippet
                };
            }
        }

        // Parse search result items
        $('.result').each((_, element) => {
            const titleEl = $(element).find('.result__title a');
            const snippetEl = $(element).find('.result__snippet');
            const urlEl = $(element).find('.result__url');
            
            const title = titleEl.text().trim();
            let rawUrl = titleEl.attr('href') || '';
            const snippet = snippetEl.text().trim();

            // Extract clean redirect target URL
            if (rawUrl.includes('uddg=')) {
                try {
                    const match = rawUrl.match(/uddg=([^&]+)/);
                    if (match) rawUrl = decodeURIComponent(match[1]);
                } catch (e) {}
            }

            if (title && rawUrl && rawUrl.startsWith('http')) {
                let domain = '';
                try {
                    domain = new URL(rawUrl).hostname;
                } catch (e) {}

                results.push({
                    title,
                    url: rawUrl,
                    domain,
                    snippet,
                    favicon: domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : ''
                });
            }
        });

        const diff = process.hrtime(startTime);
        const timeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

        res.json({
            query,
            count: results.length,
            page,
            timeMs,
            instantAnswer,
            results
        });
    } catch (error) {
        res.status(500).json({ error: 'Search service temporarily unavailable.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Snub Ultra Engine running on http://localhost:${PORT}`);
});
