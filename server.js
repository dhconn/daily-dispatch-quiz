const express = require('express');
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.dirname(__filename), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Postgres connection ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Key-value store backed by Postgres ───────────────────────
// Single table: store(key TEXT PRIMARY KEY, value JSONB)
// This mirrors the old await readData()/await writeData() pattern exactly.

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);
  console.log('DB: store table ready.');
}

async function getKey(key) {
  try {
    const r = await pool.query('SELECT value FROM store WHERE key=$1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch(e) { console.error('getKey error', key, e.message); return null; }
}

async function setKey(key, value) {
  try {
    await pool.query(
      'INSERT INTO store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [key, JSON.stringify(value)]
    );
    return true;
  } catch(e) { console.error('setKey error', key, e.message); return false; }
}

// Legacy sync-style shims — kept so the rest of the code changes minimally.
// All callers that used await readData()/await writeData() now use async versions below.
async function readData() {
  const keys = ['sites','rssCache','scores','dist','quizzes','archiveUrls',
                 'archiveQuestions','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate','emailSentDates','prospects'];
  const data = {};
  await Promise.all(keys.map(async k => {
    const v = await getKey(k);
    if (v !== null) data[k] = v;
  }));
  return data;
}

async function writeData(data) {
  const keys = ['sites','rssCache','scores','dist','quizzes','archiveUrls',
                 'archiveQuestions','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate','emailSentDates','prospects'];
  await Promise.all(keys.map(async k => {
    if (data[k] === null) await setKey(k, null);
    else if (data[k] !== undefined) await setKey(k, data[k]);
  }));
  return true;
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
    const link = get('link')
      || (block.match(/<link[^>]+href="([^"]+)"/i)||[])[1]
      || (block.match(/<guid[^>]*>([^<]+)<\/guid>/i)||[])[1]
      || (block.match(/href="(https?:\/\/[^"]+)"/)||[])[1]
      || '';
    const pubDate = get('pubDate') || get('published') || get('updated') || '';

    if (title) {
      items.push({ title, description: description.slice(0, 2000), link, pubDate });
    }
  }
  return items;
}

// Known RSS feeds for Baltimore news sites
const BALTIMORE_RSS_FEEDS = {
  // Pure local outlets — confirmed working
  'baltimoretimes-online.com':  'https://baltimoretimes-online.com/feed/',
  'marylandmatters.org':        'https://marylandmatters.org/feed/',
  'thedailyrecord.com':         'https://thedailyrecord.com/feed/',
  'baltimorefishbowl.com':      'https://baltimorefishbowl.com/feed/',
  'southbmore.com':             'https://www.southbmore.com/feed/',
  'cbsnews.com/baltimore':      'https://www.cbsnews.com/baltimore/latest/rss/main',
  // Pure local — feed URLs need alternate versions
  'baltimorebrew.com':          'https://baltimorebrew.com/feed/rss/',
  'thebanner.com':              'https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/',
  'thebaltimorebanner.com':     'https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/',
  'wypr.org':                   'https://www.wypr.org/podcast/news/rss.xml',
  'baltimoresun.com':           'https://www.baltimoresun.com/arc/outboundfeeds/rss/',
  'bizjournals.com/baltimore':  'https://www.bizjournals.com/baltimore/feed/news/local.rss',
  'technical.ly':               'https://technical.ly/baltimore/feed/',
  'dailyvoice.com':             'https://dailyvoice.com/maryland/feed.rss',
  // TV stations — keyword filtered
  'foxbaltimore.com':           'https://foxbaltimore.com/rss',
  'wbaltv.com':                 'https://www.wbaltv.com/rss',
  'wmar2news.com':              'https://www.wmar2news.com/rss',
  'wbal.com':                   'https://www.wbal.com/rss',
  'mytvbaltimore.com':          'https://foxbaltimore.com/rss',
  'cwbaltimore.com':            'https://www.wmar2news.com/rss',
  // Additional local sources
  'afro.com':                   'https://afro.com/feed/',
  'urbanleaguebaltimore.org':   'https://urbanleaguebaltimore.org/feed/',
  'baltimoremagazine.com':      'https://www.baltimoremagazine.com/feed/',
  'citypaper.com':              'https://www.citypaper.com/feed/',
};

// Filter items to last 24 hours
function isRecent(pubDate) {
  if (!pubDate) return true; // include if no date
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return true; // unparseable date — include it
    return (Date.now() - d.getTime()) < 72 * 60 * 60 * 1000; // 72hr window
  } catch(e) { return true; }
}

// ── RSS cache ─────────────────────────────────────────────────
// Articles are fetched in the background and cached in memory.
// The cache is refreshed on startup and via the /api/rss/refresh endpoint.

