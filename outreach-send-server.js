'use strict';
// Standalone HTTP server spawned by outreach.js after the digest is sent.
// Handles "Send & Log" clicks from the digest email for up to 8 hours,
// then exits automatically (or earlier once all pending tokens are consumed).

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const qs         = require('querystring');
const nodemailer = require('nodemailer');

const DIR                 = __dirname;
const CONFIG_PATH         = path.join(DIR, 'outreach-config.json');
const PENDING_EMAILS_PATH = path.join(DIR, 'outreach-pending-emails.json');
const CONTACT_LOG_PATH    = path.join(DIR, 'outreach-contact-log.json');
const LOG_PATH            = path.join(DIR, 'outreach-send-server.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_PATH, line); } catch (e) {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { log('Cannot load config: ' + e.message); process.exit(1); }
}

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_EMAILS_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function savePending(pending) {
  fs.writeFileSync(PENDING_EMAILS_PATH, JSON.stringify(pending, null, 2), 'utf8');
}

function loadContactLog() {
  try { return JSON.parse(fs.readFileSync(CONTACT_LOG_PATH, 'utf8')); }
  catch (e) { return []; }
}

function saveContactLog(contactLog) {
  fs.writeFileSync(CONTACT_LOG_PATH, JSON.stringify(contactLog, null, 2), 'utf8');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, body) {
  return `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${esc(title)} — DDQ Outreach</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="font-family:Georgia,serif;max-width:620px;margin:40px auto;padding:0 20px;color:#1a1008;">
    <div style="border-bottom:2px solid #1a3a6b;padding-bottom:8px;margin-bottom:24px;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#1a3a6b;">DAILY DISPATCH QUIZ</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px;">${esc(title)}</div>
    </div>
    ${body}
  </body></html>`;
}

