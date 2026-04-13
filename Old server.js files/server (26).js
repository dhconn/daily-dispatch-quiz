// --- STABLE COMMONJS VERSION (avoids ESM crashes) ---

const express = require('express');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3000;

// ---------------- RSS FEEDS ----------------
const RSS_FEEDS = [
  'https://www.thebaltimorebanner.com/arc/outboundfeeds/rss/',
  'https://www.baltimoresun.com/arcio/rss/category/news/',
  'https://marylandmatters.org/feed/',
  'https://thedailyrecord.com/feed/',
  'https://www.wypr.org/rss.xml',
  'https://www.wbaltv.com/topstories-rss',
  'https://www.cbsnews.com/baltimore/latest/rss/main'
];

// ------------- GEOGRAPHIC FILTER -------------
function isRelevantArticle(title = '', content = '') {
  const geoKeywords = [
    'Baltimore', 'Baltimore County',
    'Anne Arundel', 'Howard County',
    'Harford County', 'Carroll County',
    'Annapolis', 'Maryland General Assembly',
    'Maryland legislature'
  ];

  return geoKeywords.some(keyword =>
    title.includes(keyword) || content.includes(keyword)
  );
}

// ------------- FETCH + DEDUPE -------------
async function fetchArticles() {
  const articles = [];
  const seenTitles = new Set();

  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      feed.items.slice(0, 12).forEach(item => {
        if (!item.title) return;
        if (seenTitles.has(item.title)) return;

        if (isRelevantArticle(item.title, item.contentSnippet || '')) {
          seenTitles.add(item.title);
          articles.push({
            title: item.title,
            link: item.link,
            content: item.contentSnippet || ''
          });
        }
      });
    } catch (err) {
      console.error('RSS error:', err.message);
    }
  }

  return articles.slice(0, 20);
}

// --------- ADAPTIVE QUESTION COUNT ---------
function determineQuestionCount(articleCount) {
  if (articleCount >= 14) return 8;
  if (articleCount >= 9) return 6;
  return 5;
}

// --------- TRIVIA QUESTION FILTER ---------
function isTrivialQuestion(text) {
  const bannedPatterns = [
    /which street/i,
    /what street/i,
    /what address/i,
    /motion to/i,
    /filed a motion/i,
    /groundbreaking/i,
    /exactly how many/i
  ];

  return bannedPatterns.some(pattern => pattern.test(text));
}

// --------- GENERATE QUIZ ---------
async function generateQuiz(articles, questionCount) {
  const prompt = `
You are generating a ${questionCount}-question daily news quiz focused on Baltimore City, surrounding Central Maryland counties, and statewide issues affecting Baltimore residents.

Rules:
- Avoid street names, minor defendants, procedural motions, ceremonial details.
- Emphasize civic significance and policy impact.
- Escalate difficulty progressively.
- Final question must require interpretation.
- At least half the questions must test significance rather than surface recall.

Articles:
${articles.map((a, i) => `${i + 1}. ${a.title}\n${a.content}`).join('\n\n')}

Return STRICT valid JSON only in this structure:
{
  "staleWarning": false,
  "staleArticles": [],
  "questions": [
    {
      "question": "",
      "options": ["", "", "", ""],
      "correctIndex": 0,
      "explanation": "",
      "difficulty": "easy",
      "sourceUrl": ""
    }
  ]
}
`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-opus-20240229',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();

  try {
    const text = data.content[0].text.trim();
    const parsed = JSON.parse(text);

    parsed.questions = parsed.questions.filter(q =>
      !isTrivialQuestion(q.question)
    );

    return parsed;
  } catch (err) {
    console.error('JSON parse error:', err);
    return { staleWarning: false, staleArticles: [], questions: [] };
  }
}

// --------- ROUTE ---------
app.get('/api/quiz', async (req, res) => {
  try {
    const articles = await fetchArticles();
    const questionCount = determineQuestionCount(articles.length);
    const quiz = await generateQuiz(articles, questionCount);
    res.json(quiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Quiz generation failed.' });
  }
});

app.use(express.static('.'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
