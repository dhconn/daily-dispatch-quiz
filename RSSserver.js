'use strict';

const https = require('https');
const http  = require('http');
const { readData, writeData } = require('./store');

// ── Raw HTTP fetcher ──────────────────────────────────────────
// Fetches raw RSS/Atom XML from a URL, returns text.
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

// ── RSS/Atom XML parser ───────────────────────────────────────
// Extracts titles, descriptions, links, pubDates from raw XML.
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
    const title       = get('title');
    const description = get('description') || get('summary') || get('content');
    const link        = get('link')
      || (block.match(/<link[^>]+href="([^"]+)"/i)  || [])[1]
      || (block.match(/<guid[^>]*>([^<]+)<\/guid>/i) || [])[1]
      || (block.match(/href="(https?:\/\/[^"]+)"/)   || [])[1]
      || '';
    const pubDate = get('pubDate') || get('published') || get('updated') || '';

    if (title) {
      items.push({ title, description: description.slice(0, 2000), link, pubDate });
    }
  }
  return items;
}

// ── Known Baltimore RSS feed URLs ─────────────────────────────
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

// ── Recency filter ────────────────────────────────────────────
// Returns true if the item falls within the 72-hour window.
function isRecent(pubDate) {
  if (!pubDate) return true;
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return true;
    return (Date.now() - d.getTime()) < 72 * 60 * 60 * 1000;
  } catch (e) { return true; }
}

// ── Locality keywords ─────────────────────────────────────────
const LOCAL_KEYWORDS = [
  'baltimore', 'maryland', ' md ', "md's", ' md:', 'annapolis', 'towson', 'bethesda', 'silver spring',
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

// ── Local-story filter ────────────────────────────────────────
function isLocalStory(item, site) {
  // Skip CBS video pages — articles have more usable text for quiz generation
  if (site.includes('cbsnews') && (item.link || '').includes('/video/')) return false;

  // Filter DC sports teams — Nationals, Commanders, Capitals, Wizards
  const itemLink  = (item.link  || '').toLowerCase();
  const itemTitle = (item.title || '').toLowerCase();
  const dcSportsPatterns = [
    '/nationals-mlb/', '/commanders-nfl/', '/capitals-nhl/', '/wizards-nba/',
    'nationals spring training', 'washington nationals', 'washington commanders'
  ];
  if (dcSportsPatterns.some(p => itemLink.includes(p) || itemTitle.includes(p))) return false;

  // Filter routine weather forecasts — keep only major storm coverage
  const weatherPatterns = ['first alert', 'degrees', 'temperatures', 'forecast',
    'rain and snow', 'showers', 'warmer', 'colder', 'milder', 'weekend weather'];
  const majorWeather = ['blizzard', 'hurricane', 'tornado', 'historic storm',
    'state of emergency', 'major flooding', 'power outages'];
  if (weatherPatterns.some(p => itemTitle.includes(p)) &&
      !majorWeather.some(p => itemTitle.includes(p))) return false;

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

// ── Main fetch + cache function ───────────────────────────────
// Reads the saved site list, fetches all feeds, filters, deduplicates,
// and writes the result to the rssCache key in the store.
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
  const errors   = [];

  const fetchWithTimeout = (site, feedUrl) => new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(), 8000);
    try {
      const xml    = await fetchUrl(feedUrl);
      const parsed = parseRSS(xml);
      const recent = parsed.filter(item => isRecent(item.pubDate));
      const items  = recent.filter(item => isLocalStory(item, site));
      console.log(`RSS OK: ${feedUrl} — ${parsed.length} total, ${recent.length} recent, ${items.length} local`);
      if (parsed.length > 0 && recent.length === 0) {
        console.log(`  oldest item date: ${parsed[parsed.length - 1].pubDate}`);
      }
      items.forEach(item => allItems.push({ ...item, source: site }));
    } catch (e) {
      errors.push(`${feedUrl}: ${e.message}`);
      console.log(`RSS FAIL: ${feedUrl} — ${e.message}`);
    } finally {
      clearTimeout(timer);
      resolve();
    }
  });

  await Promise.allSettled(feedsToFetch.map(({ site, feedUrl }) => fetchWithTimeout(site, feedUrl)));

  // Deduplicate by title, then cap per source
  const seen        = new Set();
  const sourceCount = {};
  const unique = allItems.filter(item => {
    const titleKey = item.title.toLowerCase().trim();
    if (seen.has(titleKey)) return false;
    seen.add(titleKey);
    const src = item.source || 'unknown';
    sourceCount[src] = (sourceCount[src] || 0) + 1;
    // Baltimore Banner gets a higher cap — richest pure-local source
    const cap = src.includes('thebanner') || src.includes('thebaltimorebanner') ? 30 : 15;
    if (sourceCount[src] > cap) return false;
    return true;
  });

  const freshData = await readData();
  freshData.rssCache = {
    items:     unique.slice(0, 100),
    fetchedAt: new Date().toISOString(),
    errors:    errors.length ? errors : []
  };
  await writeData(freshData);
  console.log(`RSS: Cached ${unique.length} articles. Errors: ${errors.length}`);
}

// ── Daily scheduler ───────────────────────────────────────────
// Call startScheduler() once from server.js after DB is ready.
// Fires fetchAndCacheRSS() every day at 6am Eastern (11am UTC).
function startScheduler() {
  function scheduleNextRefresh() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(11, 0, 0, 0); // 6am Eastern
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const msUntil = next - now;
    console.log(`RSS: Next scheduled refresh in ${Math.round(msUntil / 60000)} minutes (6am Eastern).`);
    setTimeout(() => {
      fetchAndCacheRSS();
      scheduleNextRefresh();
    }, msUntil);
  }
  scheduleNextRefresh();
}

// ── Express route handlers ────────────────────────────────────
// Attach to app in server.js:  rssService.registerRoutes(app)

function registerRoutes(app) {
  // Return cached articles
  app.get('/api/rss', async (req, res) => {
    const data  = await readData();
    const cache = data.rssCache || { items: [], fetchedAt: null, errors: [] };
    res.json(cache);
  });

  // Grouped debug view
  app.get('/api/rss/debug', async (req, res) => {
    const data  = await readData();
    const cache = data.rssCache || { items: [], fetchedAt: null };
    const bySource = {};
    for (const item of cache.items) {
      const src = item.source || 'unknown';
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push({ title: item.title, pubDate: item.pubDate, link: item.link });
    }
    res.json({
      version:    '2.2-banner30',
      fetchedAt:  cache.fetchedAt,
      totalCount: cache.items.length,
      errors:     cache.errors || [],
      bySource
    });
  });

  // Manual refresh trigger
  app.post('/api/rss/refresh', async (req, res) => {
    res.json({ ok: true, message: 'RSS refresh started in background.' });
    fetchAndCacheRSS(); // intentionally not awaited
  });
}

module.exports = { fetchAndCacheRSS, startScheduler, registerRoutes, fetchUrl };