async function fetchAndCacheRSS() {
  const data = await readData();
  const savedSites = (data.sites || '').split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !s.includes('google.com') && !s.includes('therealnews.com')); // skip non-RSS sources
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

  // Keywords that indicate a story is local to Baltimore/Central Maryland
  const LOCAL_KEYWORDS = [
    'baltimore', 'maryland', ' md ', 'md\'s', ' md:', 'annapolis', 'towson', 'bethesda', 'silver spring',
    'columbia', 'ellicott city', 'bowie', 'laurel', 'rockville', 'gaithersburg',
    'hagerstown', 'frederick', 'salisbury', 'ocean city', 'chesapeake',
    'orioles', 'ravens', 'terps', 'terrapins', 'shock trauma', 'jhu', 'johns hopkins',
    'morgan state', 'loyola', 'umbc', 'umd', 'bge', 'mta maryland',
    'harford', 'howard county', 'anne arundel', 'carroll county', 'prince george',
    'washington county', 'wicomico', 'worcester', 'somerset', 'dorchester',
    'kent county', 'queen anne', 'talbot', 'caroline', 'cecil county', 'calvert', 'charles county'
  ];

  // URLs that are too sensitive/graphic for a community quiz
  const BLACKLISTED_URLS = [
    'university-maryland-police-sexual-misconduct',
    '/sponsored-content/',
    '/advertorial/',
    '/paid-content/',
    // Persistent national wire stories with no Maryland angle
    'us-rules-supreme-court-colorado-oil-climate-lawsuit',
    'heres-what-to-know-about-the-dhs-funding-shutdown',
    'supreme-court-nra-free-speech-ny-official',
    'federal-rules-louisiana-ten-commandments-law-schools-appeals',
    // Baltimore Times food article — Claude invariably asks about Atlanta conference detail
    'the-weight-we-carry-food-labor-and-black-womens-bodies-as-living-archives',
  ];

  function isLocalStory(item, site) {
    // Skip CBS video pages — articles have more usable text for quiz generation
    if (site.includes('cbsnews') && (item.link || '').includes('/video/')) return false;

    // Filter DC sports teams — Nationals, Commanders, Capitals, Wizards
    // These appear in Banner's sports section but have no Baltimore relevance
    const itemLink = (item.link || '').toLowerCase();
    const itemTitle = (item.title || '').toLowerCase();
    const dcSportsPatterns = [
      '/nationals-mlb/', '/commanders-nfl/', '/capitals-nhl/', '/wizards-nba/',
      'nationals spring training', 'washington nationals',
      'washington commanders'
    ];
    if (dcSportsPatterns.some(p => itemLink.includes(p) || itemTitle.includes(p))) return false;

    // Filter weather forecasts — only keep if headline suggests historic/major storm
    const weatherPatterns = ['first alert', 'degrees', 'temperatures', 'forecast',
      'rain and snow', 'showers', 'warmer', 'colder', 'milder', 'weekend weather'];
    const majorWeather = ['blizzard', 'hurricane', 'tornado', 'historic storm',
      'state of emergency', 'major flooding', 'power outages'];
    if (weatherPatterns.some(p => itemTitle.includes(p)) &&
        !majorWeather.some(p => itemTitle.includes(p))) return false;
    // These outlets publish ONLY local Baltimore/Maryland content — trust everything
    // Truly hyper-local outlets — every story is Baltimore/Maryland specific
    // Hyper-local outlets — trust everything they publish
    const pureLocalSites = [
      'baltimorebrew', 'baltimoretimes', 'baltimorefishbowl', 'southbmore',
      'bizjournals.com/baltimore', 'technical.ly', 'wypr.org', 'marylandmatters',
      'baltimorebanner', 'thebanner.com', 'baltimoresun', 'afro.com',
      'baltimoremagazine', 'citypaper.com'
    ];
    if (pureLocalSites.some(s => site.includes(s))) return true;

    // Daily Record and TV stations mix local with national wire — require keyword in title
    const title = (item.title || '').toLowerCase();
    return LOCAL_KEYWORDS.some(kw => title.includes(kw)) || title.startsWith('md ');
  }

  const fetchWithTimeout = (site, feedUrl) => new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(), 8000);
    try {
      const xml = await fetchUrl(feedUrl);
      const parsed = parseRSS(xml);
      const recent = parsed.filter(item => isRecent(item.pubDate));
      const items = recent.filter(item => isLocalStory(item, site));
      console.log(`RSS OK: ${feedUrl} — ${parsed.length} total, ${recent.length} recent, ${items.length} local`);
      if (parsed.length > 0 && recent.length === 0) {
        console.log(`  oldest item date: ${parsed[parsed.length-1].pubDate}`);
      }
      items.forEach(item => allItems.push({ ...item, source: site }));
    } catch(e) {
      errors.push(`${feedUrl}: ${e.message}`);
      console.log(`RSS FAIL: ${feedUrl} — ${e.message}`);
    } finally {
      clearTimeout(timer);
      resolve();
    }
  });

  await Promise.allSettled(feedsToFetch.map(({ site, feedUrl }) => fetchWithTimeout(site, feedUrl)));

  // Deduplicate by title, then cap per source at 10 articles
  const seen = new Set();
  const sourceCount = {};
  const unique = allItems.filter(item => {
    // Exact title dedup
    const titleKey = item.title.toLowerCase().trim();
    if (seen.has(titleKey)) return false;
    seen.add(titleKey);
    // Per-source cap — prevent any one source dominating
    const src = item.source || 'unknown';
    sourceCount[src] = (sourceCount[src] || 0) + 1;
    // Baltimore Banner gets a higher cap since it's our richest pure-local source
    const cap = src.includes('thebanner') || src.includes('thebaltimorebanner') ? 30 : 15;
    if (sourceCount[src] > cap) return false;
    return true;
  });

  // Save to data file
  const freshData = await readData();
  freshData.rssCache = {
    items: unique.slice(0, 100),
    fetchedAt: new Date().toISOString(),
    errors: errors.length ? errors : []
  };
  await writeData(freshData);
  console.log(`RSS: Cached ${unique.length} articles. Errors: ${errors.length}`);
}

// ── Email helper (Resend) ─────────────────────────────────────

// Scheduled daily refresh at 6am Eastern time
function scheduleNextRefresh() {
  const now = new Date();
  const next = new Date();
  // 6am Eastern = 11am UTC (EST) or 10am UTC (EDT)
  const utcHour = 11;
  next.setUTCHours(utcHour, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1); // tomorrow if already past
  const msUntil = next - now;
  console.log(`RSS: Next scheduled refresh in ${Math.round(msUntil/60000)} minutes (6am Eastern).`);
  setTimeout(() => {
    fetchAndCacheRSS();
    scheduleNextRefresh(); // schedule the next day's refresh
  }, msUntil);
}
scheduleNextRefresh();

// ── GET /api/rss/debug — show all cached articles grouped by source ──
app.get('/api/rss/debug', async (req, res) => {
  const data = await readData();
  const cache = data.rssCache || { items: [], fetchedAt: null };
  
  // Group by source
  const bySource = {};
  for (const item of cache.items) {
    const src = item.source || 'unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push({ title: item.title, pubDate: item.pubDate, link: item.link });
  }

  res.json({
    version: '2.2-banner30',
    fetchedAt: cache.fetchedAt,
    totalCount: cache.items.length,
    errors: cache.errors || [],
    bySource
  });
});

// ── GET /api/rss — return cached articles ─────────────────────
app.get('/api/rss', async (req, res) => {
  const data = await readData();
  const cache = data.rssCache || { items: [], fetchedAt: null, errors: [] };
  res.json(cache);
});

// ── POST /api/rss/refresh — manually trigger a fresh fetch ────
app.post('/api/rss/refresh', async (req, res) => {
  res.json({ ok: true, message: 'RSS refresh started in background.' });
  fetchAndCacheRSS(); // run in background, don't await
});

// ── Redirect root to quiz ────────────────────────────────────
app.get('/', async (req, res) => {
  res.redirect('/news-quiz.html');
});

// ── Save/load news sites ──────────────────────────────────────
app.post('/api/sites', async (req, res) => {
  const { sites } = req.body || {};
  if (typeof sites !== 'string') return res.status(400).json({ error: 'sites must be a string' });
  const data = await readData();
  data.sites = sites;
  await writeData(data);
  res.json({ ok: true });
});

app.get('/api/sites', async (req, res) => {
  const data = await readData();
  res.json({ sites: data.sites || '' });
});

