'use strict';
// outreach.js — Daily Dispatch Quiz outreach automation
//
// Runs hourly via Windows Task Scheduler (7am start).
// Detects a newly-published quiz, searches Reddit/X/Bluesky/Facebook/
// Instagram/news comment sections and the web for relevant conversations,
// drafts suggested replies with Claude, and emails a digest.
//
// Requires: outreach-config.json in the same folder.
// Run manually:  node outreach.js

require('dotenv').config();

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const { spawn }     = require('child_process');
const axios         = require('axios');
const nodemailer    = require('nodemailer');
const Anthropic     = require('@anthropic-ai/sdk');

// ── Paths & constants ─────────────────────────────────────────
const DIR           = __dirname;
const CONFIG_PATH   = path.join(DIR, 'outreach-config.json');
const LAST_RUN_PATH = path.join(DIR, 'outreach-last-run.txt');
const QUIZ_API      = 'https://dailydispatchquiz.com/api/quiz/latest';
const CONTACTS_PATH       = path.join(DIR, 'outreach-contacts.json');
const CONTACT_LOG_PATH    = path.join(DIR, 'outreach-contact-log.json');
const TODAY_CACHE_PATH    = path.join(DIR, 'outreach-today-cache.json');
const PENDING_EMAILS_PATH = path.join(DIR, 'outreach-pending-emails.json');

const REDDIT_SUBS = ['baltimore', 'maryland', 'baltimoreorioles', 'MDpolitics', 'bmore', 'ravens', 'orioles', 'annapolis', 'baltimore_social'];

// Platform-specific voice guidelines (length limits are in PLATFORM_LIMITS)
const PLATFORM_VOICE = {
  Reddit:
    'Engage with the actual topic first. Be a knowledgeable Baltimorean adding to the discussion. ' +
    'Only mention the quiz if it flows completely naturally — never force it.',
  'X/Twitter':
    'Voice is {xHandle}. Punchy, direct, Baltimore journalist energy. ' +
    'Engage with the topic. Quiz mention only if it genuinely fits in a single sentence.',
  Bluesky:
    'Handle {blueskyHandle}. Slightly warmer than Twitter but still concise. Baltimore local voice.',
  Instagram:
    'Handle @{instagramHandle}. Casual, visual-minded tone. End with relevant hashtags ' +
    '(#baltimore #bmore #marylandnews plus topic-specific ones).',
  Facebook:
    'Warm, community-oriented. Engage directly with the topic. ' +
    'Mention quiz only if it genuinely fits the conversation.',
  'News Comments':
    'Engage with the article topic first — add a real insight or a perspective others might have missed. ' +
    'If the quiz connects naturally, one low-key closing sentence is fine: ' +
    '"I covered this in today\'s quiz at dailydispatchquiz.com if you want to test yourself." Never lead with it.',
  'Web/Forum':
    'Match the site\'s tone. Add genuine value to the thread. ' +
    'If mentioning the quiz, make it feel like sharing a useful resource, not promotion.'
};

// Hard character/word limits per platform
const PLATFORM_LIMITS = {
  Reddit:          '150–200 words',
  'X/Twitter':     '280 characters — absolute hard limit, count carefully',
  Bluesky:         '300 characters — absolute hard limit',
  Instagram:       '100 words',
  'News Comments': '100–150 words',
  'Web/Forum':     '100–150 words',
  Facebook:        '100–150 words',
};

// ── Helpers ───────────────────────────────────────────────────
const sleep      = ms => new Promise(r => setTimeout(r, ms));
const escHtml    = s  => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const easternToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ── Config ────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[Outreach] Config file not found: ${CONFIG_PATH}`);
    console.error('[Outreach] Create outreach-config.json — see README in the file header.');
    process.exit(1);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('[Outreach] Invalid JSON in outreach-config.json:', e.message); process.exit(1); }

  // Fall back to environment variables for keys that may live in .env
  cfg.anthropicApiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  for (const k of ['braveApiKey', 'anthropicApiKey', 'gmailUser', 'gmailAppPassword']) {
    if (!cfg[k]) { console.error(`[Outreach] Missing required config field: ${k}`); process.exit(1); }
  }
  return cfg;
}

// ── Last-run tracking ─────────────────────────────────────────
const getLastRun  = () => fs.existsSync(LAST_RUN_PATH)
  ? fs.readFileSync(LAST_RUN_PATH, 'utf8').trim() : null;
const markRunDone = () => fs.writeFileSync(LAST_RUN_PATH, easternToday(), 'utf8');

// ── Quiz fetch ────────────────────────────────────────────────
async function fetchLatestQuiz() {
  const { data } = await axios.get(QUIZ_API, { timeout: 10000 });
  return data; // { quiz, date } or { quiz: null, scheduled: true }
}

// ── Topic extraction ──────────────────────────────────────────
async function extractTopics(questions, anthropic) {
  const list = questions
    .filter(q => q.question)
    .map((q, i) => `Q${i + 1}: ${q.question}`)
    .join('\n');

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Extract topics and named entities from these Baltimore news quiz questions for social media outreach.

${list}

For each question, write a 3-6 word TOPIC HEADLINE that describes the news story — like a newspaper section header. This is the most important part. Read carefully:

CORRECT — ask yourself "what event or issue does this question describe?" and headline that:
  "Baltimore Vehicle Price-Fixing Lawsuit"
  "MTA Bus Fare Increase Debate"
  "City Schools Budget Shortfall"
  "Ravens Draft Pick Trade"

WRONG — do NOT lift words from the question text:
  "Joining Dozens Other Cities Antitrust"  ← question fragment
  "Which Baltimore Official Recently"      ← starts with question word
  "How Much The City Spent On"             ← question fragment

The topic must make sense to someone who has NOT read the question.

Reply ONLY with a valid JSON array (no markdown fences, no preamble):
[
  {
    "question": "exact question text",
    "topic": "3-6 word news headline describing the story",
    "entities": ["named entity 1", "named entity 2"],
    "searchPhrases": ["2-4 word search phrase", "another phrase"]
  }
]

searchPhrases: what someone might type to find online discussions about this topic.`
      }]
    });

    const clean  = msg.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[Outreach] Topic extraction failed, using keyword fallback:', e.message);
    const STOP = new Set(['the','a','an','is','are','was','were','of','in','on','at',
      'to','for','with','by','from','that','this','which','when','where','who','what',
      'how','did','does','do','has','have','had','be','been','will','would','should',
      'could','can','may','might','their','its','than','and','or','but','about']);
    return questions.filter(q => q.question).map(q => ({
      question: q.question,
      topic: q.question.split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z]/g, ''))
        .filter(w => w.length > 2 && !STOP.has(w.toLowerCase()))
        .slice(0, 5).join(' '),
      entities: [],
      searchPhrases: [q.question.split(/\s+/).slice(0, 4).join(' ')]
    }));
  }
}

