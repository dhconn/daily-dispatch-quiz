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
  } catch(e) {
    return false;
  }
}

// ── Save news sites ──────────────────────────────────────────
app.post('/api/sites', (req, res) => {
  const { sites } = req.body;
  if (typeof sites !== 'string') {
    return res.status(400).json({ error: 'sites must be a string' });
  }
  const data = readData();
  data.sites = sites;
  writeData(data);
  res.json({ ok: true });
});

// ── Load news sites ──────────────────────────────────────────
app.get('/api/sites', (req, res) => {
  const data = readData();
  res.json({ sites: data.sites || '' });
});

// ── Claude/Gemini proxy ──────────────────────────────────────
app.post('/api/claude', (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey) {
    return forwardToGemini(req, res, geminiKey);
  } else if (anthropicKey) {
    return forwardToAnthropic(req, res, anthropicKey);
  } else {
    return res.status(500).json({
      error: { message: 'No API key configured. Set either ANTHROPIC_API_KEY or GEMINI_API_KEY in Railway Variables.' }
    });
  }
});

function forwardToAnthropic(req, res, apiKey) {
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
    res.status(502).json({ error: { message: 'Anthropic proxy error: ' + err.message } });
  });
  proxyReq.write(body);
  proxyReq.end();
}

function forwardToGemini(req, res, apiKey) {
  const model = 'gemini-2.0-flash';
  const apiPath = `/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const messages = req.body.messages || [];
  const parts = messages.map(m => ({ text: m.content }));
  const geminiBody = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: req.body.max_tokens || 4000,
      temperature: 0.7
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(geminiBody)
    }
  };

  let rawData = '';
  const proxyReq = https.request(options, (proxyRes) => {
    proxyRes.on('data', chunk => rawData += chunk);
    proxyRes.on('end', () => {
      try {
        const geminiResponse = JSON.parse(rawData);
        if (geminiResponse.error) {
          return res.status(400).json({
            error: { message: 'Gemini API error: ' + geminiResponse.error.message }
          });
        }
        const text = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) {
          return res.status(500).json({ error: { message: 'Gemini returned an empty response.' } });
        }
        res.json({ content: [{ type: 'text', text }] });
      } catch(e) {
        res.status(500).json({ error: { message: 'Failed to parse Gemini response: ' + e.message } });
      }
    });
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: { message: 'Gemini proxy error: ' + err.message } });
  });
  proxyReq.write(geminiBody);
  proxyReq.end();
}

app.listen(PORT, () => {
  const usingGemini = !!process.env.GEMINI_API_KEY;
  const usingAnthropic = !!process.env.ANTHROPIC_API_KEY;
  console.log(`Daily Dispatch Quiz running on port ${PORT}`);
  if (usingGemini)         console.log('✓ Using Gemini API (free tier)');
  else if (usingAnthropic) console.log('✓ Using Anthropic API');
  else                     console.log('⚠ WARNING: No API key set.');
});