// ── Answer distribution ──────────────────────────────────────
app.post('/api/answers', async (req, res) => {
  const { date, answers, playerName } = req.body || {};
  if (!date || !Array.isArray(answers)) return res.status(400).json({ error: 'bad request' });
  const data = await readData();
  if (!data.dist) data.dist = {};
  if (!data.dist[date]) data.dist[date] = {};

  answers.forEach(({ qIdx, correct }) => {
    if (qIdx === 'completion') return;
    const k = 'q' + qIdx;
    if (!data.dist[date][k]) data.dist[date][k] = { correct: 0, wrong: 0 };
    if (correct) data.dist[date][k].correct++;
    else data.dist[date][k].wrong++;
  });

  if (playerName && playerName.trim()) {
    const key = playerName.trim().toLowerCase();
    if (!data.dist[date].players) data.dist[date].players = {};
    if (!data.dist[date].players[key]) {
      data.dist[date].players[key] = { displayName: playerName.trim(), answers: {} };
    }
    answers.forEach(({ qIdx, correct }) => {
      if (qIdx !== 'completion') {
        data.dist[date].players[key].answers['q' + qIdx] = correct;
      }
    });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);
  Object.keys(data.dist).forEach(d => {
    if (new Date(d) < cutoff) delete data.dist[d];
  });

  await writeData(data);
  res.json({ ok: true });
});

// GET /api/answers?date=YYYY-MM-DD
app.get('/api/answers', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const data = await readData();
  res.json((data.dist && data.dist[date]) || {});
});

// ── Quiz start tracking ───────────────────────────────────────
// Records when a player starts the quiz — used for completion rate.
// POST /api/quiz-start  { date }
app.post('/api/quiz-start', async (req, res) => {
  const { date } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required' });
  const starts = (await getKey('quizStarts')) || {};
  starts[date] = (starts[date] || 0) + 1;
  await setKey('quizStarts', starts);
  res.json({ ok: true });
});

// GET /api/quiz-starts?date=YYYY-MM-DD
app.get('/api/quiz-starts', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const starts = (await getKey('quizStarts')) || {};
  res.json({ starts: starts[date] || 0, date });
});

// ── Article text fetcher ──────────────────────────────────────
// Fetches full article text for a given URL, stripping HTML tags.
// Used to give Claude full article content instead of just RSS snippets.
app.post('/api/fetch-article', async (req, res) => {
  const { url } = req.body  || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const html = await fetchUrl(url);

    // Strip script/style blocks first
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Try to extract main article body — look for common content containers
    const articleMatch = text.match(/<article[\s\S]*?<\/article>/i)
      || text.match(/<main[\s\S]*?<\/main>/i)
      || text.match(/class="[^"]*(?:article|story|content|post|entry)-body[^"]*"[\s\S]*?<\/div>/i);

    if (articleMatch) text = articleMatch[0];

    // Strip remaining HTML tags and decode entities
    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Cap at 1500 chars — enough for Claude to write a good question, keeps prompt lean
    const excerpt = text.slice(0, 1500);

    if (excerpt.length < 100) {
      return res.json({ ok: false, reason: 'paywall or insufficient content', excerpt: '' });
    }

    res.json({ ok: true, excerpt });
  } catch(e) {
    res.json({ ok: false, reason: e.message, excerpt: '' });
  }
});

// ── Canonical per-player quiz progress ───────────────────────
// Stored as progress = { [date]: { [playerKey]: { displayName, score, currentQ, completed, answers, startedAt, updatedAt } } }