// ── Brave Search wrapper ──────────────────────────────────────
async function brave(query, apiKey, count = 5, freshness = 'pw') {
  try {
    const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      params: { q: query, count, freshness },
      timeout: 12000
    });
    return (data.web && data.web.results) || [];
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.warn('[Outreach] Brave rate limit — pausing 8s');
      await sleep(8000);
    } else {
      console.warn(`[Outreach] Brave search failed ("${query.slice(0, 55)}…"): ${e.message}`);
    }
    return [];
  }
}

// Resolve a human-readable label from the base platform type + URL
const OUTLET_NAMES = {
  'thebaltimorebanner.com': 'Baltimore Banner',
  'thebanner.com':          'Baltimore Banner',
  'baltimoresun.com':       'Baltimore Sun',
  'baltimorefishbowl.com':  'Baltimore Fishbowl',
  'marylandmatters.org':    'Maryland Matters',
  'wypr.org':               'WYPR',
  'baltimorebrew.com':      'Baltimore Brew',
  'thedailyrecord.com':     'The Daily Record',
  'wbaltv.com':             'WBAL-TV',
  'wmar2news.com':          'WMAR2 News',
  'foxbaltimore.com':       'Fox Baltimore',
  'cbsnews.com':            'CBS Baltimore',
  'afro.com':               'The Afro',
  'citypaper.com':          'City Paper',
  'technical.ly':           'Technical.ly',
  'bizjournals.com':        'Baltimore Business Journal',
  'nextdoor.com':           'Nextdoor',
};

function resolveLabel(platform, url) {
  try {
    const u    = new URL(url);
    const host = u.hostname.replace(/^www\./, '');

    if (platform === 'Reddit') {
      const m = u.pathname.match(/\/r\/(\w+)/i);
      return m ? `Reddit r/${m[1]}` : 'Reddit';
    }

    for (const [domain, name] of Object.entries(OUTLET_NAMES)) {
      if (host === domain || host.endsWith('.' + domain)) {
        return platform === 'News Comments' ? `${name} Comments` : name;
      }
    }

    if (['X/Twitter', 'Bluesky', 'Instagram', 'Facebook'].includes(platform)) return platform;

    // Generic fallback: capitalize the hostname stem
    const stem = host.split('.')[0];
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  } catch (e) {
    return platform;
  }
}

// Domains that are reference/government pages — not conversations to engage with
const JUNK_DOMAINS = /wikipedia\.org|britannica\.com|baltimorecity\.gov|news\.maryland\.gov|cbsnews\.com|wypr\.org|baltimoresun\.com|baltsun\.com/i;
// TV news sites where single-segment paths are always section/category pages, never articles
const TV_DOMAINS   = /wbaltv\.com|foxbaltimore\.com|wmar2news\.com|wbal\.com/i;

// Known section/category path segments that are never article pages
const SECTION_SLUGS = new Set([
  'news', 'local-news', 'local', 'baltimore', 'maryland', 'sports', 'weather',
  'politics', 'crime', 'entertainment', 'business', 'health', 'education',
  'traffic', 'community', 'lifestyle', 'opinion', 'investigations', 'video',
  'photos', 'podcasts', 'newsletters', 'subscribe', 'about', 'contact'
]);

function isConversationUrl(url) {
  try {
    const u        = new URL(url);
    const host     = u.hostname;
    if (JUNK_DOMAINS.test(host)) return false;
    const path     = u.pathname.replace(/\/+$/, '');
    // Bare root
    if (!path) return false;
    // Tag/archive pages
    if (path.includes('/tag/') || path.includes('/tags/')) return false;
    const segments = path.split('/').filter(Boolean);
    // Single-segment paths: block if it's a known section slug or a TV-domain category
    if (segments.length <= 1) {
      if (SECTION_SLUGS.has((segments[0] || '').toLowerCase())) return false;
      if (TV_DOMAINS.test(host)) return false; // all TV single-segment paths are sections
    }
    return true;
  } catch (e) {
    return true;
  }
}

// Build a normalized opportunity object from a Brave result
function mkOpp(platform, r, searchPhrase, extra = {}) {
  const url = r.url || '';
  return {
    platform,
    label:       resolveLabel(platform, url),
    title:       (r.title       || '').trim(),
    url,
    description: (r.description || '').slice(0, 300),
    searchPhrase,
    ...extra
  };
}

