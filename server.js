const express = require('express');
const https = require('https');
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

// ── Save news sites ───────────────────────────────────────────
app.post('/api/sites', (req, res) => {
  const { sites } = req.body;
  if (typeof sites !== 'string') return res.status(400).json({ error: 'sites must be a string' });
  const data = readData();
  data.sites = sites;
  writeData(data);
  res.json({ ok: true });
});

// ── Load news sites ───────────────────────────────────────────
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