app.post('/api/progress', async (req, res) => {
  const { playerName, date, progress } = req.body || {};

  if (!playerName || !date || !progress || typeof progress !== 'object') {
    return res.status(400).json({ error: 'playerName, date, and progress required' });
  }

  try {
    const allProgress = (await getKey('progress')) || {};
    if (!allProgress[date]) allProgress[date] = {};

    const key = playerName.toLowerCase().trim();
    const existing = allProgress[date][key] || {};

    allProgress[date][key] = {
      ...existing,
      ...progress,
      displayName: playerName.trim(),
      updatedAt: new Date().toISOString()
    };

    await setKey('progress', allProgress);
    res.json({ ok: true });
  } catch (e) {
    console.error('[progress] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/progress?date=YYYY-MM-DD
// GET /api/progress?date=YYYY-MM-DD&playerName=RKE
app.get('/api/progress', async (req, res) => {
  const { date, playerName } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  try {
    const allProgress = (await getKey('progress')) || {};
    const progressForDate = allProgress[date] || {};

    if (playerName) {
      const key = playerName.toLowerCase().trim();
      return res.json(progressForDate[key] || null);
    }

    res.json(progressForDate);
  } catch (e) {
    console.error('[progress] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Leaderboard ───────────────────────────────────────────────
// Scores stored as data.scores = { playerKey: { displayName, allTime, dailyScores: {date: score} } }

app.post('/api/scores', async (req, res) => {
  const { playerName, date, score } = req.body  || {};

  // 🔍 Log incoming request
  console.log('[scores] incoming', {
    playerName,
    date,
    score,
    ts: new Date().toISOString()
  });

  if (!playerName || !date || typeof score !== 'number') {
    console.error('[scores] bad request', req.body);
    return res.status(400).json({ error: 'playerName, date, and score required' });
  }

  try {
    const data = await readData();
    if (!data.scores) data.scores = {};

    const key = playerName.toLowerCase().trim();

    if (!data.scores[key]) {
      data.scores[key] = {
        displayName: playerName.trim(),
        allTime: 0,
        dailyScores: {}
      };
    }

    // 🔍 Log overwrite behavior
    const prev = data.scores[key].dailyScores[date];

    // Always overwrite with latest score
    data.scores[key].dailyScores[date] = score;

    // Recompute all-time
    data.scores[key].allTime = Object.values(
      data.scores[key].dailyScores
    ).reduce((a, b) => a + b, 0);

    await writeData(data);

    // 🔍 Log success
    console.log('[scores] saved', {
      playerKey: key,
      displayName: data.scores[key].displayName,
      date,
      previousScore: prev,
      newScore: score,
      allTime: data.scores[key].allTime
    });

    res.json({ ok: true });

  } catch (e) {
    console.error('[scores] error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/scores/:playerKey — admin delete a player ────
app.delete('/api/scores/:playerKey', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const key = req.params.playerKey.toLowerCase().trim();
  const data = await readData();
  if (!data.scores || !data.scores[key]) return res.status(404).json({ error: 'Player not found' });
  const name = data.scores[key].displayName;
  delete data.scores[key];
  await writeData(data);
  console.log('[Admin] Deleted player:', key);
  res.json({ ok: true, deleted: name });
});

app.get('/api/scores', async (req, res) => {
  const data = await readData();
  res.json({ scores: data.scores || {} });
});

// ── Archive (used article URLs + question text) ───────────────
app.get('/api/archive', async (req, res) => {
  const data = await readData();
  res.json({ urls: data.archiveUrls || [], questions: data.archiveQuestions || [], slugs: data.archiveSlugs || [] });
});

app.post('/api/archive', async (req, res) => {
  const { urls, questions, slugs } = req.body;
  const data = await readData();
  if (!data.archiveUrls) data.archiveUrls = [];
  if (!data.archiveQuestions) data.archiveQuestions = [];
  if (!data.archiveSlugs) data.archiveSlugs = [];
  if (urls) {
    urls.forEach(u => { if (!data.archiveUrls.includes(u)) data.archiveUrls.push(u); });
  }
  if (questions) {
    questions.forEach(q => { if (!data.archiveQuestions.includes(q)) data.archiveQuestions.push(q); });
  }
  if (slugs) {
    slugs.forEach(s => { if (s && !data.archiveSlugs.includes(s)) data.archiveSlugs.push(s); });
  }
  // Keep last 60 entries (~1 week)
  if (data.archiveUrls.length > 60) data.archiveUrls = data.archiveUrls.slice(-60);
  if (data.archiveQuestions.length > 60) data.archiveQuestions = data.archiveQuestions.slice(-60);
  if (data.archiveSlugs.length > 60) data.archiveSlugs = data.archiveSlugs.slice(-60);
  await writeData(data);
  res.json({ ok: true });
});

// ── Subscribers ───────────────────────────────────────────────
// Stored as data.subscribers = { email: { name, subscribedAt, active } }

app.post('/api/subscribe', async (req, res) => {
  const { name, email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });
  const data = await readData();
  if (!data.subscribers) data.subscribers = {};
  const key = email.toLowerCase().trim();
  data.subscribers[key] = {
    name: (name || '').trim().slice(0, 40),
    email: key,
    subscribedAt: data.subscribers[key]?.subscribedAt || new Date().toISOString(),
    active: true
  };
  if (data.prospects && data.prospects[key]) {
  data.prospects[key].active = false;
  }
  await writeData(data);
  res.json({ ok: true });
});

app.get('/api/unsubscribe', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send('Missing email.');
  const data = await readData();
  const key = decodeURIComponent(email).toLowerCase().trim();
  if (data.subscribers && data.subscribers[key]) {
    data.subscribers[key].active = false;
    await writeData(data);
  }
  res.send(`
    <html><body style="font-family:Georgia,serif;max-width:500px;margin:60px auto;text-align:center;">
      <h2>You've been unsubscribed.</h2>
      <p style="color:#666;">You won't receive any more quiz notifications at ${key}.</p>
      <p><a href="/">Return to the quiz</a></p>
    </body></html>
  `);
});

// Helper: get today's date in Eastern time (quiz is Baltimore-based)
function easternToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── GET /api/quiz/latest — always return the most recently published quiz ──
app.get('/api/quiz/latest', async (req, res) => {
  const data = await readData();
  if (!data.quizzes) return res.json({ quiz: null });
  const dates = Object.keys(data.quizzes).sort();
  if (dates.length === 0) return res.json({ quiz: null });
  const mostRecent = dates[dates.length - 1];
  res.json({ quiz: data.quizzes[mostRecent], date: mostRecent });
});

// ── POST /api/quiz/fix-date — copy most recent quiz to today's Eastern date ──
app.post('/api/quiz/fix-date', async (req, res) => {
  const data = await readData();
  if (!data.quizzes) return res.status(404).json({ error: 'No quizzes found' });
  const dates = Object.keys(data.quizzes).sort();
  if (dates.length === 0) return res.status(404).json({ error: 'No quizzes found' });
  const mostRecent = dates[dates.length - 1];
  // Get today in Eastern time
  const todayEastern = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (mostRecent === todayEastern) {
    return res.json({ ok: true, message: 'Already stored under correct date', date: mostRecent });
  }
  // Copy to today's key
  data.quizzes[todayEastern] = { ...data.quizzes[mostRecent], publishDate: todayEastern };
  await writeData(data);
  res.json({ ok: true, message: `Copied from ${mostRecent} to ${todayEastern}`, from: mostRecent, to: todayEastern });
});

// ── Generate teaser phrases for email ────────────────────────
async function generateTeasers(questions) {
  return new Promise((resolve) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { resolve([]); return; }
    const questionList = questions.map((q, i) => `Q${i+1}: ${q.question}`).join('\n');
    const prompt = `You are writing teaser lines for a Baltimore local news quiz email.
Here are today's quiz questions:
${questionList}

Pick the 3 most interesting or surprising topics. For each, write a 3-5 word teaser phrase that hints at the topic without giving away the answer.
Style: slightly mysterious, intriguing, like a newspaper front page tease.
Examples: "A soccer superstar arrives", "Cheese steaks cross state lines", "The Constitution meets zoning law"

Respond with ONLY a JSON array of 3 strings. No preamble, no markdown.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content || []).map(c => c.text || '').join('').trim();
          const clean = text.replace(/```json|```/g, '').trim();
          const teasers = JSON.parse(clean);
          resolve(Array.isArray(teasers) ? teasers.slice(0, 3) : []);
        } catch(e) {
          console.warn('Teaser parse failed:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => { console.warn('Teaser request failed:', e.message); resolve([]); });
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

function buildTeaserHtml(teasers) {
  if (!teasers || teasers.length === 0) return '';
  return `
    <div style="margin:0 0 28px;padding:20px;background:#fff;border:1px solid #e0d8cc;text-align:left;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#999;margin-bottom:12px;">TODAY'S TOPICS INCLUDE…</div>
      ${teasers.map(t => `<div style="font-family:Georgia,serif;font-size:15px;color:#1a1008;padding:6px 0;border-bottom:1px solid #f0ebe0;">· ${t}</div>`).join('')}
    </div>`;
}

function buildEmailHtml(siteUrl, date, subscriberName, teaserHtml, unsubUrl) {
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
    <a href="${siteUrl}" style="display:block;text-decoration:none;color:inherit;">
    <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
      <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
      <div style="font-size:28px;font-weight:bold;">The Daily Dispatch Quiz</div>
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#aaa;margin-top:6px;">${date}</div>
    </div>
    </a>
    <div style="padding:32px 24px;background:#f5f0e8;text-align:center;">
      <p style="font-size:18px;margin:0 0 8px;">Hi${subscriberName ? ' ' + subscriberName : ''},</p>
      <p style="font-size:16px;color:#444;margin:0 0 8px;">6 questions. 90 seconds.</p>
      <p style="font-size:16px;color:#444;margin:0 0 24px;">How closely are you following the news?</p>
      ${teaserHtml}
      <a href="${siteUrl}" style="display:inline-block;background:#1a1008;color:#f5f0e8;padding:16px 36px;font-family:monospace;font-size:13px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Play Today's Quiz ▸</a>

<!--SUBSCRIBE_INSERT_POINT-->
    </div>
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>
  </div>`;
}

// ── GET /api/blocklist — fetch topic blocklist ───────────────
app.get('/api/blocklist', async (req, res) => {
  const data = await readData();
  res.json({ blocklist: data.topicBlocklist || [] });
});

// ── POST /api/blocklist — save topic blocklist ────────────────
app.post('/api/blocklist', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  data.topicBlocklist = Array.isArray(req.body.blocklist) ? req.body.blocklist : [];
  await writeData(data);
  console.log('[Admin] Topic blocklist updated: ' + data.topicBlocklist.length + ' item(s)');
  res.json({ ok: true, blocklist: data.topicBlocklist });
});

// ── GET /api/email-pause — get current pause state ──────────
app.get('/api/email-pause', async (req, res) => {
  const data = await readData();
  res.json({ paused: !!data.emailPaused });
});

// ── POST /api/email-pause — set pause state ───────────────────
app.post('/api/email-pause', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  const pausing = !!req.body.paused;
  data.emailPaused = pausing;
  const subs = data.subscribers || {};
  if (pausing) {
    // Snapshot who is currently active, then pause them all
    data.emailPausedSnapshot = Object.keys(subs).filter(k => subs[k].active);
    data.emailPausedSnapshot.forEach(k => { if (subs[k]) subs[k].active = false; });
    console.log('[Admin] Email PAUSED — ' + data.emailPausedSnapshot.length + ' subscriber(s) paused');
  } else {
    // Restore snapshot subscribers, but also keep anyone manually activated during the pause
    const snapshot = data.emailPausedSnapshot || [];
    snapshot.forEach(k => { if (subs[k]) subs[k].active = true; });
    // Anyone already active (manually reactivated during pause) stays active — no change needed
    data.emailPausedSnapshot = null;
    const restored = Object.values(subs).filter(s => s.active).length;
    console.log('[Admin] Email RESUMED — ' + restored + ' subscriber(s) active');
  }
  await writeData(data);
  res.json({ ok: true, paused: data.emailPaused });
});

// ── POST /api/teaser-cache — save edited teasers for use on publish ──────
app.post('/api/teaser-cache', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const { teaserHtml, date } = req.body;
  if (!teaserHtml || !date) return res.status(400).json({ error: 'teaserHtml and date required' });
  const data = await readData();
  data.cachedTeaserHtml = teaserHtml;
  data.cachedTeaserDate = date;
  await writeData(data);
  console.log('[Admin] Teaser cache updated for', date);
  res.json({ ok: true });
});

// ── GET/POST /api/quiz/preview-email — generate teaser preview for admin ──
// POST body: { questions: [...] } uses draft questions directly
// GET falls back to most recently published quiz
app.all('/api/quiz/preview-email', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  let questions = null;
  let dateLabel = new Date().toISOString().slice(0, 10);

  if (req.method === 'POST' && req.body && req.body.questions && req.body.questions.length) {
    // Use draft questions passed from client
    questions = req.body.questions;
    console.log('[PreviewEmail] Using draft questions:', questions.length);
  } else {
    // Fall back to most recently published quiz
    const data = await readData();
    const dates = Object.keys(data.quizzes || {}).sort();
    if (!dates.length) return res.json({ html: '<p>No quiz published yet.</p>' });
    dateLabel = dates[dates.length - 1];
    questions = data.quizzes[dateLabel].questions || [];
    console.log('[PreviewEmail] Using published quiz:', dateLabel);
  }

  const teasers = await generateTeasers(questions);
  const teaserHtml = buildTeaserHtml(teasers);
  const html = buildEmailHtml(siteUrl, dateLabel, 'Subscriber', teaserHtml, siteUrl + '/api/unsubscribe?email=example');
  // Cache teasers so publish can reuse them without regenerating
  const previewData = await readData();
  previewData.cachedTeaserHtml = teaserHtml;
  previewData.cachedTeaserDate = dateLabel;
  await writeData(previewData);
  res.json({ html, teasers });
});


app.get('/api/quiz/all', async (req, res) => {
  const data = await readData();
  res.json({ quizzes: data.quizzes || {} });
});

// ── GET /api/quiz/archive — return list of available past quiz dates ──
app.get('/api/quiz/archive', async (req, res) => {
  const data = await readData();
  const quizzes = data.quizzes || {};
  const today = easternToday();
  // Return all dates except today, sorted newest first, capped at 7
  const dates = Object.keys(quizzes)
    .filter(d => d !== today)
    .sort()
    .reverse()
    .slice(0, 7);
  res.json({ dates });
});

// ── GET /api/subscribers — return subscriber list for admin ───
app.get('/api/subscribers', async (req, res) => {
  const data = await readData();
  const subs = Object.values(data.subscribers || {})
    .sort((a, b) => new Date(b.subscribedAt) - new Date(a.subscribedAt));
  res.json({ subscribers: subs });
});

// ── PATCH /api/subscribers/:email — toggle active status ──────
app.patch('/api/subscribers/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
  const data = await readData();
  if (!data.subscribers || !data.subscribers[email]) return res.status(404).json({ error: 'subscriber not found' });
  data.subscribers[email].active = active;
  await writeData(data);
  res.json({ ok: true, email, active });
});

// ── Quiz persistence ──────────────────────────────────────────
// Save published quiz to server so it survives browser/device changes
app.post('/api/quiz', async (req, res) => {
  const { date, quiz, silent } = req.body;
  if (!date || !quiz) return res.status(400).json({ error: 'date and quiz required' });
  const data = await readData();
  if (!data.quizzes) data.quizzes = {};
  data.quizzes[date] = quiz;
  // Keep only last 14 days
  const keys = Object.keys(data.quizzes).sort();
  if (keys.length > 14) keys.slice(0, keys.length - 14).forEach(k => delete data.quizzes[k]);
  await writeData(data);

  // Send notification emails — skipped for silent saves (emergency save, edits, fixes)
  // Also skipped if emails were already sent for this date (prevents double-send on re-publish)
  if (!silent) {
    const siteUrl = process.env.SITE_URL || 'https://your-app.railway.app';
    const freshData = await readData();

    // Guard: never send twice for the same date
    if (!freshData.emailSentDates) freshData.emailSentDates = [];
    if (freshData.emailSentDates.includes(date)) {
      console.log(`[Email] Already sent notifications for ${date} — skipping duplicate send.`);
      return res.json({ ok: true });
    }
    if (freshData.emailPaused) {
      console.log('Email notifications are globally paused — skipping subscriber and prospect emails.');
    }
      const dow = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
      const subjects = {
        Monday:    "Start off the week by climbing the Baltimore news Leaderboard",
        Tuesday:   "Can you beat today's Baltimore news quiz?",
        Wednesday: "6 questions about today's Baltimore headlines",
        Thursday:  "Think you know today's Baltimore news?",
        Friday:    "Friday - I'm in love, with the Daily Dispatch News Quiz",
        Saturday:  "A very special Saturday Dispatch News Quiz is live",
        Sunday:    "It's Sunday - relax and play the (90-second) Balt. News Quiz"
      };
      const subject = subjects[dow] || `Today's Baltimore Daily Dispatch Quiz is live — ${date}`;

      let teaserHtml;
      if (freshData.cachedTeaserHtml && freshData.cachedTeaserDate === date) {
        console.log('[Email] Reusing cached teasers from preview for', date);
        teaserHtml = freshData.cachedTeaserHtml;
      } else {
        console.log('[Email] No cached teasers found, generating fresh');
        const teasers = await generateTeasers(quiz.questions || []);
        teaserHtml = buildTeaserHtml(teasers);
        console.log('Email teasers:', teasers.length ? teasers : 'none generated');
      }

    let sentAnyEmails = false;

    const subscribers = freshData.emailPaused ? [] : Object.values(freshData.subscribers || {}).filter(s => s.active);
    if (subscribers.length > 0) {
      console.log(`Email: Sending quiz notification to ${subscribers.length} subscribers…`);

      const emails = subscribers.map(sub => {
        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(sub.email)}`;
        return {
          from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
          reply_to: 'dhconn@gmail.com',
          to: [sub.email],
          subject,
          html: buildEmailHtml(siteUrl, date, sub.name, teaserHtml, unsubUrl)
        };
      });
      await sendEmailBatch(emails);
      sentAnyEmails = true;
    }

    // Send to prospects — same email + one-click subscribe button
    const activeProspects = freshData.emailPaused
      ? []
      : Object.values(freshData.prospects || {}).filter(p => p.active !== false);

    if (activeProspects.length > 0) {
      console.log(`[Prospects] Sending quiz email to ${activeProspects.length} prospect(s)…`);
      console.log('[Prospects DEBUG] activeProspects:', activeProspects.length);

      const prospectEmails = activeProspects.map(p => {
        const subscribeUrl = `${siteUrl}/subscribe?email=${encodeURIComponent(p.email)}&name=${encodeURIComponent(p.name || '')}`;
        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(p.email)}`;
        const baseHtml = buildEmailHtml(siteUrl, date, p.name, teaserHtml, unsubUrl);

        // Inject subscribe button before the unsubscribe footer
        const subscribeBtn = `
          <div style="padding:20px 24px;text-align:center;background:#f5f0e8;border-top:1px solid #e0d8cc;">
            <p style="font-family:monospace;font-size:11px;letter-spacing:1px;color:#6b5f4e;margin-bottom:12px;">GET THIS AUTOMATICALLY EVERY MORNING</p>
            <a href="${subscribeUrl}" style="display:inline-block;background:#c0392b;color:white;padding:12px 28px;font-family:monospace;font-size:12px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Subscribe Free &#9658;</a>
          </div>`;

        const html = baseHtml.replace('<!--SUBSCRIBE_INSERT_POINT-->', subscribeBtn);

        return {
          from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
          reply_to: 'dhconn@gmail.com',
          to: [p.email],
          subject,
          html
        };
      });
      await sendEmailBatch(prospectEmails);
      sentAnyEmails = true;
    }
    if (sentAnyEmails) {
      freshData.emailSentDates = [...(freshData.emailSentDates || []), date].slice(-30);
      await writeData(freshData);
    }
  } else {
    console.log('Silent save — email notifications skipped.');
  }

  res.json({ ok: true });
});

app.get('/api/quiz', async (req, res) => {
  const { date } = req.query;
  const data = await readData();
  if (!data.quizzes) return res.json({ quiz: null });

  const dates = Object.keys(data.quizzes).sort();
  if (dates.length === 0) return res.json({ quiz: null });

  // Exact date match
  if (date && data.quizzes[date]) {
    return res.json({ quiz: data.quizzes[date], date });
  }

  // Always fall back to most recently published quiz regardless of date
  const mostRecent = dates[dates.length - 1];
  res.json({ quiz: data.quizzes[mostRecent], date: mostRecent, fallback: true });
});

// ── Anthropic API proxy ───────────────────────────────────────
app.post('/api/claude', async (req, res) => {
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
    if (!res.headersSent) res.status(502).json({ error: { message: 'Proxy error: ' + err.message } });
  });
  proxyReq.setTimeout(90000, () => {
    proxyReq.destroy(new Error('Anthropic request timeout'));
    if (!res.headersSent) res.status(504).json({ error: { message: 'Claude API timed out after 90s. Try again.' } });
  });
  proxyReq.write(body);
  proxyReq.end();
});

// ── Start ─────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Daily Dispatch Quiz running on port ${PORT}`);
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('✓ Using Anthropic API');
    } else {
      console.log('⚠ WARNING: ANTHROPIC_API_KEY is not set.');
    }
  });
  // Fetch RSS after DB is ready
  setTimeout(fetchAndCacheRSS, 5000);
  scheduleNextRefresh();
  scheduleStreakNudge();
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});

