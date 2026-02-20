const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.dirname(__filename)));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Detect which API key is configured and route accordingly ──────────────
app.post('/api/claude', (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey) {
    return forwardToGemini(req, res, geminiKey);
  } else if (anthropicKey) {
    return forwardToAnthropic(req, res, anthropicKey);
  } else {
    return res.status(500).json({
      error: { message: 'No API key configured. Set either ANTHROPIC_API_KEY or GEMINI_API_KEY in your environment variables.' }
    });
  }
});

// ── Anthropic handler ─────────────────────────────────────────────────────
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

// ── Gemini handler ────────────────────────────────────────────────────────
// Gemini uses a different request/response shape, so we translate here.
// The HTML sends Anthropic-format JSON; this converts it to Gemini format
// and converts Gemini's response back to Anthropic format so the HTML
// doesn't need to know which API is being used.
function forwardToGemini(req, res, apiKey) {
  const model = 'gemini-1.5-flash'; // Free tier model
  const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Convert Anthropic message format → Gemini format
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
    path,
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

        // Check for Gemini API errors
        if (geminiResponse.error) {
          return res.status(400).json({
            error: { message: 'Gemini API error: ' + geminiResponse.error.message }
          });
        }

        // Extract the text from Gemini's response
        const text = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) {
          return res.status(500).json({
            error: { message: 'Gemini returned an empty response.' }
          });
        }

        // Return in Anthropic-compatible format so the HTML works unchanged
        res.json({
          content: [{ type: 'text', text }]
        });

      } catch (e) {
        res.status(500).json({
          error: { message: 'Failed to parse Gemini response: ' + e.message }
        });
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
  if (usingGemini)    console.log('✓ Using Gemini API (free tier)');
  else if (usingAnthropic) console.log('✓ Using Anthropic API');
  else                console.log('⚠ WARNING: No API key set. Admin panel will not work.');
});
