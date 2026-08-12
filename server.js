const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Live Search Endpoint that queries the live web instantly
app.get('/api/search', async (req, res) => {
    const query = req.query.q || '';
    if (!query) {
        return res.json({ query: '', count: 0, timeMs: '0.00', results: [] });
    }

    const startTime = process.hrtime();

    try {
        // Fetch live search results securely without needing paid API keys
        const response = await axios.post('https://html.duckduckgo.com/html/', 
            new URLSearchParams({ q: query }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const results = [];

        $('.result').each((_, element) => {
            const titleEl = $(element).find('.result__title a');
            const snippetEl = $(element).find('.result__snippet');
            
            const title = titleEl.text().trim();
            const rawUrl = titleEl.attr('href') || '';
            const snippet = snippetEl.text().trim();

            // Clean up redirect links if necessary
            let url = rawUrl;
            if (rawUrl.includes('uddg=')) {
                try {
                    const match = rawUrl.match(/uddg=([^&]+)/);
                    if (match) url = decodeURIComponent(match[1]);
                } catch (e) {}
            }

            if (title && url) {
                results.push({ title, url, snippet });
            }
        });

        const diff = process.hrtime(startTime);
        const timeMs = (diff[0] * 1000 + diff[1] / 1e6).toFixed(2);

        res.json({
            query,
            count: results.length,
            timeMs,
            results
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch live search results' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Live Search Engine running on port ${PORT}`);
});
