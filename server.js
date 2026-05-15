require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const { Pool } = require('pg')
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:dhconn@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[Push] VAPID keys not set — push notifications disabled.');
}

app.use(express.json({ limit: '2mb' }));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
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
                 'archiveQuestions','archiveSlugs','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate','emailSentDates','prospects','prospectsPaused','statsExclusions','editorNotes','starredQuestions'];
  const data = {};
  await Promise.all(keys.map(async k => {
    const v = await getKey(k);
    if (v !== null) data[k] = v;
  }));
  return data;
}

async function writeData(data) {
  const keys = ['sites','rssCache','scores','dist','quizzes','archiveUrls',
                 'archiveQuestions','archiveSlugs','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate','emailSentDates','prospects','prospectsPaused','statsExclusions','editorNotes','starredQuestions'];
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
  const quiz = data.quizzes && data.quizzes[date];
  if (!quiz) return res.status(404).json({ error: 'Quiz not found for this date' });

  if (!data.dist) data.dist = {};
  if (!data.dist[date]) data.dist[date] = {};

// Server-side validation loop
answers.forEach(({ qIdx, chosenIndex, correct }) => {
  if (qIdx === 'completion') return;

  const question = quiz.questions[qIdx];
  if (!question) return;

  let isActuallyCorrect;

  // New client payload: { qIdx, correct }
  if (typeof correct === 'boolean') {
    isActuallyCorrect = correct;
  }
  // Legacy payload: { qIdx, chosenIndex }
  else if (typeof chosenIndex === 'number') {
    isActuallyCorrect = (chosenIndex === question.correctIndex);
  }
  // Unknown payload shape: skip
  else {
    return;
  }

  const k = 'q' + qIdx;
  if (!data.dist[date][k]) data.dist[date][k] = { correct: 0, wrong: 0 };

  if (isActuallyCorrect) data.dist[date][k].correct++;
  else data.dist[date][k].wrong++;

  if (playerName && playerName.trim()) {
    const key = playerName.trim().toLowerCase();
    if (!data.dist[date].players) data.dist[date].players = {};
    if (!data.dist[date].players[key]) {
      data.dist[date].players[key] = { displayName: playerName.trim(), answers: {} };
    }
    data.dist[date].players[key].answers[k] = isActuallyCorrect;
  }
});

  // Keep existing cleanup logic for old distribution data
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
  const distForDate = (data.dist && data.dist[date]) || {};
  const excludedMap = (data.statsExclusions && data.statsExclusions[date]) || {};
  const players = distForDate.players || {};

  // If there are no per-player answers stored, fall back to the raw distribution
  if (!Object.keys(players).length) {
    return res.json(distForDate);
  }

  const rebuilt = {};

  for (const [playerKey, playerData] of Object.entries(players)) {
    if (excludedMap[playerKey]) continue;

    const answers = (playerData && playerData.answers) || {};
    for (const [qKey, wasCorrect] of Object.entries(answers)) {
      if (!rebuilt[qKey]) rebuilt[qKey] = { correct: 0, wrong: 0 };
      if (wasCorrect) rebuilt[qKey].correct++;
      else rebuilt[qKey].wrong++;
    }
  }

  // Keep filtered players in the payload too, since admin screens may still inspect them
  rebuilt.players = Object.fromEntries(
    Object.entries(players).filter(([playerKey]) => !excludedMap[playerKey])
  );

  res.json(rebuilt);
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

app.get('/api/progress', async (req, res) => {
  const { date, playerName } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  try {
    // This looks into your Postgres 'store' table for the 'progress' key
    const allProgress = await getKey('progress') || {}; 
    const dayData = allProgress[date] || {};

    // If you're looking for one person: ?date=...&playerName=...
    if (playerName) {
      const key = playerName.toLowerCase().trim();
      return res.json(dayData[key] || { score: 0, completed: false });
    }

    // If you're looking at the whole leaderboard: ?date=...
    res.json(dayData);
  } catch (e) {
    console.error('Error in GET /api/progress:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/progress', async (req, res) => {
  const { playerName, date, progress } = req.body || {};

  if (!playerName || !date || !progress || typeof progress !== 'object') {
    return res.status(400).json({ error: 'playerName, date, and progress required' });
  }

  try {
    const data = await readData();

    console.log('[progress] incoming', {
      playerName,
      date,
      hasProgress: !!progress,
      hasQuiz: !!(data.quizzes && data.quizzes[date])
    });

    const quiz = data.quizzes && data.quizzes[date];
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

  // Recalculate score server-side from stored per-answer points,
  // which already include full credit or partial credit as awarded.
  let validatedScore = 0;

  if (progress.answers && typeof progress.answers === 'object') {
    Object.values(progress.answers).forEach(answer => {
      validatedScore += Number(answer?.pts) || 0;
    });
  }

  // Add the 10-point completion bonus only when completed
  if (progress.completed) {
    validatedScore += 10;
  }
    const allProgress = (await getKey('progress')) || {};
    if (!allProgress[date]) allProgress[date] = {};

    const key = playerName.toLowerCase().trim();
    const existing = allProgress[date][key] || {};

    allProgress[date][key] = {
      ...existing,
      ...progress,
      displayName: playerName.trim(),
      updatedAt: new Date().toISOString(),
      score: validatedScore,
      synthetic: false
    };

    // Keep only last 2 days of progress
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 5);
    Object.keys(allProgress).forEach(d => {
      if (new Date(d + 'T12:00:00') < cutoffDate) delete allProgress[d];
    });

    console.log('[progress] saving', {
      key,
      date,
      validatedScore,
      completed: progress.completed,
      currentQ: progress.currentQ,
      answerCount: Object.keys(progress.answers || {}).length
    });

    // Prune detailed answer data from records older than 2 days
    const pruneDate = new Date();
    pruneDate.setDate(pruneDate.getDate() - 2);
    Object.entries(allProgress).forEach(([d, players]) => {
      if (new Date(d + 'T12:00:00') < pruneDate) {
        Object.keys(players).forEach(pk => {
          const p = players[pk];
          players[pk] = {
            score: p.score,
            completed: p.completed,
            displayName: p.displayName,
            synthetic: p.synthetic || false
          };
        });
      }
    });

    await setKey('progress', allProgress);

    // ── Mirror to scores for leaderboard ───────────────────
    try {
      const scoresData = await readData();
      if (!scoresData.scores) scoresData.scores = {};

      if (!scoresData.scores[key]) {
        scoresData.scores[key] = {
          displayName: playerName.trim(),
          allTime: 0,
          dailyScores: {}
        };
      }
      const prev = scoresData.scores[key].dailyScores[date] || 0;

      if (progress.completed || validatedScore >= prev) {
        scoresData.scores[key].dailyScores[date] = validatedScore;
        scoresData.scores[key].allTime = Object.values(
          scoresData.scores[key].dailyScores
        ).reduce((a, b) => a + b, 0);
        scoresData.scores[key].displayName = playerName.trim();
        await writeData(scoresData);
      }
    } catch (e) {
      console.warn('[progress] scores mirror failed (non-fatal):', e.message);
    }

    res.json({ ok: true, validatedScore });
  } catch (e) {
    console.error('[progress] POST error:', e.message);
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

  const { completed: isCompleted } = req.body;

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

    // Always overwrite with latest score
    const prev = data.scores[key].dailyScores[date] || 0;
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

   // Log completion event for A/B analytics — only on final score post from finishQuiz
    if (isCompleted) {
      const subData = await readData();
      const subRecord = subData.subscribers && Object.values(subData.subscribers).find(s =>
        (s.name || '').toLowerCase().trim() === key
      );
      if (subRecord && subRecord.abGroup) {
        logEmailEvent('quiz_completed', subRecord.email, date, { group: subRecord.abGroup, score });
      }
    }

    // ── Mirror to progress for single source of truth ──────
    try {
      const allProgress = (await getKey('progress')) || {};
      if (!allProgress[date]) allProgress[date] = {};
      if (!allProgress[date][key]) {
        allProgress[date][key] = {
          score,
          completed: false,
          answers: {},
          currentQ: 0,
          displayName: playerName.trim(),
          synthetic: true,
          updatedAt: new Date().toISOString()
        };
        await setKey('progress', allProgress);
      }
    } catch (e) {
      console.warn('[scores] progress mirror failed (non-fatal):', e.message);
    }

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
  try {
    const data = await readData();
    const scores = data.scores || {};
    const today = easternToday();
    const excludedMap = (data.statsExclusions && data.statsExclusions[today]) || {};

    const filteredScores = Object.fromEntries(
      Object.entries(scores).filter(([playerKey]) => !excludedMap[playerKey])
    );

    res.json({ scores: filteredScores });
  } catch (e) {
    console.error('[scores] GET error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/migrate-progress — one-time migration ─────
app.get('/api/admin/migrate-progress', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const data = await readData();
    const scores = data.scores || {};
    const allProgress = (await getKey('progress')) || {};
    let created = 0;

    for (const [playerKey, player] of Object.entries(scores)) {
      for (const [date, score] of Object.entries(player.dailyScores || {})) {
        if (!allProgress[date]) allProgress[date] = {};
        if (!allProgress[date][playerKey]) {
          allProgress[date][playerKey] = {
            score,
            completed: true,
            answers: {},
            currentQ: 5,
            displayName: player.displayName || playerKey,
            synthetic: true,
            updatedAt: new Date().toISOString()
          };
          created++;
        }
      }
    }

    await setKey('progress', allProgress);
    console.log(`[Migration] Created ${created} synthetic progress records`);
    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin stats exclusions ────────────────────────────────────

app.get('/api/admin/stats-exclusions', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  try {
    const data = await readData();
    const all = data.statsExclusions || {};
    res.json({ date, excluded: all[date] || {} });
  } catch (e) {
    console.error('[stats-exclusions] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/stats-exclusions', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { date, playerKey, excluded } = req.body || {};
  if (!date || !playerKey || typeof excluded !== 'boolean') {
    return res.status(400).json({ error: 'date, playerKey, and excluded required' });
  }

  try {
    const key = playerKey.toLowerCase().trim();
    const data = await readData();

    if (!data.statsExclusions) data.statsExclusions = {};
    if (!data.statsExclusions[date]) data.statsExclusions[date] = {};

    if (excluded) data.statsExclusions[date][key] = true;
    else delete data.statsExclusions[date][key];

    if (Object.keys(data.statsExclusions[date]).length === 0) {
      delete data.statsExclusions[date];
    }

    await writeData(data);
    res.json({ ok: true, date, playerKey: key, excluded });
  } catch (e) {
    console.error('[stats-exclusions] POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Archive (used article URLs + question text) ───────────────

// ── GET /api/archive/full — derive rich archive from published quizzes ──
// Returns full question texts, source URLs, explanations and topic slugs from last 14 days
app.get('/api/archive/full', async (req, res) => {
  try {
    const data = await readData();
    const quizzes = data.quizzes || {};
    const dates = Object.keys(quizzes).sort();

    const questions = [];
    const urls = [];
    const slugs = [];
    const summaries = []; // question + explanation combined for richer dedup

    for (const date of dates) {
      const quiz = quizzes[date];
      if (!quiz || !quiz.questions) continue;
      for (const q of quiz.questions) {
        if (q.question && !questions.includes(q.question)) questions.push(q.question);
        if (q.sourceUrl && !urls.includes(q.sourceUrl)) urls.push(q.sourceUrl);
        // Combined summary includes key entities from the explanation
        if (q.question && q.explanation) {
          const summary = q.question + ' — ' + q.explanation.slice(0, 120);
          summaries.push(summary);
        }
      }
    }

    // Also include manually stored archive items
    (data.archiveQuestions || []).forEach(q => { if (!questions.includes(q)) questions.push(q); });
    (data.archiveUrls || []).forEach(u => { if (!urls.includes(u)) urls.push(u); });
    (data.archiveSlugs || []).forEach(s => { if (!slugs.includes(s)) slugs.push(s); });

    res.json({ questions, urls, slugs, summaries, count: questions.length });
  } catch (e) {
    console.error('[Archive/full] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

function buildEmailHtmlWithQ1(siteUrl, date, subscriberName, teaserHtml, unsubUrl, q1, token) {
  const optLetters = ['A', 'B', 'C', 'D'];
  const answerButtons = (q1.options || []).map((opt, i) => {
  const url = `${siteUrl}/news-quiz.html?q1=${encodeURIComponent(String(i))}&tok=${encodeURIComponent(token)}`;
  return `
    <div style="margin-bottom:10px;">
      <a href="${url}" target="_blank" style="display:block;padding:14px 16px;background:#ffffff;border:2px solid #2c1f0e;text-decoration:none;color:#1a1008;font-family:Georgia,serif;font-size:15px;text-align:left;">
        <strong style="font-family:Courier New,monospace;font-size:13px;color:#6b5f4e;margin-right:10px;">${optLetters[i]}.</strong>
        ${opt}
      </a>
    </div>`;
}).join('');

return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
    <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
      <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
      <div style="font-size:28px;font-weight:bold;">The Daily Dispatch Quiz</div>
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#aaa;margin-top:6px;">${date}</div>
    </div>
    <div style="padding:32px 24px;background:#f5f0e8;">
      <p style="font-size:18px;margin:0 0 24px;">Hi${subscriberName ? ' ' + subscriberName : ''} — start today's quiz by clicking your answer here:</p>
      <div style="background:white;border:2px solid #1a1008;padding:20px 20px 10px;margin-bottom:20px;box-shadow:4px 4px 0 #1a1008;">
        <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#6b5f4e;margin-bottom:12px;">QUESTION 1 OF 5 · STARTER</div>
        <div style="font-size:19px;line-height:1.5;color:#1a1008;font-weight:400;margin-bottom:16px;">${q1.question}</div>
        ${answerButtons}
      </div>
      <p style="text-align:center;margin:12px 0 20px;font-family:monospace;font-size:11px;letter-spacing:1px;color:#6b5f4e;">
        — or — <a href="${siteUrl}" style="color:#1a1008;font-weight:700;">go straight to today's quiz →</a>
      </p>
<!--YESTERDAY_INSERT_POINT-->
<!--SUBSCRIBE_INSERT_POINT-->
    </div>
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>
  </div>`;
}

function buildEmailHtml(siteUrl, date, subscriberName, teaserHtml, unsubUrl, trackingToken) {
  return `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
    <a href="${siteUrl}/news-quiz.html${trackingToken ? '?tok=' + encodeURIComponent(trackingToken) + '&group=A' : ''}" style="display:block;text-decoration:none;color:inherit;">
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
      <a href="${siteUrl}/news-quiz.html${trackingToken ? '?tok=' + encodeURIComponent(trackingToken) + '&group=A' : ''}" style="display:inline-block;background:#1a1008;color:#f5f0e8;padding:16px 36px;font-family:monospace;font-size:13px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Play Today's Quiz ▸</a>

<!--SUBSCRIBE_INSERT_POINT-->
    </div>
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>
  </div>`;
}

function buildResultsHtml(playerProgress, yesterdayQuiz) {
  if (!playerProgress || !playerProgress.completed) return '';
  const questions = (yesterdayQuiz && yesterdayQuiz.questions) || [];
  const answers = playerProgress.answers || {};
  const score = playerProgress.score || 0;

  const rows = Object.entries(answers)
    .filter(([k]) => /^q\d+$/.test(k))
    .sort(([a],[b]) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
    .map(([k, a]) => {
      const idx = parseInt(k.slice(1));
      const q = questions[idx];
      if (!q) return '';
      const isBonus = q.difficulty === 'bonus';
      const label = isBonus ? 'Bonus' : `Q${idx + 1}`;
      const icon = a.correct ? '✓' : '✗';
      const color = a.correct ? '#1a6b3c' : '#c0392b';
      const correctAnswer = q.options && q.options[q.correctIndex] ? q.options[q.correctIndex] : '';
      return `
        <tr>
          <td style="padding:6px 8px;font-family:monospace;font-size:12px;color:#6b5f4e;">${label}</td>
          <td style="padding:6px 8px;font-family:monospace;font-size:14px;color:${color};font-weight:700;">${icon}</td>
          <td style="padding:6px 8px;font-size:13px;color:#1a1008;">+${a.pts} pts</td>
          <td style="padding:6px 8px;font-size:12px;color:#6b5f4e;font-style:italic;">${correctAnswer}</td>
        </tr>`;
    }).join('');

  if (!rows) return '';

  return `
    <div style="margin:0 0 28px;padding:20px;background:#fff;border:1px solid #e0d8cc;text-align:left;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#999;margin-bottom:4px;">YESTERDAY'S RESULTS</div>
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#b8860b;margin-bottom:14px;">${score} pts</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        ${rows}
      </table>
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

// ── GET /api/editor-notes — fetch editor notes ───────────────
app.get('/api/editor-notes', async (req, res) => {
  const data = await readData();
  res.json({ notes: data.editorNotes || '' });
});
// ── POST /api/editor-notes — save editor notes ────────────────
app.post('/api/editor-notes', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  data.editorNotes = typeof req.body.notes === 'string' ? req.body.notes : '';
  await writeData(data);
  console.log('[Admin] Editor notes updated (' + data.editorNotes.length + ' chars)');
  res.json({ ok: true, notes: data.editorNotes });
});
// ── GET /api/starred-questions — fetch starred example questions ──
app.get('/api/starred-questions', async (req, res) => {
  const data = await readData();
  res.json({ questions: data.starredQuestions || [] });
});
// ── POST /api/starred-questions — save a starred question ────────
app.post('/api/starred-questions', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  if (!Array.isArray(data.starredQuestions)) data.starredQuestions = [];
  const { question, correctAnswer, sourceUrl, action } = req.body;
  if (action === 'remove') {
    data.starredQuestions = data.starredQuestions.filter(q => q.question !== question);
    console.log('[Admin] Starred question removed');
  } else if (action === 'update') {
    const existing = data.starredQuestions.find(q => q.question === question);
    if (existing) {
      existing.note = typeof req.body.note === 'string' ? req.body.note : '';
      console.log('[Admin] Starred question note updated');
    }
  } else {
    // Avoid duplicates
    if (!data.starredQuestions.find(q => q.question === question)) {
      data.starredQuestions.push({ question, correctAnswer: correctAnswer || '', sourceUrl: sourceUrl || '', note: '' });
      console.log('[Admin] Starred question added. Total: ' + data.starredQuestions.length);
    }
  }
  await writeData(data);
  res.json({ ok: true, questions: data.starredQuestions });
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

// Fetch yesterday's progress and quiz for results recap
      const yd = new Date(date + 'T12:00:00');
      yd.setDate(yd.getDate() - 1);
      const yesterday = yd.toISOString().slice(0, 10);
      const yesterdayProgress = (await getKey('progress') || {})[yesterday] || {};
      const yesterdayQuiz = (freshData.quizzes || {})[yesterday] || null;

// Load and purge email tokens
      const tokens = (await getKey('emailTokens')) || {};
      const tokenCutoff = new Date();
      tokenCutoff.setDate(tokenCutoff.getDate() - 2);
      Object.keys(tokens).forEach(t => {
        if (new Date(tokens[t].date + 'T12:00:00') < tokenCutoff) delete tokens[t];
      });

      const q1 = quiz.questions && quiz.questions[0];

      // Assign A/B groups and build emails
      const updatedSubscribers = [];
      const emails = [];
      for (const sub of subscribers) {
        // Assign A/B group if not yet assigned
        if (!sub.abGroup) sub.abGroup = Math.random() < 0.5 ? 'A' : 'B';
        updatedSubscribers.push(sub);

        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(sub.email)}`;
        const playerKey = (sub.name || '').toLowerCase().trim();
        const playerProgress = yesterdayProgress[playerKey] || null;
        const resultsHtml = buildResultsHtml(playerProgress, yesterdayQuiz);

        let baseHtml;
        if (sub.abGroup === 'B' && q1) {
          // Group B: teaser email with Q1 embedded
          const token = Buffer.from(sub.email + date + Math.random()).toString('base64')
            .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          tokens[token] = {
            email: sub.email,
            playerKey,
            displayName: sub.name || '',
            date,
            group: 'B',
            usedAt: null
          };
          baseHtml = buildEmailHtmlWithQ1(siteUrl, date, sub.name, teaserHtml, unsubUrl, q1, token);
          await logEmailEvent('email_sent', sub.email, date, { group: 'B' });
        } else {
          // Group A: standard email with click tracking token
          const tokenA = Buffer.from(sub.email + date + Math.random()).toString('base64')
            .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          tokens[tokenA] = {
            email: sub.email,
            playerKey,
            displayName: sub.name || '',
            date,
            group: 'A',
            usedAt: null
          };
          baseHtml = buildEmailHtml(siteUrl, date, sub.name, teaserHtml, unsubUrl, tokenA);
          await logEmailEvent('email_sent', sub.email, date, { group: 'A' });
        }

        const html = resultsHtml
          ? baseHtml.replace('<!--YESTERDAY_INSERT_POINT-->', resultsHtml)
          : baseHtml.replace('<!--YESTERDAY_INSERT_POINT-->', '');

        emails.push({
          from: process.env.FROM_EMAIL || 'David @ Daily Dispatch Quiz <david@dailydispatchquiz.com>',
          reply_to: 'dhconn@gmail.com',
          to: [sub.email],
          subject,
          html
        });
      }

      // Save updated tokens and subscriber abGroup assignments
      await setKey('emailTokens', tokens);
      const subData = await readData();
      if (subData.subscribers) {
        updatedSubscribers.forEach(sub => {
          if (subData.subscribers[sub.email]) {
            subData.subscribers[sub.email].abGroup = sub.abGroup;
          }
        });
        await writeData(subData);
      }

      await sendEmailBatch(emails);
      sentAnyEmails = true;
    }

    // Send to prospects — same email + one-click subscribe button
    const activeProspects = (freshData.emailPaused || freshData.prospectsPaused)
      ? []
      : Object.values(freshData.prospects || {}).filter(p => p.active !== false);

    if (activeProspects.length > 0) {
      console.log(`[Prospects] Sending quiz email to ${activeProspects.length} prospect(s)…`);

      const tokens = (await getKey('emailTokens')) || {};
      const q1 = quiz.questions && quiz.questions[0];
      const updatedProspects = [];

const prospectEmails = [];
      for (const p of activeProspects) {
        const subscribeUrl = `${siteUrl}/subscribe?email=${encodeURIComponent(p.email)}&name=${encodeURIComponent(p.name || '')}`;
        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(p.email)}`;
        const playerKey = (p.name || '').toLowerCase().trim();

        // Assign A/B group if not yet assigned
        if (!p.abGroup) p.abGroup = Math.random() < 0.5 ? 'A' : 'B';
        updatedProspects.push(p);

        let baseHtml;
        if (p.abGroup === 'B' && q1) {
          const token = Buffer.from(p.email + date + Math.random()).toString('base64')
            .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          tokens[token] = {
            email: p.email,
            playerKey,
            displayName: p.name || '',
            date,
            group: 'B',
            usedAt: null
          };
          baseHtml = buildEmailHtmlWithQ1(siteUrl, date, p.name, teaserHtml, unsubUrl, q1, token);
          await logEmailEvent('email_sent', p.email, date, { group: 'B' });
        } else {
          const tokenA = Buffer.from(p.email + date + Math.random()).toString('base64')
            .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
          tokens[tokenA] = {
            email: p.email,
            playerKey,
            displayName: p.name || '',
            date,
            group: 'A',
            usedAt: null
          };
          baseHtml = buildEmailHtml(siteUrl, date, p.name, teaserHtml, unsubUrl, tokenA);
          await logEmailEvent('email_sent', p.email, date, { group: 'A' });
        }

        const subscribeBtn = `
          <div style="padding:20px 24px;text-align:center;background:#f5f0e8;border-top:1px solid #e0d8cc;">
            <p style="font-family:monospace;font-size:11px;letter-spacing:1px;color:#6b5f4e;margin-bottom:12px;">GET THIS AUTOMATICALLY EVERY MORNING</p>
            <a href="${subscribeUrl}" style="display:inline-block;background:#c0392b;color:white;padding:12px 28px;font-family:monospace;font-size:12px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Subscribe Free &#9658;</a>
          </div>`;

        const html = baseHtml.replace('<!--SUBSCRIBE_INSERT_POINT-->', subscribeBtn);

        prospectEmails.push({
          from: process.env.FROM_EMAIL || 'David @ Daily Dispatch Quiz <david@dailydispatchquiz.com>',
          reply_to: 'dhconn@gmail.com',
          to: [p.email],
          subject,
          html
        });
      }

    // Save final token state including prospect tokens
    await setKey('emailTokens', tokens);

    // Save prospect abGroup assignments
    const prospectData = await readData();

    if (prospectData.prospects) {
       updatedProspects.forEach(p => {
        const key = (p.email || '').toLowerCase().trim();

        if (prospectData.prospects[key]) {
          prospectData.prospects[key].abGroup = p.abGroup;
       }
     });

     await writeData(prospectData);
  }

  await sendEmailBatch(prospectEmails);
  sentAnyEmails = true;
    }
    await sendPushNotifications(date);
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


// ── POST /api/pwa-session — log that a player launched via installed PWA ──
app.post('/api/pwa-session', async (req, res) => {
  const { playerName, date } = req.body || {};
  if (!playerName || !date) return res.status(400).json({ error: 'playerName and date required' });
  try {
    const key = playerName.toLowerCase().trim();
    const allProgress = (await getKey('progress')) || {};
    if (!allProgress[date]) allProgress[date] = {};
    if (!allProgress[date][key]) allProgress[date][key] = {};
    allProgress[date][key].pwaSession = true;
    allProgress[date][key].displayName = playerName.trim();
    await setKey('progress', allProgress);
    console.log(`[PWA] Session logged: ${playerName} on ${date}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[PWA] session log error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Email quiz tokens ─────────────────────────────────────────
// Stored as emailTokens = { token: { email, playerKey, date, usedAt } }

app.post('/api/email-token/validate', async (req, res) => {
  const { token, date } = req.body || {};
  if (!token || !date) return res.status(400).json({ error: 'token and date required' });
  try {
    const tokens = (await getKey('emailTokens')) || {};
    const record = tokens[token];
    if (!record) return res.json({ valid: false, reason: 'invalid' });
    if (record.date !== date) return res.json({ valid: false, reason: 'wrong_date' });
    if (record.usedAt) return res.json({ valid: true, email: record.email, playerKey: record.playerKey, displayName: record.displayName, alreadyUsed: true });
    res.json({ valid: true, email: record.email, playerKey: record.playerKey, displayName: record.displayName, alreadyUsed: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/email-token/use', async (req, res) => {
  const { token, date } = req.body || {};
  if (!token || !date) return res.status(400).json({ error: 'token and date required' });
  try {
    const tokens = (await getKey('emailTokens')) || {};
    if (!tokens[token]) return res.status(404).json({ error: 'token not found' });
    const record = tokens[token];
    const alreadyUsed = !!record.usedAt;
    tokens[token].usedAt = new Date().toISOString();
    await setKey('emailTokens', tokens);
    // Log q1_click only on first use
    if (!alreadyUsed && record.group) {
      await logEmailEvent('q1_click', record.email, date, { group: record.group });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Email event logging ───────────────────────────────────────
async function logEmailEvent(event, email, date, meta = {}) {
  try {
    const key = 'emailEvents_' + date;
    const events = (await getKey(key)) || [];
    events.push({ event, email, date, ts: new Date().toISOString(), ...meta });
    await setKey(key, events);
  } catch (e) {
    console.warn('[EmailEvent] log failed:', e.message);
  }
}

// ── GET /api/email-ab-stats — A/B results for admin panel ────
app.get('/api/email-ab-stats', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const key = 'emailEvents_' + date;
    const events = (await getKey(key)) || [];
    const groups = { A: { sent: 0, started: 0, completed: 0 }, B: { sent: 0, started: 0, completed: 0 } };
    events.forEach(e => {
      const g = e.group;
      if (!g || !groups[g]) return;
      if (e.event === 'email_sent') groups[g].sent++;
      if (e.event === 'q1_click') groups[g].started++;
      if (e.event === 'quiz_completed') groups[g].completed++;
    });
    res.json({ date, groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/quiz/test-email — send test B email to admin ───
app.post('/api/quiz/test-email', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });

  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  const testEmail = process.env.ADMIN_TEST_EMAIL || 'dhconn@gmail.com';
  const date = easternToday();

  try {
    const data = await readData();
    const quiz = data.quizzes && data.quizzes[date];
    if (!quiz) return res.status(404).json({ error: 'No quiz published for today' });

    const q1 = quiz.questions && quiz.questions[0];
    if (!q1) return res.status(404).json({ error: 'No questions in today\'s quiz' });

    // Generate a test token
    const tokens = (await getKey('emailTokens')) || {};
    const token = Buffer.from(testEmail + date + Math.random()).toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
    tokens[token] = {
      email: testEmail,
      playerKey: 'player',
      displayName: 'Player',
      date,
      group: 'B',
      usedAt: null
    };
    await setKey('emailTokens', tokens);

    const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(testEmail)}`;
    const teaserHtml = data.cachedTeaserHtml || '';
    const html = buildEmailHtmlWithQ1(siteUrl, date, 'Player', teaserHtml, unsubUrl, q1, token);

    await sendEmail(testEmail, `[TEST] Today's Daily Dispatch Quiz — ${date}`, html);
    console.log(`[TestEmail] Sent B email to ${testEmail}`);
    res.json({ ok: true, sentTo: testEmail });
  } catch (e) {
    console.error('[TestEmail] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/push-vapid-key — send public key to frontend ────
app.get('/api/push-vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── POST /api/push-subscribe — store a push subscription ─────
app.post('/api/push-subscribe', async (req, res) => {
  const { playerName, subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription required' });
  }
  try {
    const subs = (await getKey('pushSubscriptions')) || {};
    const key = Buffer.from(subscription.endpoint).toString('base64').slice(-40);
    subs[key] = {
      subscription,
      playerName: (playerName || '').trim(),
      addedAt: new Date().toISOString()
    };
    await setKey('pushSubscriptions', subs);
    console.log(`[Push] Subscription stored for "${playerName || 'unknown'}" — total: ${Object.keys(subs).length}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] subscribe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/push-unsubscribe — remove a push subscription ──
app.post('/api/push-unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const subs = (await getKey('pushSubscriptions')) || {};
    const key = Buffer.from(endpoint).toString('base64').slice(-40);
    delete subs[key];
    await setKey('pushSubscriptions', subs);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/push-stats — admin: how many push subscribers ───
app.get('/api/push-stats', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const subs = (await getKey('pushSubscriptions')) || {};
  res.json({ count: Object.keys(subs).length });
});

// ── Send Web Push notifications to all subscribed devices ────
async function sendPushNotifications(date) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log('[Push] VAPID keys not set — skipping push notifications.');
    return;
  }

  const subs = (await getKey('pushSubscriptions')) || {};
  const entries = Object.entries(subs);
  if (!entries.length) {
    console.log('[Push] No push subscribers — skipping.');
    return;
  }

  const payload = JSON.stringify({
    title: 'Daily Dispatch Quiz',
    body: "Today's quiz is live — can you beat yesterday's score?",
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png',
    url: '/'
  });

  console.log(`[Push] Sending to ${entries.length} subscriber(s)…`);
  let sent = 0, failed = 0, expired = 0;
  const toRemove = [];

  await Promise.allSettled(
    entries.map(async ([key, record]) => {
      try {
        await webpush.sendNotification(record.subscription, payload);
        sent++;
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          toRemove.push(key);
          expired++;
          console.log(`[Push] Expired subscription removed: ${record.playerName || key}`);
        } else {
          failed++;
          console.warn(`[Push] Failed for "${record.playerName}": ${e.message}`);
        }
      }
    })
  );

  if (toRemove.length) {
    const freshSubs = (await getKey('pushSubscriptions')) || {};
    toRemove.forEach(k => delete freshSubs[k]);
    await setKey('pushSubscriptions', freshSubs);
  }

  console.log(`[Push] Done — sent: ${sent}, failed: ${failed}, expired/removed: ${expired}`);
}

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
    from: process.env.FROM_EMAIL || 'David @ Daily Dispatch Quiz <david@dailydispatchquiz.com>',
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
  const { subject, body, recipients, audience } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });

  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  const data = await readData();

  let targets;
  if (Array.isArray(recipients) && recipients.length) {
    targets = recipients
      .map(r => ({
        email: String(r?.email || '').trim(),
        name: String(r?.name || '').trim()
      }))
      .filter(r => r.email);

  } else if (audience === 'prospects') {
    const prospects = Object.values(data.prospects || {});
    const subscribers = data.subscribers || {};

    targets = prospects
      .filter(p =>
        p &&
        p.email &&
        p.active !== false &&
        !subscribers[String(p.email).toLowerCase().trim()]?.active
      )
      .map(p => ({
        email: String(p.email || '').trim(),
        name: String(p.name || '').trim()
      }));

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
      from: process.env.FROM_EMAIL || 'David @ Daily Dispatch Quiz <david@dailydispatchquiz.com>',
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
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const data = await readData();
  const prospects = Object.values(data.prospects || {})
    .filter(p => p.active !== false)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

  res.json({ prospects });
});

app.post('/api/prospects', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { prospects } = req.body;
  if (!Array.isArray(prospects)) {
    return res.status(400).json({ error: 'prospects array required' });
  }

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

app.get('/api/prospect-pause', async (req, res) => {
  const data = await readData();
  res.json({ paused: !!data.prospectsPaused });
});

app.post('/api/prospect-pause', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { paused } = req.body;
  const data = await readData();
  data.prospectsPaused = !!paused;
  await writeData(data);
  res.json({ ok: true, paused: data.prospectsPaused });
});

app.delete('/api/prospects/:email', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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
  if (req.headers['x-admin-token'] !== adminToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

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
      from: process.env.FROM_EMAIL || 'David @ Daily Dispatch Quiz <david@dailydispatchquiz.com>',
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
  const { playerName, text, isEditorReply, replyTo } = req.body;
  if (!playerName || !playerName.trim()) return res.status(400).json({ error: 'Player name required.' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long (500 char max).' });
  const data = await readData();
  if (!data.posts) data.posts = [];
  const post = {
    id: Date.now().toString(),
    playerName: playerName.trim().slice(0, 40),
    text: text.trim(),
    createdAt: new Date().toISOString(),
    ...(isEditorReply && { isEditorReply: true }),
    ...(replyTo && { replyTo })
  };
  data.posts.unshift(post); // newest first
  if (data.posts.length > 200) data.posts = data.posts.slice(0, 200); // cap at 200
  await writeData(data);
  // ── Notify admin of new community post ──
  try {
    const adminEmail = process.env.EDITOR_EMAIL || 'your@email.com';

    const subject = isEditorReply
      ? `Editor reply posted`
      : `New community post from ${post.playerName}`;

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;">
        <p><strong>${isEditorReply ? 'Editor reply' : 'New post submitted'}</strong></p>
        <p><strong>Player:</strong> ${post.playerName}</p>
        ${replyTo ? `<p><strong>Replying to:</strong> ${replyTo}</p>` : ''}
        <p><strong>Message:</strong></p>
        <div style="padding:10px;border:1px solid #ddd;background:#f9f9f9;">
          ${post.text}
        </div>
        <p style="margin-top:12px;color:#666;font-size:12px;">
          ${new Date(post.createdAt).toLocaleString()}
        </p>
      </div>
    `;

    await sendEmail(adminEmail, subject, html);  } catch (e) {
    console.error('[Posts] Email notify failed:', e.message);
  }
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

app.patch('/api/posts/:id', async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required.' });
  if (text.length > 500) return res.status(400).json({ error: 'Message too long.' });
  const data = await readData();
  const post = (data.posts || []).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  post.text = text.trim();
  post.editedAt = new Date().toISOString();
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
