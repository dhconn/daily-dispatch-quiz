// Daily Dispatch Quiz v2
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join('/tmp', 'quiz-data.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.dirname(__filename)));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Simple file-based data store ─────────────────────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
    return true;
  } catch(e) { return false; }
}

// ── RSS feed fetcher ─────────────────────────────────────────
// Fetches raw RSS/Atom XML from a URL, returns text
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsQuizBot/1.0)' },
      timeout: 10000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Parse RSS/Atom XML — extracts titles, descriptions, links, pubDates
function parseRSS(xml) {
  const items = [];
  // Match both RSS <item> and Atom <entry> tags
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'))
        || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title');
    const description = get('description') || get('summary') || get('content');
    const link = get('link') || (block.match(/href="([^"]+)"/)||[])[1] || '';
    const pubDate = get('pubDate') || get('published') || get('updated') || '';

    if (title) {
      items.push({ title, description: description.slice(0, 500), link, pubDate });
    }
  }
  return items;
}

// Known RSS feeds for Baltimore news sites
const BALTIMORE_RSS_FEEDS = {
  'baltimoresun.com':      'https://www.baltimoresun.com/arcio/rss/',
  'wbal.com':              'https://www.wbal.com/rss',
  'wbaltv.com':            'https://www.wbaltv.com/rss',
  'marylandmatters.org':   'https://marylandmatters.org/feed/',
  'baltimorebrew.com':     'https://baltimorebrew.com/feed/',
  'thedailyrecord.com':    'https://thedailyrecord.com/feed/',
  'wypr.org':              'https://www.wypr.org/rss.xml',
  'foxbaltimore.com':      'https://foxbaltimore.com/rss',
  'wmar2news.com':         'https://www.wmar2news.com/rss',
  'cbsnews.com/baltimore': 'https://www.cbsnews.com/latest/rss/local/wbz',
  'therealnews.com':       'https://therealnews.com/feed',
  'technical.ly/baltimore':'https://technical.ly/feed/',
};

// Filter items to last 24 hours
function isRecent(pubDate) {
  if (!pubDate) return true; // include if no date
  try {
    const d = new Date(pubDate);
    return (Date.now() - d.getTime()) < 26 * 60 * 60 * 1000; // 26hr buffer
  } catch(e) { return true; }
}

// ── GET /api/rss — fetch RSS feeds and return recent article summaries ──
app.get('/api/rss', async (req, res) => {
  const data = readData();
  const savedSites = (data.sites || '').split('\n').map(s => s.trim()).filter(Boolean);

  // Match saved sites to known RSS feeds
  const feedsToFetch = [];
  for (const site of savedSites) {
    for (const [key, feedUrl] of Object.entries(BALTIMORE_RSS_FEEDS)) {
      if (site.includes(key)) {
        feedsToFetch.push({ site, feedUrl });
        break;
      }
    }
  }

  // Also try /feed/ and /rss for any site not in our known list
  for (const site of savedSites) {
    const alreadyMapped = Object.keys(BALTIMORE_RSS_FEEDS).some(k => site.includes(k));
    if (!alreadyMapped) {
      const base = site.replace(/\/$/, '');
      feedsToFetch.push({ site, feedUrl: base + '/feed/' });
      feedsToFetch.push({ site, feedUrl: base + '/rss' });
    }
  }

  const allItems = [];
  const errors = [];

  // Fetch all feeds in parallel with a 20s overall timeout
  const fetchWithTimeout = (site, feedUrl) => new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(), 8000); // 8s per feed
    try {
      const xml = await fetchUrl(feedUrl);
      const items = parseRSS(xml).filter(item => isRecent(item.pubDate));
      items.forEach(item => allItems.push({ ...item, source: site }));
    } catch(e) {
      errors.push(`${feedUrl}: ${e.message}`);
    } finally {
      clearTimeout(timer);
      resolve();
    }
  });

  await Promise.allSettled(feedsToFetch.map(({ site, feedUrl }) => fetchWithTimeout(site, feedUrl)));

  // Deduplicate by title
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });

  res.json({
    count: unique.count,
    errors: errors.length ? errors : undefined,
    items: unique.slice(0, 40) // cap at 40 articles
  });
});

// ── Save/load news sites ──────────────────────────────────────
app.post('/api/sites', (req, res) => {
  const { sites } = req.body;
  if (typeof sites !== 'string') return res.status(400).json({ error: 'sites must be a string' });
  const data = readData();
  data.sites = sites;
  writeData(data);
  res.json({ ok: true });
});

app.get('/api/sites', (req, res) => {
  const data = readData();
  res.json({ sites: data.sites || '' });
});

// ── Anthropic API proxy ───────────────────────────────────────
app.post('/api/claude', (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'ANTHROPIC_API_KEY is not set in Railway Variables.' }
    });
  }

  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: { message: 'Proxy error: ' + err.message } });
  });
  proxyReq.write(body);
  proxyReq.end();
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Daily Dispatch Quiz running on port ${PORT}`);
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('✓ Using Anthropic API');
  } else {
    console.log('⚠ WARNING: ANTHROPIC_API_KEY is not set.');
  }
});