function send(res, status, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

// ── GET /reporter-email?token=XXX ─────────────────────────────
function handleGet(res, token) {
  if (!token) return send(res, 400, page('Bad Request', '<p>Missing token.</p>'));

  const pending = loadPending();
  const entry   = pending[token];
  if (!entry) {
    return send(res, 404, page('Link Expired', `
      <p>This send link has already been used or has expired.</p>
      <p style="color:#888;font-size:13px;">Use the "Send without logging" mailto link in the digest email to re-send.</p>
    `));
  }

  send(res, 200, page(`Email to ${entry.reporter.name}`, `
    <div style="margin-bottom:16px;">
      <div style="font-family:monospace;font-size:10px;color:#888;margin-bottom:3px;">TO</div>
      <div style="font-size:15px;font-weight:bold;">${esc(entry.reporter.name)}</div>
      <div style="font-size:13px;color:#555;">${esc(entry.reporter.outlet)} &bull; ${esc(entry.reporter.beat)} &bull; ${esc(entry.reporter.email)}</div>
    </div>
    <div style="margin-bottom:16px;font-family:monospace;font-size:11px;color:#888;">
      STORY: ${esc(entry.topic.topic || entry.storyUrl)}
    </div>
    <form method="POST" action="/reporter-email">
      <input type="hidden" name="token" value="${esc(token)}">
      <div style="margin-bottom:12px;">
        <label style="display:block;font-family:monospace;font-size:10px;letter-spacing:1px;color:#888;margin-bottom:5px;">SUBJECT</label>
        <input type="text" name="subject" value="${esc("Your story in today's Daily Dispatch Quiz")}"
          style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border:1px solid #ccc;font-family:Georgia,serif;">
      </div>
      <div style="margin-bottom:18px;">
        <label style="display:block;font-family:monospace;font-size:10px;letter-spacing:1px;color:#888;margin-bottom:5px;">BODY</label>
        <textarea name="body" rows="11"
          style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;line-height:1.7;border:1px solid #ccc;font-family:Georgia,serif;resize:vertical;">${esc(entry.draftEmail)}</textarea>
      </div>
      <button type="submit"
        style="background:#1a3a6b;color:#fff;border:none;padding:10px 22px;font-family:monospace;font-size:12px;letter-spacing:1px;cursor:pointer;">
        &#x2709; Send &amp; Log &#x25B8;
      </button>
    </form>
  `));
}

// ── POST /reporter-email ──────────────────────────────────────
async function handlePost(res, rawBody, server) {
  const params    = qs.parse(rawBody);
  const token     = params.token;
  const subject   = (params.subject || "Your story in today's Daily Dispatch Quiz").trim();
  const emailBody = (params.body || '').trim();

  if (!token || !emailBody) return send(res, 400, page('Bad Request', '<p>Missing required fields.</p>'));

  const pending = loadPending();
  const entry   = pending[token];
  if (!entry) return send(res, 409, page('Already Sent', '<p>This email has already been sent and logged.</p>'));

  const cfg = loadConfig();

  // Send the email
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword }
    });
    await transporter.sendMail({
      from:    cfg.gmailUser,
      to:      entry.reporter.email,
      replyTo: cfg.gmailUser,
      bcc:     cfg.gmailUser,
      subject,
      text:    emailBody
    });
    log(`Sent to ${entry.reporter.email} (${entry.reporter.name})`);
  } catch (e) {
    log('Send failed: ' + e.message);
    return send(res, 500, page('Send Failed', `<p>Email could not be sent: ${esc(e.message)}</p>`));
  }

  // Log the contact
  try {
    const contactLog = loadContactLog();
    let entry2 = contactLog.find(c => c.email === entry.reporter.email);
    if (!entry2) { entry2 = { email: entry.reporter.email, contacts: [] }; contactLog.push(entry2); }
    if (!entry2.contacts.some(c => c.date === entry.date && c.storyUrl === entry.storyUrl)) {
      entry2.contacts.push({ date: entry.date, storyUrl: entry.storyUrl, storyTopic: entry.topic.topic || '' });
      saveContactLog(contactLog);
      log(`Logged contact for ${entry.reporter.email}`);
    }
  } catch (e) {
    log('Contact log failed: ' + e.message);
  }

  // Consume the token
  delete pending[token];
  try { savePending(pending); } catch (e) {}

  send(res, 200, page('Email Sent', `
    <p style="font-size:16px;">&#x2713; Sent to <strong>${esc(entry.reporter.name)}</strong> (${esc(entry.reporter.outlet)}).</p>
    <p style="color:#555;font-size:13px;">Contact logged to <code>outreach-contact-log.json</code>.</p>
    <p style="margin-top:24px;">
      <a href="javascript:window.close()" style="font-family:monospace;font-size:12px;color:#1a3a6b;text-decoration:none;">Close this tab</a>
    </p>
  `));

  // Shut down if no tokens remain
  const remaining = Object.keys(loadPending()).length;
  if (remaining === 0) {
    log('All tokens consumed — shutting down.');
    setTimeout(() => { server.close(); process.exit(0); }, 800);
  }
}

// ── Start ─────────────────────────────────────────────────────
const cfg  = loadConfig();
const PORT = cfg.outreachPort || 3001;

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && urlObj.pathname === '/reporter-email') {
    handleGet(res, urlObj.searchParams.get('token') || '');

  } else if (req.method === 'POST' && urlObj.pathname === '/reporter-email') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => handlePost(res, body, server));

  } else {
    send(res, 404, page('Not Found', '<p>Page not found.</p>'));
  }
});

// Auto-shutdown after 8 hours
const shutdownTimer = setTimeout(() => {
  log('8-hour timeout — shutting down.');
  server.close();
  process.exit(0);
}, 8 * 60 * 60 * 1000);
shutdownTimer.unref();

server.listen(PORT, '127.0.0.1', () => {
  log(`Ready at http://localhost:${PORT}/reporter-email`);
});

server.on('error', e => {
  log('Server error: ' + e.message);
  process.exit(1);
});
