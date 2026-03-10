'use strict';

const { Pool } = require('pg');

// ── Postgres connection ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Table initialisation ──────────────────────────────────────
// Single table: store(key TEXT PRIMARY KEY, value JSONB)
// Call once on startup before accepting traffic.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);
  console.log('DB: store table ready.');
}

// ── Primitive key/value helpers ───────────────────────────────
async function getKey(key) {
  try {
    const r = await pool.query('SELECT value FROM store WHERE key=$1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch (e) { console.error('getKey error', key, e.message); return null; }
}

async function setKey(key, value) {
  try {
    await pool.query(
      'INSERT INTO store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (e) { console.error('setKey error', key, e.message); return false; }
}

// ── Legacy bulk read/write shims ──────────────────────────────
// Kept so the rest of the codebase changes minimally.
// readData() / writeData() work the same as before; they just
// live here now instead of at the top of server.js.
const DATA_KEYS = [
  'sites', 'rssCache', 'scores', 'dist', 'quizzes', 'archiveUrls',
  'archiveQuestions', 'posts', 'messages', 'subscribers',
  'emailPaused', 'emailPausedSnapshot'
];

async function readData() {
  const data = {};
  await Promise.all(DATA_KEYS.map(async k => {
    const v = await getKey(k);
    if (v !== null) data[k] = v;
  }));
  return data;
}

async function writeData(data) {
  await Promise.all(DATA_KEYS.map(async k => {
    if (data[k] === null) await setKey(k, null);
    else if (data[k] !== undefined) await setKey(k, data[k]);
  }));
  return true;
}

module.exports = { pool, initDb, getKey, setKey, readData, writeData };