// ── Platform searches (sequential to respect rate limits) ─────
async function searchAll(phrases, questions, topics, apiKey) {
  const opps    = [];
  const p3      = phrases.slice(0, 3);
  const p2      = phrases.slice(0, 2);
  const socialRe = /reddit|twitter|x\.com|bsky|facebook|instagram/i;

  // ── Social platforms ──────────────────────────────────────────

  // Reddit — URL-based subreddit targeting (subreddit: is Reddit syntax, not Brave's)
  const subSites = REDDIT_SUBS.map(s => `site:reddit.com/r/${s}`).join(' OR ');
  for (const ph of p3) {
    await sleep(400);
    const rs = await brave(`(${subSites}) ${ph}`, apiKey, 5, 'pm');
    rs.forEach(r => opps.push(mkOpp('Reddit', r, ph)));
  }

  // X / Twitter — past month; past week is too narrow for local topics
  for (const ph of p3) {
    await sleep(400);
    const rs = await brave(`(site:x.com OR site:twitter.com) ${ph} baltimore`, apiKey, 3, 'pm');
    rs.forEach(r => opps.push(mkOpp('X/Twitter', r, ph)));
  }

  // Bluesky
  for (const ph of p3) {
    await sleep(400);
    const rs = await brave(`site:bsky.app ${ph} baltimore`, apiKey, 3, 'pm');
    rs.forEach(r => opps.push(mkOpp('Bluesky', r, ph)));
  }

  // Facebook
  for (const ph of p2) {
    await sleep(400);
    const rs = await brave(`site:facebook.com ${ph} baltimore`, apiKey, 3, 'pm');
    rs.forEach(r => opps.push(mkOpp('Facebook', r, ph)));
  }

  // Instagram
  for (const ph of p2) {
    await sleep(400);
    const rs = await brave(`site:instagram.com ${ph} baltimore`, apiKey, 3, 'pm');
    rs.forEach(r => opps.push(mkOpp('Instagram', r, ph)));
  }

  // ── News site searches ────────────────────────────────────────

  // Source-domain searches: for each quiz question, search the outlet that
  // originally published the story for related content and reader reactions
  const seenSourceDomains = new Set();
  for (const q of questions) {
    if (!q.sourceUrl) continue;
    let srcDomain;
    try { srcDomain = new URL(q.sourceUrl).hostname.replace(/^www\./, ''); }
    catch (e) { continue; }
    if (seenSourceDomains.has(srcDomain)) continue;
    seenSourceDomains.add(srcDomain);

    // Use the topic's search phrase if available, otherwise fall back to phrases[0]
    const topicEntry = topics.find(t => t.question === q.question);
    const ph = topicEntry
      ? (topicEntry.searchPhrases[0] || topicEntry.topic)
      : (phrases[0] || '');
    if (!ph) continue;

    await sleep(400);
    const rs = await brave(`site:${srcDomain} ${ph}`, apiKey, 5, 'pw');
    rs.filter(r => r.url !== q.sourceUrl && isConversationUrl(r.url))
      .forEach(r => opps.push(mkOpp('News Comments', r, ph, { sourceArticleUrl: q.sourceUrl })));
  }

  // Fixed Baltimore news source searches: always probe these outlets regardless
  // of which ones were in today's quiz, using the top search phrase per domain
  for (const domainSpec of BALTIMORE_NEWS_DOMAINS) {
    // Handle entries with a path hint, e.g. 'somesite.com/section' → site:somesite.com section
    const [domainPart, ...pathParts] = domainSpec.split('/');
    const siteClause = pathParts.length
      ? `site:${domainPart} ${pathParts.join(' ')}`
      : `site:${domainPart}`;
    const ph = phrases[0] || '';
    if (!ph) continue;
    await sleep(400);
    const rs = await brave(`${siteClause} ${ph}`, apiKey, 4, 'pw');
    rs.filter(r => isConversationUrl(r.url))
      .forEach(r => opps.push(mkOpp('News Comments', r, ph)));
  }

  // ── General web ───────────────────────────────────────────────
  for (const ph of p3) {
    await sleep(400);
    const rs = await brave(
      `${ph} baltimore (community OR forum OR nextdoor OR neighbors OR blog)`,
      apiKey, 5, 'pw'
    );
    rs.filter(r => !socialRe.test(r.url) && isConversationUrl(r.url))
      .forEach(r => opps.push(mkOpp('Web/Forum', r, ph)));
  }

  return opps;
}

// Key Baltimore news domains — always searched, scored higher
const BALTIMORE_NEWS_DOMAINS = [
  'thebaltimorebanner.com', 'thebanner.com', 'marylandmatters.org',
  'baltimorefishbowl.com', 'foxbaltimore.com',
  'thedailyrecord.com', 'wtop.com'
];
const BALT_NEWS_RE = /thebaltimorebanner\.com|thebanner\.com|marylandmatters\.org|baltimorefishbowl\.com|wbaltv\.com|foxbaltimore\.com|thedailyrecord\.com|wtop\.com/i;

// ── Opportunity scoring & filtering ──────────────────────────
const PLATFORM_SCORE = {
  Reddit: 20, 'News Comments': 18, Bluesky: 12, 'X/Twitter': 12,
  'Web/Forum': 10, Facebook: 6, Instagram: 6
};

const SPAM_RE = /buy now|for sale|promo code|sponsored post|follow me|check out my (page|profile)|make money|earn \$|work from home/i;

const HUMAN_INTEREST_RE = /mutual aid|community|neighbors|surprising|unexpected|first.ever|milestone|celebrates|launches|opens|wins|saves|raises money|fundrais|volunteer|grassroots|local hero|rallies|unique|unusual|remarkable|heartwarming|bizarre|record.breaking/i;

function scoreOpp(opp) {
  const t = `${opp.title} ${opp.description}`.toLowerCase();
  if (SPAM_RE.test(t)) return 0;

  let s = 40 + (PLATFORM_SCORE[opp.platform] || 0);
  if (t.includes('baltimore'))  s += 12;
  if (t.includes('maryland'))   s += 6;
  if (/\d+\s*(comment|upvote|point|reply|like)/i.test(t)) s += 8;
  if (t.includes('?'))          s += 4;
  if (t.length > 80)            s += 3;
  if (HUMAN_INTEREST_RE.test(t)) s += 15;
  // Boost results from key Baltimore news outlets
  if (BALT_NEWS_RE.test(opp.url)) s += 15;
  // Prefer deep article URLs over section pages (3+ segments = likely a specific article)
  try {
    const depth = new URL(opp.url).pathname.split('/').filter(Boolean).length;
    if (depth >= 3) s += 6;
    else if (depth >= 2) s += 2;
  } catch (e) {}
  return s;
}

function filterAndRank(raw, quizPhrases) {
  const seen = new Set();
  const STOP = new Set(['the','a','an','is','are','was','were','of','in','on','at',
    'to','for','with','by','from','that','this','which','when','where','who','what',
    'how','did','does','do','has','have','had','be','been','will','would','should',
    'could','can','may','might','their','its','than','and','or','but','about']);
  // Pre-filter: discard results sharing no individual keyword with today's quiz.
  // Uses word-level matching (not full phrase) so synonym/paraphrase results survive.
  const quizKeywords = new Set(
    (quizPhrases || [])
      .flatMap(p => p.toLowerCase().split(/\s+/))
      .map(w => w.replace(/[^a-z]/g, ''))
      .filter(w => w.length > 3 && !STOP.has(w))
  );
  const ranked = raw
    .filter(o => o.url && isConversationUrl(o.url) && !seen.has(o.url) && !!seen.add(o.url))
    .filter(o => {
      if (!quizKeywords.size) return true;
      const t = `${o.title} ${o.description}`.toLowerCase();
      return [...quizKeywords].some(kw => t.includes(kw));
    })
    .map(o    => ({ ...o, score: scoreOpp(o) }))
    .filter(o => o.score > 30)
    .sort((a, b)  => b.score - a.score);

  // Cap Reddit at 4 so it doesn't dominate; all others are uncapped
  let redditCount = 0;
  return ranked
    .filter(o => o.platform !== 'Reddit' || ++redditCount <= 4)
    .slice(0, 15);
}

