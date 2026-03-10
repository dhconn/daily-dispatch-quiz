const express = require('express');
const https = require('https');
const path = require('path');

// ── Database / key-value store ────────────────────────────────
const { initDb, getKey, setKey, readData, writeData } = require('./store');

// ── RSS service ───────────────────────────────────────────────
const rssService = require('./rssService');

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

// ── RSS routes (GET /api/rss, /api/rss/debug, POST /api/rss/refresh) ──
rssService.registerRoutes(app);

// ── Redirect root to quiz ────────────────────────────────────
app.get('/', async (req, res) => {
  res.redirect('/news-quiz.html');
});

// ── Save/load news sites ──────────────────────────────────────
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

// ── Answer distribution aggregation ──────────────────────────
// POST /api/answers  { date, answers: [{qIdx, correct}] }
app.post('/api/answers', async (req, res) => {
  const { date, answers } = req.body;
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
  const { date } = req.body;
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
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const html = await rssService.fetchUrl(url);

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

// ── Leaderboard ───────────────────────────────────────────────
// Scores stored as data.scores = { playerKey: { displayName, allTime, dailyScores: {date: score} } }

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
  // Only record the score once per day per player
  if (!data.scores[key].dailyScores[date]) {
    data.scores[key].dailyScores[date] = score;
    data.scores[key].allTime = Object.values(data.scores[key].dailyScores).reduce((a,b) => a+b, 0);
  }
  await writeData(data);
  res.json({ ok: true });
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
    <div style="background:#1a1008;color:#f5f0e8;text-align:center;padding:24px;">
      <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#f0c040;margin-bottom:6px;">BALTIMORE · DAILY DISPATCH</div>
      <div style="font-size:28px;font-weight:bold;">The Daily Dispatch Quiz</div>
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#aaa;margin-top:6px;">${date}</div>
    </div>
    <div style="padding:32px 24px;background:#f5f0e8;text-align:center;">
      <p style="font-size:18px;margin:0 0 8px;">Hi${subscriberName ? ' ' + subscriberName : ''},</p>
      <p style="font-size:16px;color:#444;margin:0 0 8px;">6 questions. 90 seconds.</p>
      <p style="font-size:16px;color:#444;margin:0 0 24px;">How well were you paying attention?</p>
      ${teaserHtml}
      <a href="${siteUrl}" style="display:inline-block;background:#1a1008;color:#f5f0e8;padding:16px 36px;font-family:monospace;font-size:13px;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">Play Today's Quiz ▸</a>
    </div>
    <div style="padding:16px 24px;text-align:center;font-size:11px;color:#999;font-family:monospace;border-top:1px solid #e0d8cc;">
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>
  </div>`;
}

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
    // Restore only subscribers who were active before the global pause
    const snapshot = data.emailPausedSnapshot || [];
    snapshot.forEach(k => { if (subs[k]) subs[k].active = true; });
    data.emailPausedSnapshot = null;
    console.log('[Admin] Email RESUMED — ' + snapshot.length + ' subscriber(s) restored');
  }
  await writeData(data);
  res.json({ ok: true, paused: data.emailPaused });
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

    // Prevent browser/admin panel caching
   res.setHeader('Cache-Control', 'no-store');

  res.json({
    subscribers: subs,
    emailPaused: !!data.emailPaused
 });
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
  if (!silent) {
    const siteUrl = process.env.SITE_URL || 'https://your-app.railway.app';
    // Re-read fresh to pick up emailPaused state set after this request started
    const freshData = await readData();
    if (freshData.emailPaused) {
      console.log('Email notifications are globally paused — skipping subscriber emails.');
    }
    const subscribers = freshData.emailPaused ? [] : Object.values(freshData.subscribers || {}).filter(s => s.active);
    if (subscribers.length > 0) {
      console.log(`Email: Sending quiz notification to ${subscribers.length} subscribers…`);
      const teasers = await generateTeasers(quiz.questions || []);
      const teaserHtml = buildTeaserHtml(teasers);
      console.log('Email teasers:', teasers.length ? teasers : 'none generated');
      for (const sub of subscribers) {
        const unsubUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(sub.email)}`;
        const emailHtml = buildEmailHtml(siteUrl, date, sub.name, teaserHtml, unsubUrl);
        const dow = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
        const subjects = {
          Monday:    "How well were you following Baltimore news today?",
          Tuesday:   "Can you beat today's Baltimore news quiz?",
          Wednesday: "6 questions about today's Baltimore headlines",
          Thursday:  "Think you know today's Baltimore news?",
          Friday:    "Friday's Baltimore News Quiz is live",
          Saturday:  "Saturday's Baltimore News Quiz is live",
          Sunday:    "Sunday's Baltimore News Quiz is live"
        };
        const subject = subjects[dow] || `Today's Baltimore Daily Dispatch Quiz is live — ${date}`;
        sendEmail(sub.email, subject, emailHtml).catch(() => {});
      }
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
  setTimeout(rssService.fetchAndCacheRSS, 5000);
  rssService.startScheduler();
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});

// ── Email helper (Resend) ─────────────────────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('Email skipped: RESEND_API_KEY not set.');
    return false;
  }
  const body = JSON.stringify({
    from: 'Editor @ Daily Dispatch Quiz <editor@dailydispatchquiz.com>',
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
