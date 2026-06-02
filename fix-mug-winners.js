const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:TestPassword123@:/railway' });

pool.query('SELECT value FROM store WHERE key = $1', ['subscribers']).then(r => {
  const subs = JSON.parse(r.rows[0].value);
  const affected = Object.entries(subs)
    .filter(([k, v]) => v.mugWonReason === 'monthly_2026-05')
    .map(([k]) => k);
  console.log('Affected:', affected);
  pool.end();
});