// Conversational hedging phrases — track across digest to prevent repetition
const HEDGE_PHRASES = [
  "i'd be curious whether",
  "worth asking",
  "the part i keep coming back to is",
  "what's less clear is",
  "hard to know whether",
  "not sure anyone's fully worked out",
  "the open question is",
  "i keep wondering",
  "what i can't figure out is",
  "still unclear whether",
  "not sure this fully explains",
  "worth wondering"
];

function countWords(s) { return s.trim().split(/\s+/).length; }

// ── Post drafting ─────────────────────────────────────────────
async function draftPost(opp, quizTopics, cfg, anthropic, usedPhrases) {
  const voiceRaw = PLATFORM_VOICE[opp.platform] || PLATFORM_VOICE['Web/Forum'];
  const voice    = voiceRaw
    .replace('{xHandle}',         cfg.xHandle         || '@dconn')
    .replace('{blueskyHandle}',   cfg.blueskyHandle   || 'dhconn.bsky.social')
    .replace('{instagramHandle}', cfg.instagramHandle || 'dhconn413');

  // Tell Claude which hedge phrases are already exhausted this digest
  const exhausted = [...usedPhrases];
  const avoidLine = exhausted.length
    ? `\n• ALREADY USED in this digest — do NOT use these again: ${exhausted.map(p => `"${p}"`).join(', ')}`
    : '';

  const prompt = `Draft a post for David Conn, a Baltimore journalist who runs the Daily Dispatch Quiz (dailydispatchquiz.com).

TODAY'S QUIZ TOPICS (the quiz covers exactly these stories — nothing else):
${quizTopics}

OPPORTUNITY
Platform: ${opp.label || opp.platform}
Thread / Page: ${opp.title}
URL: ${opp.url}
Context: ${opp.description}

PLATFORM GUIDELINES:
${voice}

LENGTH: 75 words maximum. Write to fit — do not rely on being cut off. The post must end on a complete sentence or thought. A post that ends mid-sentence is never acceptable.

SINGLE TOPIC RULE: Write about the one topic or article linked above only. Do not reference any other Baltimore news story, even tangentially.

QUIZ RELEVANCE RULE:
• First, check: does this opportunity's content relate to one of today's quiz topics listed above?
• If NO — respond with exactly the word: SKIP. Linking people to a quiz that doesn't cover what they're reading is misleading and will annoy them.
• If YES — proceed with the post.

QUIZ MENTION RULE:
• The post must include a natural mention of dailydispatchquiz.com
• Place it where it genuinely fits — end or middle, never as the opener
• If you cannot work in a natural mention, respond with exactly the word: SKIP
• A forced quiz mention is worse than no post — SKIP is correct when in doubt

WRITING STYLE:
Write like a knowledgeable Baltimore resident typing fast — not a PR professional.
• Vary sentence length. Short punchy sentences mixed with longer ones.
• Contractions: it's, don't, I'd, that's, can't.
• Occasionally start with "And" or "But."
• Use conversational hedges to express uncertainty — but vary them. Options: "Worth asking…", "The part I keep coming back to is…", "What's less clear is…", "Hard to know whether…", "Not sure anyone's fully worked out…", "The open question is…"${avoidLine}
• Avoid: "It's worth noting", "It's also worth remembering", "Worth watching", "It's important to"
• Don't close with a tidy conclusion — end on a question or open thought.
• Don't start consecutive sentences with the same word.

Write ONLY the post text — no preamble, no quotes, no explanation.`;

  try {
    const messages = [{ role: 'user', content: prompt }];
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 250, messages
    });
    let text = msg.content[0].text.trim();

    // Respect SKIP signal
    if (text.toUpperCase().startsWith('SKIP')) return 'SKIP';

    // If over 75 words, ask Claude to rewrite — no truncation
    if (countWords(text) > 75) {
      const retry = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [
          ...messages,
          { role: 'assistant', content: text },
          { role: 'user', content: `That's ${countWords(text)} words — too long. Rewrite the entire post so it's 75 words or fewer. It must end on a complete sentence or thought — never cut off mid-sentence. Same voice, same quiz mention, just tighter. Write ONLY the revised post.` }
        ]
      });
      text = retry.content[0].text.trim();
      if (text.toUpperCase().startsWith('SKIP')) return 'SKIP';
    }

    return text;
  } catch (e) {
    console.error('[Outreach] Draft failed for', opp.platform, ':', e.message);
    return null;
  }
}

// ── Reporter email feature ────────────────────────────────────

// Maps outlet names (as they appear in outreach-contacts.json) to source domains
const OUTLET_DOMAIN_MAP = {
  'Baltimore Banner':   ['thebaltimorebanner.com', 'thebanner.com'],
  'Baltimore Sun':      ['baltimoresun.com', 'baltsun.com'],
  'Capital Gazette':    ['capgaznews.com'],
  'Maryland Matters':   ['marylandmatters.org'],
  'Baltimore Fishbowl': ['baltimorefishbowl.com'],
  'WYPR':               ['wypr.org'],
  'CBS Baltimore':      ['cbsnews.com'],
  'Paramount/CBS':      ['cbsnews.com'],  // some CBS contacts are listed under this outlet name
  'WBAL-TV':            ['wbaltv.com'],
};