// ── Email helper (Resend) ─────────────────────────────────────
// Single email send (used for unsubscribe confirmations etc.)
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.log('Email skipped: RESEND_API_KEY not set.'); return false; }
  const body = JSON.stringify({
    from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
    reply_to: 'dhconn@gmail.com',
    to: [to], subject, html
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 300) { console.log(`[Email] Sent to ${to} — status ${res.statusCode}`); resolve(true); }
        else { console.error(`[Email] FAILED to ${to} — status ${res.statusCode} — ${data}`); resolve(false); }
      });
    });
    req.on('error', (e) => { console.error(`[Email] Request error to ${to}:`, e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// Batch email send — sends up to 100 emails per request, chunked with delay between batches
async function sendEmailBatch(emails) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.log('Email skipped: RESEND_API_KEY not set.'); return; }
  const CHUNK_SIZE = 100;
  const CHUNK_DELAY = 1000; // 1 second between chunks
  const chunks = [];
  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    chunks.push(emails.slice(i, i + CHUNK_SIZE));
  }
  console.log(`[Email] Sending ${emails.length} emails in ${chunks.length} batch(es)`);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const body = JSON.stringify(chunk);
    await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.resend.com', path: '/emails/batch', method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          if (res.statusCode < 300) {
            console.log(`[Email] Batch ${c + 1}/${chunks.length} sent (${chunk.length} emails) — status ${res.statusCode}`);
          } else {
            console.error(`[Email] Batch ${c + 1}/${chunks.length} FAILED — status ${res.statusCode} — ${data}`);
          }
          resolve();
        });
      });
      req.on('error', (e) => { console.error(`[Email] Batch request error:`, e.message); resolve(); });
      req.write(body);
      req.end();
    });
    if (c < chunks.length - 1) await new Promise(r => setTimeout(r, CHUNK_DELAY));
  }
}

