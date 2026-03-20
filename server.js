const express = require('express');
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.dirname(__filename)));

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

async function readData() {
  const keys = ['sites','rssCache','scores','dist','quizzes','archiveUrls',
                 'archiveQuestions','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate'];
  const data = {};
  await Promise.all(keys.map(async k => {
    const v = await getKey(k);
    if (v !== null) data[k] = v;
  }));
  return data;
}

async function writeData(data) {
  const keys = ['sites','rssCache','scores','dist','quizzes','archiveUrls',
                 'archiveQuestions','posts','messages','subscribers','emailPaused','emailPausedSnapshot','topicBlocklist','cachedTeaserHtml','cachedTeaserDate'];
  await Promise.all(keys.map(async k => {
    if (data[k] === null) await setKey(k, null);
    else if (data[k] !== undefined) await setKey(k, data[k]);
  }));
  return true;
}

// ── RSS feed fetcher ─────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsQuizBot/1.0)' },
      timeout: 10000
    }, (res) => {
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

function parseRSS(xml) {
  const items = [];
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

const BALTIMORE_RSS_FEEDS = {
  'baltimoretimes-online.com':  'https://baltimoretimes-online.com/feed/',
  'marylandmatters.org':        'https://marylandmatters.org/feed/',
  'thedailyrecord.com':         'https://thedailyrecord.com/feed/',
  'baltimorefishbowl.com':      'https://baltimorefishbowl.com/feed/',
  'southbmore.com':             'https://www.southbmore.com/feed/',
  'cbsnews.com/baltimore':      'https://www.cbsnews.com/baltimore/latest/rss/main',
  'baltimorebrew.com':          'https://baltimorebrew.com/feed/rss/',
  'thebanner.com':              'https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/',
  'thebaltimorebanner.com':     'https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/',
  'wypr.org':                   'https://www.wypr.org/podcast/news/rss.xml',
  'baltimoresun.com':           'https://www.baltimoresun.com/arc/outboundfeeds/rss/',
  'bizjournals.com/baltimore':  'https://www.bizjournals.com/baltimore/feed/news/local.rss',
  'technical.ly':               'https://technical.ly/baltimore/feed/',
  'dailyvoice.com':             'https://dailyvoice.com/maryland/feed.rss',
  'foxbaltimore.com':           'https://foxbaltimore.com/rss',
  'wbaltv.com':                 'https://www.wbaltv.com/rss',
  'wmar2news.com':              'https://www.wmar2news.com/rss',
  'wbal.com':                   'https://www.wbal.com/rss',
  'mytvbaltimore.com':          'https://foxbaltimore.com/rss',
  'cwbaltimore.com':            'https://www.wmar2news.com/rss',
  'afro.com':                   'https://afro.com/feed/',
  'urbanleaguebaltimore.org':   'https://urbanleaguebaltimore.org/feed/',
  'baltimoremagazine.com':      'https://www.baltimoremagazine.com/feed/',
  'citypaper.com':              'https://www.citypaper.com/feed/',
};

function isRecent(pubDate) {
  if (!pubDate) return true;
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return true;
    return (Date.now() - d.getTime()) < 72 * 60 * 60 * 1000;
  } catch(e) { return true; }
}

async function fetchAndCacheRSS() {
  const data = await readData();
  const savedSites = (data.sites || '').split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !s.includes('google.com') && !s.includes('therealnews.com'));
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

  const BLACKLISTED_URLS = [
    'university-maryland-police-sexual-misconduct',
    '/sponsored-content/',
    '/advertorial/',
    '/paid-content/',
    'us-rules-supreme-court-colorado-oil-climate-lawsuit',
    'heres-what-to-know-about-the-dhs-funding-shutdown',
    'supreme-court-nra-free-speech-ny-official',
    'federal-rules-louisiana-ten-commandments-law-schools-appeals',
    'the-weight-we-carry-food-labor-and-black-womens-bodies-as-living-archives',
  ];

  function isLocalStory(item, site) {
    if (site.includes('cbsnews') && (item.link || '').includes('/video/')) return false;

    const itemLink = (item.link || '').toLowerCase();
    const itemTitle = (item.title || '').toLowerCase();
    const dcSportsPatterns = [
      '/nationals-mlb/', '/commanders-nfl/', '/capitals-nhl/', '/wizards-nba/',
      'nationals spring training', 'washington nationals', 'washington commanders'
    ];
    if (dcSportsPatterns.some(p => itemLink.includes(p) || itemTitle.includes(p))) return false;

    const weatherPatterns = ['first alert', 'degrees', 'temperatures', 'forecast',
      'rain and snow', 'showers', 'warmer', 'colder', 'milder', 'weekend weather'];
    const majorWeather = ['blizzard', 'hurricane', 'tornado', 'historic storm',
      'state of emergency', 'major flooding', 'power outages'];
    if (weatherPatterns.some(p => itemTitle.includes(p)) &&
        !majorWeather.some(p => itemTitle.includes(p))) return false;

    const pureLocalSites = [
      'baltimorebrew', 'baltimoretimes', 'baltimorefishbowl', 'southbmore',
      'bizjournals.com/baltimore', 'technical.ly', 'wypr.org', 'marylandmatters',
      'baltimorebanner', 'thebanner.com', 'baltimoresun', 'afro.com',
      'baltimoremagazine', 'citypaper.com'
    ];
    if (pureLocalSites.some(s => site.includes(s))) return true;

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

  const seen = new Set();
  const sourceCount = {};
  const unique = allItems.filter(item => {
    const titleKey = item.title.toLowerCase().trim();
    if (seen.has(titleKey)) return false;
    seen.add(titleKey);
    const src = item.source || 'unknown';
    sourceCount[src] = (sourceCount[src] || 0) + 1;
    const cap = src.includes('thebanner') || src.includes('thebaltimorebanner') ? 30 : 15;
    if (sourceCount[src] > cap) return false;
    return true;
  });

  const freshData = await readData();
  freshData.rssCache = {
    items: unique.slice(0, 100),
    fetchedAt: new Date().toISOString(),
    errors: errors.length ? errors : []
  };
  await writeData(freshData);
  console.log(`RSS: Cached ${unique.length} articles. Errors: ${errors.length}`);
}

// ── Scheduled daily refresh at 6am Eastern ───────────────────
function scheduleNextRefresh() {
  const now = new Date();
  const next = new Date();
  const utcHour = 11;
  next.setUTCHours(utcHour, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  console.log(`RSS: Next scheduled refresh in ${Math.round(msUntil/60000)} minutes (6am Eastern).`);
  setTimeout(() => {
    fetchAndCacheRSS();
    scheduleNextRefresh();
  }, msUntil);
}
scheduleNextRefresh();

// ── Email helper (Resend) ─────────────────────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.log('Email skipped: RESEND_API_KEY not set.'); return false; }
  const body = JSON.stringify({
    from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
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
  const CHUNK_DELAY = 1000;
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

// ── Email template helpers ────────────────────────────────────
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
    </div>
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>
  </div>`;
}

function buildAdminMessageHtml(siteUrl, subscriberName, subscriberEmail, bodyText) {
  const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(subscriberEmail)}`;
  return `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1a1008;">
      <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
        <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
        <div style="font-size:28px;font-weight:bold;">The Daily Dispatch Quiz</div>
        <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#aaa;margin-top:6px;">A message from the editor</div>
      </div>
      <div style="padding:32px 24px;background:#f5f0e8;">
        <p style="font-size:16px;margin:0 0 20px;">Hi${subscriberName ? ' ' + subscriberName : ''},</p>
        <div style="font-size:15px;line-height:1.8;">${bodyText.replace(/\n/g, '<br>')}</div>
      </div>
      <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
        You're receiving this as a Daily Dispatch Quiz subscriber (${subscriberEmail}).
        <br><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
      </div>
    </div>`;
}

// ── Teaser generation ─────────────────────────────────────────
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

// ── Helper: today's date in Eastern time ─────────────────────
function easternToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// ── Redirect root to quiz ────────────────────────────────────
app.get('/', async (req, res) => {
  res.redirect('/news-quiz.html');
});

// ── RSS debug ────────────────────────────────────────────────
app.get('/api/rss/debug', async (req, res) => {
  const data = await readData();
  const cache = data.rssCache || { items: [], fetchedAt: null };
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

// ── RSS cache ────────────────────────────────────────────────
app.get('/api/rss', async (req, res) => {
  const data = await readData();
  const cache = data.rssCache || { items: [], fetchedAt: null, errors: [] };
  res.json(cache);
});

app.post('/api/rss/refresh', async (req, res) => {
  res.json({ ok: true, message: 'RSS refresh started in background.' });
  fetchAndCacheRSS();
});

// ── News sites ───────────────────────────────────────────────
app.post('/api/sites', async (req, res) => {
  const { sites } = req.body;
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
  const { date, answers, playerName } = req.body;
  if (!date || !Array.isArray(answers)) return res.status(400).json({ error: 'bad request' });
  const data = await readData();
  if (!data.dist) data.dist = {};
  if (!data.dist[date]) data.dist[date] = {};

  answers.forEach(({ qIdx, correct }) => {
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

app.get('/api/answers', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const data = await readData();
  res.json((data.dist && data.dist[date]) || {});
});

// ── Quiz start tracking ──────────────────────────────────────
app.post('/api/quiz-start', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const starts = (await getKey('quizStarts')) || {};
  starts[date] = (starts[date] || 0) + 1;
  await setKey('quizStarts', starts);
  res.json({ ok: true });
});

app.get('/api/quiz-starts', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const starts = (await getKey('quizStarts')) || {};
  res.json({ starts: starts[date] || 0, date });
});

// ── Article text fetcher ─────────────────────────────────────
app.post('/api/fetch-article', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const html = await fetchUrl(url);
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    const articleMatch = text.match(/<article[\s\S]*?<\/article>/i)
      || text.match(/<main[\s\S]*?<\/main>/i)
      || text.match(/class="[^"]*(?:article|story|content|post|entry)-body[^"]*"[\s\S]*?<\/div>/i);

    if (articleMatch) text = articleMatch[0];

    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim();

    const excerpt = text.slice(0, 1500);
    if (excerpt.length < 100) {
      return res.json({ ok: false, reason: 'paywall or insufficient content', excerpt: '' });
    }
    res.json({ ok: true, excerpt });
  } catch(e) {
    res.json({ ok: false, reason: e.message, excerpt: '' });
  }
});

// ── Leaderboard ──────────────────────────────────────────────
app.post('/api/scores', async (req, res) => {
  const { playerName, date, score } = req.body;
  if (!playerName || !date || typeof score !== 'number') {
    return res.status(400).json({ error: 'playerName, date, and score required' });
  }
  const data = await readData();
  if (!data.scores) data.scores = {};
  const key = playerName.toLowerCase().trim();
  if (!data.scores[key]) {
    data.scores[key] = { displayName: playerName.trim(), allTime: 0, dailyScores: {} };
  }
  if (!data.scores[key].dailyScores[date]) {
    data.scores[key].dailyScores[date] = score;
    data.scores[key].allTime = Object.values(data.scores[key].dailyScores).reduce((a,b) => a+b, 0);
  }
  await writeData(data);
  res.json({ ok: true });
});

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

// ── Archive ──────────────────────────────────────────────────
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
  if (urls) urls.forEach(u => { if (!data.archiveUrls.includes(u)) data.archiveUrls.push(u); });
  if (questions) questions.forEach(q => { if (!data.archiveQuestions.includes(q)) data.archiveQuestions.push(q); });
  if (slugs) slugs.forEach(s => { if (s && !data.archiveSlugs.includes(s)) data.archiveSlugs.push(s); });
  if (data.archiveUrls.length > 60) data.archiveUrls = data.archiveUrls.slice(-60);
  if (data.archiveQuestions.length > 60) data.archiveQuestions = data.archiveQuestions.slice(-60);
  if (data.archiveSlugs.length > 60) data.archiveSlugs = data.archiveSlugs.slice(-60);
  await writeData(data);
  res.json({ ok: true });
});

// ── Subscribers ──────────────────────────────────────────────
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

app.get('/api/subscribers', async (req, res) => {
  const data = await readData();
  const subs = Object.values(data.subscribers || {})
    .sort((a, b) => new Date(b.subscribedAt) - new Date(a.subscribedAt));
  res.json({ subscribers: subs });
});

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

// ── Quiz persistence ─────────────────────────────────────────
app.get('/api/quiz/latest', async (req, res) => {
  const data = await readData();
  if (!data.quizzes) return res.json({ quiz: null });
  const dates = Object.keys(data.quizzes).sort();
  if (dates.length === 0) return res.json({ quiz: null });
  const mostRecent = dates[dates.length - 1];
  res.json({ quiz: data.quizzes[mostRecent], date: mostRecent });
});

app.post('/api/quiz/fix-date', async (req, res) => {
  const data = await readData();
  if (!data.quizzes) return res.status(404).json({ error: 'No quizzes found' });
  const dates = Object.keys(data.quizzes).sort();
  if (dates.length === 0) return res.status(404).json({ error: 'No quizzes found' });
  const mostRecent = dates[dates.length - 1];
  const todayEastern = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (mostRecent === todayEastern) {
    return res.json({ ok: true, message: 'Already stored under correct date', date: mostRecent });
  }
  data.quizzes[todayEastern] = { ...data.quizzes[mostRecent], publishDate: todayEastern };
  await writeData(data);
  res.json({ ok: true, message: `Copied from ${mostRecent} to ${todayEastern}`, from: mostRecent, to: todayEastern });
});

app.all('/api/quiz/preview-email', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  let questions = null;
  let dateLabel = new Date().toISOString().slice(0, 10);

  if (req.method === 'POST' && req.body && req.body.questions && req.body.questions.length) {
    questions = req.body.questions;
    console.log('[PreviewEmail] Using draft questions:', questions.length);
  } else {
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

app.get('/api/quiz/archive', async (req, res) => {
  const data = await readData();
  const quizzes = data.quizzes || {};
  const today = easternToday();
  const dates = Object.keys(quizzes).filter(d => d !== today).sort().reverse().slice(0, 7);
  res.json({ dates });
});

app.post('/api/quiz', async (req, res) => {
  const { date, quiz, silent } = req.body;
  if (!date || !quiz) return res.status(400).json({ error: 'date and quiz required' });
  const data = await readData();
  if (!data.quizzes) data.quizzes = {};
  data.quizzes[date] = quiz;
  const keys = Object.keys(data.quizzes).sort();
  if (keys.length > 14) keys.slice(0, keys.length - 14).forEach(k => delete data.quizzes[k]);
  await writeData(data);

  if (!silent) {
    const siteUrl = process.env.SITE_URL || 'https://your-app.railway.app';
    const freshData = await readData();
    if (freshData.emailPaused) {
      console.log('Email notifications are globally paused — skipping subscriber emails.');
    }
    const subscribers = freshData.emailPaused ? [] : Object.values(freshData.subscribers || {}).filter(s => s.active);
    if (subscribers.length > 0) {
      console.log(`Email: Sending quiz notification to ${subscribers.length} subscribers…`);
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
      const emails = subscribers.map(sub => {
        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(sub.email)}`;
        return {
          from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
          to: [sub.email],
          subject,
          html: buildEmailHtml(siteUrl, date, sub.name, teaserHtml, unsubUrl)
        };
      });
      await sendEmailBatch(emails);
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
  if (date && data.quizzes[date]) return res.json({ quiz: data.quizzes[date], date });
  const mostRecent = dates[dates.length - 1];
  res.json({ quiz: data.quizzes[mostRecent], date: mostRecent, fallback: true });
});

// ── Topic blocklist ──────────────────────────────────────────
app.get('/api/blocklist', async (req, res) => {
  const data = await readData();
  res.json({ blocklist: data.topicBlocklist || [] });
});

app.post('/api/blocklist', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  data.topicBlocklist = Array.isArray(req.body.blocklist) ? req.body.blocklist : [];
  await writeData(data);
  console.log('[Admin] Topic blocklist updated: ' + data.topicBlocklist.length + ' item(s)');
  res.json({ ok: true, blocklist: data.topicBlocklist });
});

// ── Email pause ──────────────────────────────────────────────
app.get('/api/email-pause', async (req, res) => {
  const data = await readData();
  res.json({ paused: !!data.emailPaused });
});

app.post('/api/email-pause', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });
  const data = await readData();
  const pausing = !!req.body.paused;
  data.emailPaused = pausing;
  const subs = data.subscribers || {};
  if (pausing) {
    data.emailPausedSnapshot = Object.keys(subs).filter(k => subs[k].active);
    data.emailPausedSnapshot.forEach(k => { if (subs[k]) subs[k].active = false; });
    console.log('[Admin] Email PAUSED — ' + data.emailPausedSnapshot.length + ' subscriber(s) paused');
  } else {
    const snapshot = data.emailPausedSnapshot || [];
    snapshot.forEach(k => { if (subs[k]) subs[k].active = true; });
    data.emailPausedSnapshot = null;
    const restored = Object.values(subs).filter(s => s.active).length;
    console.log('[Admin] Email RESUMED — ' + restored + ' subscriber(s) active');
  }
  await writeData(data);
  res.json({ ok: true, paused: data.emailPaused });
});

// ── Teaser cache ─────────────────────────────────────────────
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

// ── Anthropic API proxy ──────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set in Railway Variables.' } });
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

// ── Message board ────────────────────────────────────────────
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
  data.posts.unshift(post);
  if (data.posts.length > 200) data.posts = data.posts.slice(0, 200);
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

// ── Contact the Editor ───────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════
//  ADMIN MESSAGING  ← NEW
// ════════════════════════════════════════════════════════════════

// POST /api/admin/message/single — send a custom message to one subscriber
app.post('/api/admin/message/single', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });

  const { to, name, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body are required' });

  // Verify recipient is a known active subscriber
  const data = await readData();
  const key = to.toLowerCase().trim();
  if (!data.subscribers || !data.subscribers[key]) {
    return res.status(404).json({ error: 'Subscriber not found' });
  }

  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';
  const html = buildAdminMessageHtml(siteUrl, name || data.subscribers[key].name, key, body);

  const ok = await sendEmail(key, subject, html);
  if (ok) {
    console.log(`[Admin] Single message sent to ${name || key} <${key}> — "${subject}"`);
    res.json({ ok: true, message: `Message sent to ${name || key}` });
  } else {
    res.status(500).json({ ok: false, error: 'Send failed — check server logs' });
  }
});

// POST /api/admin/message/bulk — send a custom message to all active subscribers
app.post('/api/admin/message/bulk', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN || 'admin';
  if (req.headers['x-admin-token'] !== adminToken) return res.status(403).json({ error: 'Forbidden' });

  const { subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });

  const data = await readData();
  const active = Object.values(data.subscribers || {}).filter(s => s.active);
  if (active.length === 0) return res.status(400).json({ error: 'No active subscribers' });

  const siteUrl = process.env.SITE_URL || 'https://dailydispatchquiz.com';

  const emails = active.map(sub => ({
    from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
    to: [sub.email],
    subject,
    html: buildAdminMessageHtml(siteUrl, sub.name, sub.email, body)
  }));

  await sendEmailBatch(emails);
  console.log(`[Admin] Bulk message sent to ${active.length} subscribers — "${subject}"`);
  res.json({ ok: true, message: `Message sent to ${active.length} active subscribers` });
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
  setTimeout(fetchAndCacheRSS, 5000);
  scheduleNextRefresh();
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