function loadContacts() {
  if (!fs.existsSync(CONTACTS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8')); }
  catch (e) { console.warn('[Outreach] Could not read outreach-contacts.json:', e.message); return null; }
}

function loadContactLog() {
  if (!fs.existsSync(CONTACT_LOG_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(CONTACT_LOG_PATH, 'utf8')); }
  catch (e) { return []; }
}

function saveContactLog(log) {
  fs.writeFileSync(CONTACT_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}

function saveTodayCache(data) {
  try { fs.writeFileSync(TODAY_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.warn('[Outreach] Could not save today cache:', e.message); }
}

function genToken() {
  return crypto.randomBytes(12).toString('hex');
}

function savePendingEmails(pending) {
  try { fs.writeFileSync(PENDING_EMAILS_PATH, JSON.stringify(pending, null, 2), 'utf8'); }
  catch (e) { console.warn('[Outreach] Could not save pending emails:', e.message); }
}

// Score a reporter's relevance to a specific story
const MANAGEMENT_BEATS = new Set([
  'editor', 'managing editor', 'editor-in-chief', 'executive editor',
  'vp editorial', 'co-founder', 'founder', 'ceo', 'publisher', 'senior news producer'
]);

function scoreReporterForStory(reporter, question, topic) {
  const text = `${question.question || ''} ${topic.topic || ''} ${(topic.entities || []).join(' ')}`.toLowerCase();
  const beat  = (reporter.beat || '').toLowerCase();
  let score   = 0;

  if (reporter.emailVerified) score += 30;

  // Beat keyword relevance
  const beatWords = beat.split(/[\s,&/]+/).filter(w => w.length > 3);
  score += beatWords.filter(w => text.includes(w)).length * 15;

  // Prefer reporters over management/editorial roles
  if (!MANAGEMENT_BEATS.has(beat.trim())) score += 10;

  return score;
}

// Fetch an article and extract the author byline
// Tries JSON-LD first (reliable across all major news sites), then meta tag, then rel=author
async function fetchByline(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsQuizBot/1.0)' },
      maxContentLength: 600000
    });

    // 1. JSON-LD structured data
    const ldBlocks = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const block of ldBlocks) {
      try {
        const data  = JSON.parse(block[1]);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (!item.author) continue;
          const authors = Array.isArray(item.author) ? item.author : [item.author];
          const names   = authors.map(a => (typeof a === 'string' ? a : a.name) || '').filter(Boolean);
          if (names.length) return names;
        }
      } catch (e) { /* malformed JSON-LD — try next block */ }
    }

    // 2. <meta name="author"> tag
    const metaMatch = html.match(/<meta\s[^>]*name="author"[^>]*content="([^"]+)"/i)
                   || html.match(/<meta\s[^>]*content="([^"]+)"[^>]*name="author"/i);
    if (metaMatch && metaMatch[1].trim()) return [metaMatch[1].trim()];

    // 3. rel="author" anchor text
    const relMatch = html.match(/<a[^>]+rel="author"[^>]*>\s*([A-Z][a-zA-Z .'-]{3,})\s*<\/a>/i);
    if (relMatch) return [relMatch[1].trim()];

    return null; // byline not extractable
  } catch (e) {
    return null; // paywall, timeout, network error — caller handles
  }
}

// Check if a reporter in our contact list is the author named in a byline
function reporterMatchesAuthor(reporter, authorName) {
  const rName = reporter.name.toLowerCase().trim();
  const aName = authorName.toLowerCase().trim().replace(/^by\s+/i, '');

  if (rName === aName) return true;

  const rParts = rName.split(/\s+/);
  const aParts = aName.split(/\s+/);
  const rLast  = rParts[rParts.length - 1];
  const aLast  = aParts[aParts.length - 1];

  // Last name must match and be substantial
  if (rLast !== aLast || rLast.length <= 3) return false;

  const rFirst = rParts[0];
  const aFirst = aParts[0];
  if (rFirst === aFirst) return true;
  // Handle "J. Cox" matching "John Cox" (initial only in one name)
  if ((rFirst.length <= 2 || aFirst.length <= 2) && rFirst[0] === aFirst[0]) return true;

  return false;
}

// Fetch the RSS cache from the production server
async function fetchRssCache() {
  try {
    const { data } = await axios.get('https://dailydispatchquiz.com/api/rss', { timeout: 10000 });
    return data.items || [];
  } catch (e) {
    console.warn('[Outreach] Could not fetch RSS cache:', e.message);
    return [];
  }
}

// Match reporters to today's quiz questions by fetching article bylines
async function matchReporters(questions, topics, contacts) {
  const allMatches = [];

  // Build URL→author map from the RSS cache — bypasses paywalls for outlets like the Banner
  const rssItems = await fetchRssCache();
  const rssAuthorMap = new Map();
  for (const item of rssItems) {
    if (item.link && item.author) rssAuthorMap.set(item.link, item.author);
  }
  console.log(`[Outreach] RSS cache loaded — ${rssAuthorMap.size} items with author data`);

  for (const q of questions) {
    if (!q.sourceUrl) continue;
    let storyDomain;
    try { storyDomain = new URL(q.sourceUrl).hostname.replace(/^www\./, ''); }
    catch (e) { continue; }

    const topicEntry = topics.find(t => t.question === q.question) || {};

    const matchedOutlets = Object.entries(OUTLET_DOMAIN_MAP)
      .filter(([, domains]) => domains.some(d => storyDomain === d || storyDomain.endsWith('.' + d)))
      .map(([outlet]) => outlet);

    if (!matchedOutlets.length) continue;

    const outletReporters = contacts.filter(c => matchedOutlets.includes(c.outlet));
    if (!outletReporters.length) continue;

    // Try RSS cache first (no paywall), fall back to live article fetch
    let bylineNames = null;
    const rssAuthor = rssAuthorMap.get(q.sourceUrl);
    if (rssAuthor) {
      bylineNames = [rssAuthor];
      process.stdout.write(`[Outreach] Byline from RSS cache: ${q.sourceUrl.slice(0, 70)}…`);
    } else {
      process.stdout.write(`[Outreach] Fetching byline: ${q.sourceUrl.slice(0, 70)}…`);
      bylineNames = await fetchByline(q.sourceUrl);
      await sleep(300);
    }

    if (!bylineNames) {
      console.log(' (not found — skipping)');
      continue;
    }

    // Try to match each byline name against our contact list
    let matched = null;
    for (const name of bylineNames) {
      matched = outletReporters.find(r => reporterMatchesAuthor(r, name));
      if (matched) break;
    }

    if (!matched) {
      console.log(` (${bylineNames.join(', ')} — not in contacts, skipping)`);
      continue;
    }

    console.log(` → ${matched.name}`);
    allMatches.push({ reporter: matched, question: q, topic: topicEntry,
                      storyUrl: q.sourceUrl, score: 100 });
  }

  // One email per reporter — deduplicate keeping first match
  const byEmail = new Map();
  for (const m of allMatches) {
    if (!byEmail.has(m.reporter.email)) byEmail.set(m.reporter.email, m);
  }

  return [...byEmail.values()];
}

// Draft a personal email to a reporter using Claude
async function draftReporterEmail(match, contactHistory, anthropic) {
  const { reporter, question, topic, storyUrl } = match;
  const priorContacts = (contactHistory && contactHistory.contacts) || [];
  const hasHistory    = priorContacts.length > 0;

  let historyCtx = '';
  if (hasHistory) {
    const last = priorContacts[priorContacts.length - 1];
    historyCtx = `David has contacted this reporter ${priorContacts.length} time(s) before. Most recent: ${last.date}, story topic: "${last.storyTopic}".`;
  }

  const prompt = `Write a short, personal email from David Conn to a reporter whose story appeared in the Daily Dispatch Quiz today.

REPORTER
Name: ${reporter.name}
Outlet: ${reporter.outlet}
Beat: ${reporter.beat}

STORY
Topic: ${topic.topic || 'Baltimore news'}
URL: ${storyUrl}
Quiz question that used this story: "${question.question}"

${hasHistory ? `CONTACT HISTORY\n${historyCtx}\n` : ''}
REQUIREMENTS:
• 2-3 sentences maximum — warm, casual, never a form letter
• Mention the story by its specific topic, not generically ("your recent story" is too vague)
• Note it appeared in today's Daily Dispatch Quiz at dailydispatchquiz.com
${hasHistory ? '• Acknowledge the history naturally, e.g.: "I reached out a while back when your piece on X ran in the quiz…", "Hey — you\'ve made the quiz again…", "Nice — you\'re showing up regularly in the quiz lately…"' : ''}
• Invite them to play the quiz and share it with their audience or friends
• Sign off: David Conn, editor of the Daily Dispatch Quiz
• Start with their first name casually — NOT "Dear"

Write only the email body — no subject line, no extra explanation.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content[0].text.trim();
  } catch (e) {
    console.warn(`[Outreach] Reporter email draft failed (${reporter.email}):`, e.message);
    return null;
  }
}

// Orchestrate reporter matching and email drafting
async function buildReporterEmails(questions, topics, contacts, anthropic) {
  const matches = await matchReporters(questions, topics, contacts);
  if (!matches.length) {
    console.log('[Outreach] No reporters matched today\'s quiz sources — skipping reporter emails');
    return [];
  }
  console.log(`[Outreach] ${matches.length} reporter match(es) — drafting emails…`);

  const log     = loadContactLog();
  const results = [];

  for (const match of matches) {
    await sleep(300);
    const history    = log.find(c => c.email === match.reporter.email) || null;
    const draftEmail = await draftReporterEmail(match, history, anthropic);
    if (!draftEmail) continue;
    results.push({ reporter: match.reporter, topic: match.topic,
                   storyUrl: match.storyUrl, question: match.question,
                   draftEmail, token: genToken() });
    process.stdout.write('r');
  }
  if (matches.length) console.log();
  return results;
}

// Build the HTML block for the reporter emails digest section
function reporterEmailsHtml(reporterEmails, cfg) {
  if (!reporterEmails.length) return '';

  const host       = (cfg && cfg.serverHost) || 'localhost';
  const port       = (cfg && cfg.outreachPort) || 3001;
  const subjectEnc = encodeURIComponent("Your story in today's Daily Dispatch Quiz");

  const rows = reporterEmails.map(re => {
    const serverHref = `http://${host}:${port}/reporter-email?token=${re.token}`;
    const mailtoHref = `mailto:${re.reporter.email}?subject=${subjectEnc}&body=${encodeURIComponent(re.draftEmail)}`;
    return `
    <div style="margin:0 0 16px;border:1px solid #b8cce4;overflow:hidden;">
      <div style="background:#1a3a6b;padding:7px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-family:monospace;font-size:11px;color:#fff;font-weight:bold;">${escHtml(re.reporter.name)} &mdash; ${escHtml(re.reporter.outlet)}</span>
        <span style="font-family:monospace;font-size:10px;color:rgba(255,255,255,.7);">${escHtml(re.reporter.beat)}${re.reporter.emailVerified ? ' ✓' : ''}</span>
      </div>
      <div style="padding:12px 16px;background:#fff;">
        <div style="font-family:monospace;font-size:10px;color:#888;margin-bottom:8px;">STORY: ${escHtml(re.topic.topic || re.storyUrl)}</div>
        <div style="background:#f0f5fb;border:1px solid #b8cce4;padding:10px 12px;margin-bottom:10px;">
          <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#aaa;margin-bottom:6px;">DRAFT EMAIL</div>
          <div style="font-size:13px;line-height:1.7;color:#1a1008;white-space:pre-wrap;">${escHtml(re.draftEmail)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <a href="${serverHref}" style="display:inline-block;background:#1a3a6b;color:#fff;padding:7px 14px;font-family:monospace;font-size:11px;letter-spacing:1px;text-decoration:none;">✉ Send &amp; Log ▸</a>
          <a href="${mailtoHref}" style="display:inline-block;background:#888;color:#fff;padding:7px 14px;font-family:monospace;font-size:11px;letter-spacing:1px;text-decoration:none;">✉ Send without logging</a>
          <span style="font-family:monospace;font-size:10px;color:#999;">${escHtml(re.reporter.email)}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 24px;background:#eaf1fb;border-bottom:1px solid #b8cce4;">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#1a3a6b;margin-bottom:14px;">REPORTER EMAILS (${reporterEmails.length})</div>
    ${rows}
  </div>`;
}

// ── --log-today confirmation email ───────────────────────────
async function sendLogConfirmation(cfg, date, loggedReporters, totalInCache, note) {
  try {
    let bodyHtml;
    if (note === 'cache_missing') {
      bodyHtml = `<p>No contacts logged — <code>outreach-today-cache.json</code> was not found.</p>
        <p>Run the main outreach workflow first to generate the cache.</p>`;
    } else if (note === 'cache_error') {
      bodyHtml = `<p>No contacts logged — could not parse <code>outreach-today-cache.json</code>.</p>`;
    } else if (loggedReporters.length === 0) {
      const reason = totalInCache > 0
        ? `${totalInCache} reporter(s) were in the cache but all had already been logged.`
        : 'No reporters were found in today\'s cache.';
      bodyHtml = `<p>No new contacts logged for <strong>${escHtml(date)}</strong>.</p><p>${reason}</p>`;
    } else {
      const rows = loggedReporters
        .map(r => `<tr><td style="padding:5px 12px 5px 0;font-size:13px;">${escHtml(r.name)}</td>` +
                  `<td style="padding:5px 0;font-size:13px;color:#555;">${escHtml(r.outlet)}</td></tr>`)
        .join('');
      bodyHtml = `<p>Logged <strong>${loggedReporters.length}</strong> reporter contact(s) for <strong>${escHtml(date)}</strong>:</p>
        <table style="border-collapse:collapse;margin:8px 0 16px;">${rows}</table>
        <p style="font-size:12px;color:#888;">Saved to <code>outreach-contact-log.json</code>.</p>`;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;max-width:600px;margin:40px auto;color:#1a1008;padding:0 20px;">
  <div style="border-bottom:2px solid #1a3a6b;padding-bottom:8px;margin-bottom:20px;">
    <span style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#1a3a6b;">DAILY DISPATCH QUIZ</span>
    <div style="font-size:18px;font-weight:bold;margin-top:4px;">Contact Log Update</div>
  </div>
  ${bodyHtml}
</body></html>`;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword }
    });
    await transporter.sendMail({
      from:    cfg.gmailUser,
      to:      'dhconn@gmail.com',
      subject: `DDQ Contact Log Updated — ${date}`,
      html
    });
    console.log('[Outreach] Log confirmation email sent.');
  } catch (e) {
    console.warn('[Outreach] Could not send log confirmation email:', e.message);
  }
}

// ── --log-today command ───────────────────────────────────────
async function logTodayCommand() {
  console.log('[Outreach] --log-today: updating contact log…');

  const cfg   = loadConfig();
  const today = easternToday();

  if (!fs.existsSync(TODAY_CACHE_PATH)) {
    console.error('[Outreach] outreach-today-cache.json not found — run the main workflow first.');
    await sendLogConfirmation(cfg, today, [], 0, 'cache_missing');
    process.exit(1);
  }

  let cache;
  try { cache = JSON.parse(fs.readFileSync(TODAY_CACHE_PATH, 'utf8')); }
  catch (e) {
    console.error('[Outreach] Could not parse today cache:', e.message);
    await sendLogConfirmation(cfg, today, [], 0, 'cache_error');
    process.exit(1);
  }

  const { date, reporterEmails = [] } = cache;

  const log            = loadContactLog();
  let logged           = 0;
  const loggedReporters = [];

  for (const re of reporterEmails) {
    let entry = log.find(c => c.email === re.reporter.email);
    if (!entry) { entry = { email: re.reporter.email, contacts: [] }; log.push(entry); }
    // Avoid double-logging the same date + story
    if (entry.contacts.some(c => c.date === date && c.storyUrl === re.storyUrl)) continue;
    entry.contacts.push({ date, storyUrl: re.storyUrl, storyTopic: re.topic.topic || '' });
    loggedReporters.push(re.reporter);
    logged++;
  }

  saveContactLog(log);
  console.log(`[Outreach] Logged ${logged} contact(s) for ${date}.`);

  await sendLogConfirmation(cfg, date, loggedReporters, reporterEmails.length, null);
}

// ── Email digest ──────────────────────────────────────────────
async function sendDigest(quizDate, topics, opps, reporterEmails, cfg) {
  // Color keyed by base platform type, label is used for display
  const platColor = {
    Reddit: '#ff4500', 'X/Twitter': '#000000', Bluesky: '#0085ff',
    Instagram: '#c13584', Facebook: '#1877f2',
    'News Comments': '#1a6b3c', 'Web/Forum': '#555555'
  };

  const topicsHtml = topics.map(t => `
    <div style="margin:0 0 8px;padding:10px 14px;background:#fff;border-left:3px solid #b8860b;">
      <div style="font-family:monospace;font-size:10px;color:#999;letter-spacing:1px;margin-bottom:2px;">${escHtml((t.topic || '').toUpperCase())}</div>
      <div style="font-size:13px;color:#1a1008;line-height:1.5;">${escHtml(t.question)}</div>
      ${(t.entities || []).length
        ? `<div style="font-family:monospace;font-size:11px;color:#bbb;margin-top:3px;">${escHtml(t.entities.join(' · '))}</div>`
        : ''}
    </div>`).join('');

  const oppsHtml = opps.length
    ? opps.map(o => `
    <div style="margin:0 0 20px;border:1px solid #ddd;overflow:hidden;">
      <div style="background:${platColor[o.platform] || '#555'};padding:7px 14px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-family:monospace;font-size:11px;color:#fff;font-weight:bold;letter-spacing:1px;">${escHtml(o.label || o.platform)}</span>
        <span style="font-family:monospace;font-size:10px;color:rgba(255,255,255,.55);">score ${o.score}</span>
      </div>
      <div style="padding:14px 16px;background:#fff;">
        <div style="font-size:14px;font-weight:bold;color:#1a1008;margin-bottom:5px;">${escHtml(o.title)}</div>
        ${o.description
          ? `<div style="font-size:12px;color:#666;line-height:1.5;margin-bottom:8px;">${escHtml(o.description)}</div>`
          : ''}
        <div style="margin-bottom:12px;">
          <a href="${escHtml(o.url)}" style="font-family:monospace;font-size:11px;color:#1a6b9a;word-break:break-all;">${escHtml(o.url)}</a>
        </div>
        <div style="background:#f5f0e8;border:1px solid #e0d8cc;padding:12px 14px;">
          <div style="font-family:monospace;font-size:9px;letter-spacing:1px;color:#aaa;margin-bottom:7px;">SUGGESTED POST</div>
          <div style="font-size:13px;line-height:1.7;color:#1a1008;white-space:pre-wrap;">${escHtml(o.draftPost)}</div>
        </div>
      </div>
    </div>`).join('')
    : '<p style="font-family:monospace;font-size:12px;color:#999;font-style:italic;">No opportunities found today.</p>';

  const reporterHtml = reporterEmailsHtml(reporterEmails, cfg);

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px 0;background:#f0ebe0;">
<div style="font-family:Georgia,serif;max-width:700px;margin:0 auto;color:#1a1008;">

  <div style="background:#1a1008;color:#f5f0e8;padding:20px 24px;">
    <div style="font-family:monospace;font-size:10px;letter-spacing:3px;color:#f0c040;margin-bottom:4px;">DAILY DISPATCH QUIZ</div>
    <div style="font-size:22px;font-weight:bold;">Outreach Digest</div>
    <div style="font-family:monospace;font-size:11px;color:#aaa;margin-top:5px;">${escHtml(quizDate)} &middot; ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'}${reporterEmails.length ? ` &middot; ${reporterEmails.length} reporter email${reporterEmails.length === 1 ? '' : 's'}` : ''}</div>
  </div>

  <div style="padding:18px 24px;background:#f5f0e8;border-bottom:1px solid #ddd;">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#999;margin-bottom:10px;">TODAY'S QUIZ TOPICS</div>
    ${topicsHtml}
  </div>

  ${reporterHtml}

  <div style="padding:20px 24px;background:#fff;">
    <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#999;margin-bottom:14px;">ENGAGEMENT OPPORTUNITIES</div>
    ${oppsHtml}
  </div>

  <div style="padding:12px 24px;background:#f0ebe0;font-family:monospace;font-size:10px;color:#bbb;text-align:center;">
    outreach.js &middot; ${escHtml(new Date().toISOString())}
  </div>

</div>
</body></html>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword }
  });

  await transporter.sendMail({
    from:    cfg.gmailUser,
    to:      'dhconn@gmail.com',
    subject: `DDQ Outreach Opportunities — ${quizDate}`,
    html
  });

  console.log(`[Outreach] Digest sent to dhconn@gmail.com (${opps.length} opportunities)`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('[Outreach] Run started:', new Date().toISOString());

  const cfg   = loadConfig();
  const today = easternToday();

  // Guard: only run once per day
  if (getLastRun() === today) {
    console.log(`[Outreach] Already ran today (${today}) — exiting`);
    return;
  }

  // Fetch latest quiz
  let quizData;
  try {
    quizData = await fetchLatestQuiz();
  } catch (e) {
    console.error('[Outreach] Could not fetch quiz:', e.message);
    process.exit(1);
  }

  // Guard: quiz must exist and have questions
  if (!quizData.quiz || !(quizData.quiz.questions || []).length) {
    console.log('[Outreach] No quiz published yet — exiting');
    return;
  }

  // Guard: quiz must be from today (Eastern time)
  if (quizData.date !== today) {
    console.log(`[Outreach] Latest quiz is from ${quizData.date}, not today (${today}) — exiting`);
    return;
  }

  // Guard: quiz must be ≤ 8 hours old, if a timestamp is available
  const ts = quizData.quiz.publishedAt || quizData.quiz.savedAt;
  if (ts) {
    const ageH = (Date.now() - new Date(ts).getTime()) / 3600000;
    if (ageH > 8) {
      console.log(`[Outreach] Quiz is ${ageH.toFixed(1)}h old (max 8h) — exiting`);
      return;
    }
    console.log(`[Outreach] Quiz age: ${(ageH * 60).toFixed(0)} minutes`);
  }

  const { questions } = quizData.quiz;
  console.log(`[Outreach] Processing ${quizData.date} — ${questions.length} questions`);

  const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });

  // 1. Extract topics + search phrases from quiz questions
  console.log('[Outreach] Extracting topics…');
  const topics  = await extractTopics(questions, anthropic);
  console.log(`[Outreach] ${topics.length} topics extracted`);

  const phrases = [...new Set(
    topics
      .flatMap(t => [...(t.searchPhrases || []), ...(t.entities || [])])
      .filter(p  => p && p.trim().length > 3)
  )];
  console.log('[Outreach] Search phrases:', phrases.join(' | '));

  // 2. Search all platforms
  console.log('[Outreach] Searching platforms…');
  const rawOpps = await searchAll(phrases, questions, topics, cfg.braveApiKey);
  console.log(`[Outreach] ${rawOpps.length} raw results found`);

  // 3. Deduplicate, score, and cap at 15
  const filtered = filterAndRank(rawOpps, phrases);
  console.log(`[Outreach] ${filtered.length} quality opportunities after filtering`);

  // 4. Draft a suggested post for each opportunity
  const context = topics
    .map(t => `• ${t.topic}: ${(t.entities || []).join(', ')}`)
    .join('\n');

  console.log('[Outreach] Drafting posts with Claude…');
  const withDrafts = [];
  const usedPhrases = new Set(); // track hedge phrases across the digest
  for (const opp of filtered) {
    await sleep(300);
    const text = await draftPost(opp, context, cfg, anthropic, usedPhrases);
    if (!text || text === 'SKIP') {
      console.log(`\n[Outreach] Skipped ${opp.label || opp.platform} — ${!text ? 'API error' : 'quiz mention not natural'}`);
      continue;
    }
    // Record which hedge phrases this post used so the next one avoids them
    const lower = text.toLowerCase();
    HEDGE_PHRASES.forEach(p => { if (lower.includes(p)) usedPhrases.add(p); });
    withDrafts.push({ ...opp, draftPost: text });
    process.stdout.write('.');
  }
  if (filtered.length) console.log();

  // 5. Reporter emails
  let reporterEmails = [];
  const contacts = loadContacts();
  if (contacts) {
    reporterEmails = await buildReporterEmails(questions, topics, contacts, anthropic);
    console.log(`[Outreach] ${reporterEmails.length} reporter email(s) drafted`);
  } else {
    console.warn('[Outreach] outreach-contacts.json not found — skipping reporter emails');
  }

  // Save pending emails so the "Send & Log" web flow can find them by token
  if (reporterEmails.length) {
    const pending = {};
    for (const re of reporterEmails) {
      pending[re.token] = {
        date:      quizData.date,
        reporter:  re.reporter,
        topic:     re.topic,
        storyUrl:  re.storyUrl,
        question:  re.question,
        draftEmail: re.draftEmail
      };
    }
    savePendingEmails(pending);

    // Spawn a standalone send server that stays alive for 8 hours to handle "Send & Log" clicks
    const child = spawn(process.execPath, [path.join(DIR, 'outreach-send-server.js')], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
    console.log(`[Outreach] Send server spawned — listening on port ${cfg.outreachPort || 3001} for 8 hours`);
  }

  // Save today's cache so --log-today can update the contact log after sending
  saveTodayCache({
    date: quizData.date,
    reporterEmails: reporterEmails.map(re => ({
      reporter: re.reporter,
      storyUrl: re.storyUrl,
      topic:    re.topic
    }))
  });

  // 6. Email digest (always send — confirms script ran)
  await sendDigest(quizData.date, topics, withDrafts, reporterEmails, cfg);

  // 7. Mark today as processed
  markRunDone();
  console.log('[Outreach] Done. Marked today as processed.');
}

if (process.argv.includes('--log-today')) {
  logTodayCommand().catch(e => { console.error('[Outreach] Fatal:', e.message); process.exit(1); });
} else {
  main().catch(e => { console.error('[Outreach] Fatal error:', e.message); process.exit(1); });
}