// ── POST /api/admin/message/bulk — send custom email to selected or all subscribers ──
app.post('/api/admin/message/bulk', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const { subject, body, recipients } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });

  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  const data = await readData();

  let targets;
  if (Array.isArray(recipients) && recipients.length) {
    targets = recipients;
  } else {
    targets = Object.values(data.subscribers || {})
      .filter(s => s.active)
      .map(s => ({ email: s.email, name: s.name || '' }));
  }

  if (!targets.length) return res.json({ ok: false, error: 'No recipients found' });

  const htmlBody = body.replace(/\n/g, '<br>');
  const emails = targets.map(t => {
    const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(t.email)}`;
    return {
      from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
      reply_to: 'dhconn@gmail.com',
      to: [t.email],
      subject,
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
        <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
          <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
          <div style="font-size:24px;font-weight:bold;">The Daily Dispatch Quiz</div>
        </div>
        <div style="padding:32px 24px;background:#f5f0e8;">
          ${t.name ? `<p style="font-size:16px;margin:0 0 16px;">Hi ${t.name},</p>` : ''}
          <div style="font-size:15px;line-height:1.7;">${htmlBody}</div>
        </div>
        <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
          <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
        </div>
      </div>`
    };
  });

  await sendEmailBatch(emails);
  console.log(`[Admin] Bulk message sent to ${emails.length} recipient(s): "${subject}"`);
  res.json({ ok: true, message: `Sent to ${emails.length} recipient${emails.length !== 1 ? 's' : ''}` });
});


