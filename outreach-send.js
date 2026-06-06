'use strict';

const express    = require('express');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');

const router = express.Router();
const DIR    = __dirname;

const CONFIG_PATH         = path.join(DIR, 'outreach-config.json');
const PENDING_EMAILS_PATH = path.join(DIR, 'outreach-pending-emails.json');
const CONTACT_LOG_PATH    = path.join(DIR, 'outreach-contact-log.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return null; }
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

function saveContactLog(log) {
  fs.writeFileSync(CONTACT_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
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

// ── GET /reporter-email?token=XXX ─────────────────────────────
router.get('/reporter-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(page('Bad Request', '<p>Missing token.</p>'));

  const pending = loadPending();
  const entry   = pending[token];
  if (!entry) {
    return res.status(404).send(page('Link Expired', `
      <p>This send link has already been used or has expired.</p>
      <p style="color:#888;font-size:13px;">If you need to re-send, use the "Send without logging" mailto link in the digest email.</p>
    `));
  }

  const defaultSubject = "Your story in today's Daily Dispatch Quiz";
  res.send(page(`Email to ${entry.reporter.name}`, `
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
        <input type="text" name="subject" value="${esc(defaultSubject)}"
          style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border:1px solid #ccc;font-family:Georgia,serif;">
      </div>
      <div style="margin-bottom:18px;">
        <label style="display:block;font-family:monospace;font-size:10px;letter-spacing:1px;color:#888;margin-bottom:5px;">BODY</label>
        <textarea name="body" rows="11"
          style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;line-height:1.7;border:1px solid #ccc;font-family:Georgia,serif;resize:vertical;">${esc(entry.draftEmail)}</textarea>
      </div>
      <button type="submit"
        style="background:#1a3a6b;color:#fff;border:none;padding:10px 22px;font-family:monospace;font-size:12px;letter-spacing:1px;cursor:pointer;">
        ✉ Send &amp; Log ▸
      </button>
    </form>
  `));
});

// ── POST /reporter-email ──────────────────────────────────────
router.post('/reporter-email', express.urlencoded({ extended: false }), async (req, res) => {
  const { token, subject, body } = req.body;
  if (!token || !body) return res.status(400).send(page('Bad Request', '<p>Missing required fields.</p>'));

  const pending = loadPending();
  const entry   = pending[token];
  if (!entry) {
    return res.status(409).send(page('Already Sent', `
      <p>This email has already been sent and logged.</p>
    `));
  }

  const cfg = loadConfig();
  if (!cfg || !cfg.gmailUser || !cfg.gmailAppPassword) {
    return res.status(500).send(page('Configuration Error', '<p>Could not load Gmail credentials from outreach-config.json.</p>'));
  }

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
      subject: (subject || "Your story in today's Daily Dispatch Quiz").trim(),
      text:    body.trim()
    });
  } catch (e) {
    console.error('[OutreachSend] Send failed:', e.message);
    return res.status(500).send(page('Send Failed', `<p>Email could not be sent: ${esc(e.message)}</p>`));
  }

  // Log the contact
  try {
    const log = loadContactLog();
    let logEntry = log.find(c => c.email === entry.reporter.email);
    if (!logEntry) { logEntry = { email: entry.reporter.email, contacts: [] }; log.push(logEntry); }
    const alreadyLogged = logEntry.contacts.some(
      c => c.date === entry.date && c.storyUrl === entry.storyUrl
    );
    if (!alreadyLogged) {
      logEntry.contacts.push({ date: entry.date, storyUrl: entry.storyUrl, storyTopic: entry.topic.topic || '' });
      saveContactLog(log);
    }
  } catch (e) {
    console.warn('[OutreachSend] Contact log update failed:', e.message);
  }

  // Consume the token so the link can't be reused
  delete pending[token];
  try { savePending(pending); } catch (e) { /* non-fatal */ }

  res.send(page('Email Sent', `
    <p style="font-size:16px;">&#x2713; Sent to <strong>${esc(entry.reporter.name)}</strong> (${esc(entry.reporter.outlet)}).</p>
    <p style="color:#555;font-size:13px;">Contact logged to <code>outreach-contact-log.json</code>.</p>
    <p style="margin-top:24px;">
      <a href="javascript:window.close()" style="font-family:monospace;font-size:12px;color:#1a3a6b;text-decoration:none;">Close this tab</a>
    </p>
  `));
});

module.exports = router;
