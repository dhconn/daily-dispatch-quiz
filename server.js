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

// ── RSS cache ─────────────────────────────────────────────────
// Articles are fetched in the background and cached in memory.
// The cache is refreshed on startup and via the /api/rss/refresh endpoint.

async function fetchAndCacheRSS() {
  const data = readData();
  const savedSites = (data.sites || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!savedSites.length) {
    console.log('RSS: No sites saved yet, skipping fetch.');
    return;
  }

  console.log(`RSS: Fetching feeds for ${savedSites.length} sites…`);

  const feedsToFetch = [];
  for (const site of savedSites) {
    let matched = false;
    for (const [key, feedUrl] of Object.entries(BALTIMORE_RSS_FEEDS)) {
      if (site.includes(key)) {
        feedsToFetch.push({ site, feedUrl });
        matched = true;
        break;
      }
    }
    if (!matched) {
      const base = site.replace(/\/$/, '');
      feedsToFetch.push({ site, feedUrl: base + '/feed/' });
      feedsToFetch.push({ site, feedUrl: base + '/rss' });
    }
  }

  const allItems = [];
  const errors = [];

  const fetchWithTimeout = (site, feedUrl) => new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(), 8000);
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

  // Save to data file
  const freshData = readData();
  freshData.rssCache = {
    items: unique.slice(0, 40),
    fetchedAt: new Date().toISOString(),
    errors: errors.length ? errors : []
  };
  writeData(freshData);
  console.log(`RSS: Cached ${unique.length} articles. Errors: ${errors.length}`);
}

// Fetch RSS on startup (after a short delay to let the server settle)
setTimeout(fetchAndCacheRSS, 5000);

// ── GET /api/rss — return cached articles ─────────────────────
app.get('/api/rss', (req, res) => {
  const data = readData();
  const cache = data.rssCache || { items: [], fetchedAt: null, errors: [] };
  res.json(cache);
});

// ── POST /api/rss/refresh — manually trigger a fresh fetch ────
app.post('/api/rss/refresh', async (req, res) => {
  res.json({ ok: true, message: 'RSS refresh started in background.' });
  fetchAndCacheRSS(); // run in background, don't await
});

// ── Redirect root to quiz ────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/news-quiz.html');
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

// ── Email helper (Resend) ─────────────────────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('Email skipped: RESEND_API_KEY not set.');
    return false;
  }
  const body = JSON.stringify({
    from: 'Baltimore Daily Dispatch Quiz <onboarding@resend.dev>',
    to: [to],
    subject,
    html
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

// ── Message board ─────────────────────────────────────────────
// Posts stored as data.posts = [{ id, playerName, text, createdAt, deleted }]

app.get('/api/posts', (req, res) => {
  const data = readData();
  const posts = (data.posts || []).filter(p => !p.deleted);
  res.json({ posts });
});

app.post('/api/posts', (req, res) => {
  const { playerName, text } = req.body;
  if (!playerName || !playerName.trim()) return res.status(400).json({ error: 'Player name required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long (500 char max).' });

  const data = readData();
  if (!data.posts) data.posts = [];
  const post = {
    id: Date.now().toString(),
    playerName: playerName.trim().slice(0, 40),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };
  data.posts.unshift(post); // newest first
  if (data.posts.length > 200) data.posts = data.posts.slice(0, 200); // cap at 200
  writeData(data);
  res.json({ ok: true, post });
});

app.delete('/api/posts/:id', (req, res) => {
  const data = readData();
  const post = (data.posts || []).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  post.deleted = true;
  writeData(data);
  res.json({ ok: true });
});

// ── Contact the Editor ────────────────────────────────────────
// Messages stored as data.messages = [{ id, playerName, text, createdAt, read }]

app.post('/api/contact', async (req, res) => {
  const { playerName, text } = req.body;
  if (!playerName || !playerName.trim()) return res.status(400).json({ error: 'Player name required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message required.' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message too long (1000 char max).' });

  const data = readData();
  if (!data.messages) data.messages = [];
  const msg = {
    id: Date.now().toString(),
    playerName: playerName.trim().slice(0, 40),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    read: false
  };
  data.messages.unshift(msg);
  writeData(data);

  // Forward to editor's email
  const editorEmail = process.env.EDITOR_EMAIL;
  if (editorEmail) {
    await sendEmail(
      editorEmail,
      `Quiz message from ${msg.playerName}`,
      `<p><strong>From:</strong> ${msg.playerName}</p>
       <p><strong>Sent:</strong> ${new Date(msg.createdAt).toLocaleString()}</p>
       <hr>
       <p>${msg.text.replace(/\n/g, '<br>')}</p>
       <hr>
       <p style="color:#999;font-size:12px;">Baltimore Daily Dispatch Quiz</p>`
    );
  }

  res.json({ ok: true });
});

app.get('/api/messages', (req, res) => {
  const data = readData();
  res.json({ messages: data.messages || [] });
});

app.post('/api/messages/:id/read', (req, res) => {
  const data = readData();
  const msg = (data.messages || []).find(m => m.id === req.params.id);
  if (msg) { msg.read = true; writeData(data); }
  res.json({ ok: true });
});