// ── GET /subscribe — one-click subscribe from email link ─────
// Usage: /subscribe?email=jane@example.com&name=Jane
app.get('/subscribe', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  const name  = (req.query.name  || '').trim().slice(0, 40);
  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';

  if (!email || !email.includes('@')) return res.status(400).send('Invalid email address.');

  try {
    const data = await readData();
    if (!data.subscribers) data.subscribers = {};
    const wasAlready = data.subscribers[email]?.active === true;
    data.subscribers[email] = {
      name,
      email,
      subscribedAt: data.subscribers[email]?.subscribedAt || new Date().toISOString(),
      active: true
    };
    // Remove from prospects if present
    if (data.prospects) {
      const pk = email.toLowerCase().trim();
      if (data.prospects[pk]) data.prospects[pk].active = false;
    }
    await writeData(data);
    console.log(`[Subscribe] ${name} <${email}> subscribed via one-click link`);

    const headline = wasAlready ? `You're already subscribed${name ? ', ' + name : ''}!` : `You're subscribed${name ? ', ' + name : ''}!`;
    const subline  = wasAlready ? `You'll continue to receive The Daily Dispatch Quiz every morning.` : `You'll receive The Daily Dispatch Quiz in your inbox every morning, starting tomorrow.`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscribed — The Daily Dispatch Quiz</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Source+Serif+4:wght@300;400;600&family=Courier+Prime:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Source Serif 4',serif;background:#f5f0e8;color:#1a1008;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px}
    .card{background:white;border:1px solid #2c1f0e;max-width:480px;width:100%;text-align:center}
    .card-header{background:#1a1008;color:#f5f0e8;padding:24px}
    .eyebrow{font-family:'Courier Prime',monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px}
    .card-header h1{font-family:'Playfair Display',serif;font-size:26px;font-weight:900}
    .card-body{padding:36px 32px}
    .checkmark{font-size:52px;margin-bottom:16px}
    .card-body h2{font-family:'Playfair Display',serif;font-size:24px;font-weight:700;margin-bottom:12px}
    .card-body p{font-size:15px;color:#6b5f4e;line-height:1.7;margin-bottom:28px}
    .play-btn{display:inline-block;background:#1a1008;color:#f5f0e8;padding:14px 32px;font-family:'Courier Prime',monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none}
    .card-footer{padding:16px;border-top:1px solid #ede8da;font-family:'Courier Prime',monospace;font-size:11px;color:#aaa}
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="eyebrow">BALTIMORE &middot; DAILY DISPATCH</div>
      <h1>The Daily Dispatch Quiz</h1>
    </div>
    <div class="card-body">
      <div class="checkmark">&#10003;</div>
      <h2>${headline}</h2>
      <p>${subline}</p>
      <a href="${siteUrl}" class="play-btn">Play Today&#39;s Quiz &#9658;</a>
    </div>
    <div class="card-footer">dailydispatchquiz.com</div>
  </div>
</body>
</html>`);
  } catch(e) {
    console.error('[Subscribe] Error:', e.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// ── Prospects ─────────────────────────────────────────────────
// Stored as data.prospects = { email: { name, email, addedAt, active } }

app.get('/api/prospects', async (req, res) => {
  const data = await readData();
  const prospects = Object.values(data.prospects || {})
    .filter(p => p.active !== false)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  res.json({ prospects });
});

app.post('/api/prospects', async (req, res) => {
  const { prospects } = req.body;
  if (!Array.isArray(prospects)) return res.status(400).json({ error: 'prospects array required' });
  const data = await readData();
  if (!data.prospects) data.prospects = {};
  if (!data.subscribers) data.subscribers = {};
  let added = 0, existing = 0;
  for (const { name, email } of prospects) {
    if (!email || !email.includes('@')) continue;
    const key = email.toLowerCase().trim();
    // Skip if already an active subscriber
    if (data.subscribers[key]?.active) { existing++; continue; }
    if (data.prospects[key] && data.prospects[key].active !== false) { existing++; continue; }
    data.prospects[key] = {
      name: (name || '').trim().slice(0, 40),
      email: key,
      addedAt: new Date().toISOString(),
      active: true
    };
    added++;
  }
  await writeData(data);
  console.log(`[Prospects] Imported ${added} new, ${existing} existing`);
  res.json({ ok: true, added, existing });
});

app.delete('/api/prospects/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase().trim();
  const data = await readData();
  if (data.prospects && data.prospects[email]) {
    data.prospects[email].active = false;
    await writeData(data);
  }
  res.json({ ok: true });
});

app.delete('/api/prospects', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  data.prospects = {};
  await writeData(data);
  res.json({ ok: true });
});

// ── Streak calculation ────────────────────────────────────────
function calcStreak(dailyScores) {
  let streak = 0;
  const check = new Date();
  check.setDate(check.getDate() - 1);
  while (true) {
    const d = check.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (dailyScores[d] !== undefined) { streak++; check.setDate(check.getDate() - 1); }
    else break;
  }
  return streak;
}

// ── Streak nudge emails — 7pm Eastern daily ───────────────────
async function sendStreakNudges() {
  const today = easternToday();
  const data = await readData();
  if (!data.quizzes || !data.quizzes[today]) { console.log('[StreakNudge] No quiz today — skipping.'); return; }
  if (data.emailPaused) { console.log('[StreakNudge] Emails paused — skipping.'); return; }
  const subscribers = data.subscribers || {};
  const scores = data.scores || {};
  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  const nudgeTargets = [];
  for (const sub of Object.values(subscribers)) {
    if (!sub.active || !sub.email) continue;
    const playerKey = sub.playerKey || Object.keys(scores).find(k => sub.name && k === sub.name.toLowerCase().trim());
    if (!playerKey || !scores[playerKey]) continue;
    const { dailyScores, displayName } = scores[playerKey];
    if (dailyScores[today] !== undefined) continue;
    const streak = calcStreak(dailyScores);
    if (streak < 3) continue;
    nudgeTargets.push({ email: sub.email, name: sub.name || displayName, streak });
  }
  if (!nudgeTargets.length) { console.log('[StreakNudge] No eligible players.'); return; }
  console.log(`[StreakNudge] Sending nudges to ${nudgeTargets.length} player(s)...`);
  const emails = nudgeTargets.map(({ email, name, streak }) => {
    const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(email)}`;
    return {
      from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
      reply_to: 'dhconn@gmail.com',
      to: [email],
      subject: `Your ${streak}-day streak is on the line`,
      html: `
      <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
        <a href="${siteUrl}" style="display:block;text-decoration:none;color:inherit;">
          <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
            <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
            <div style="font-size:28px;font-weight:bold;">The Daily Dispatch Quiz</div>
          </div>
        </a>
        <div style="padding:32px 24px;background:#f5f0e8;text-align:center;">
          <div style="font-size:52px;margin-bottom:12px;">🔥</div>
          <p style="font-size:22px;font-weight:bold;margin:0 0 10px;font-family:Georgia,serif;">
            ${streak} days in a row${name ? ', ' + name : ''}.
          </p>
          <p style="font-size:15px;color:#6b5f4e;margin:0 0 28px;line-height:1.7;">
            You've answered Baltimore news questions ${streak} days straight.<br>
            Today's quiz is waiting — don't break the streak now.
          </p>
          <a href="${siteUrl}" style="display:inline-block;background:#1a1008;color:#f5f0e8;padding:16px 36px;font-family:monospace;font-size:13px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Play Today's Quiz ▸</a>
        </div>
        <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
          You're receiving this because you're on a streak. <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
        </div>
      </div>`
    };
  });
  await sendEmailBatch(emails);
  console.log(`[StreakNudge] Done — nudged ${emails.length} player(s).`);
}

function scheduleStreakNudge() {
  const now = new Date();
  const next = new Date();
  // Calculate next 7pm Eastern — accounts for EST/EDT automatically
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  next.setTime(now.getTime());
  // Find the UTC time that corresponds to 7pm Eastern today
  const easternOffset = (now.getTime() - eastern.getTime()); // ms offset
  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  target.setTime(target.getTime() + easternOffset + (19 * 60 * 60 * 1000)); // 19:00 Eastern
  if (target <= now) target.setDate(target.getDate() + 1);
  const msUntil = target - now;
  console.log(`[StreakNudge] Next nudge run in ${Math.round(msUntil / 60000)} minutes (7pm Eastern).`);
  setTimeout(() => {
    sendStreakNudges();
    scheduleStreakNudge();
  }, msUntil);
}

// ── Message board ─────────────────────────────────────────────
// Posts stored as data.posts = [{ id, playerName, text, createdAt, deleted }]

app.get('/api/posts', async (req, res) => {
  const data = await readData();
  const posts = (data.posts || []).filter(p => !p.deleted);
  res.json({ posts });
});

app.post('/api/posts', async (req, res) => {
  const { playerName, text } = req.body;
  if (!playerName || !playerName.trim()) return res.status(400).json({ error: 'Player name required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long (500 char max).' });

  const data = await readData();
  if (!data.posts) data.posts = [];
  const post = {
    id: Date.now().toString(),
    playerName: playerName.trim().slice(0, 40),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };
  data.posts.unshift(post); // newest first
  if (data.posts.length > 200) data.posts = data.posts.slice(0, 200); // cap at 200
  await writeData(data);
  res.json({ ok: true, post });
});

app.delete('/api/posts/:id', async (req, res) => {
  const data = await readData();
  const post = (data.posts || []).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  post.deleted = true;
  await writeData(data);
  res.json({ ok: true });
});

// ── Contact the Editor ────────────────────────────────────────
// Messages stored as data.messages = [{ id, playerName, text, createdAt, read }]

app.post('/api/contact', async (req, res) => {
  const { playerName, text } = req.body;
  if (!playerName || !playerName.trim()) return res.status(400).json({ error: 'Player name required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message required.' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message too long (1000 char max).' });

  const data = await readData();
  if (!data.messages) data.messages = [];
  const msg = {
    id: Date.now().toString(),
    playerName: playerName.trim().slice(0, 40),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    read: false
  };
  data.messages.unshift(msg);
  await writeData(data);

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

app.get('/api/messages', async (req, res) => {
  const data = await readData();
  res.json({ messages: data.messages || [] });
});

app.post('/api/messages/:id/read', async (req, res) => {
  const data = await readData();
  const msg = (data.messages || []).find(m => m.id === req.params.id);
  if (msg) { msg.read = true; await writeData(data); }
  res.json({ ok: true });
});
