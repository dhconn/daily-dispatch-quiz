# Task: Admin UI for Player Name Blocklist

## What to build

Add a "Blocked Names" subsection inside the existing **Player Management** collapsible section of the admin panel. It should let you:

- See all currently blocked names
- Type a new name and click Block
- Click Unblock next to any existing blocked name

The blocked names are enforced server-side. There is currently no way to manage them from the UI — you have to edit code.

---

## Current state (already done — do not redo)

**server.js lines 4–6:** Hardcoded constant at the very top of the file:
```js
const BLOCKED_PLAYER_NAMES = new Set(['david conn']);
```
This is checked in `POST /api/progress` (~line 675) and `POST /api/scores` (~line 808) — both return `{ error: '...', blocked: true }` with status 400 if the name matches.

**news-quiz.html ~line 4558:** Client-side check in `registerPlayer()`:
```js
const BLOCKED_NAMES = ['david conn'];
if (BLOCKED_NAMES.includes(name.toLowerCase())) { ... }
```

---

## What needs to change

### 1. Store the blocklist in the database (server.js)

Replace the hardcoded `Set` with a database-backed list using the existing `getKey`/`setKey` pattern. The key is `'blocklist'` and the value is an array of lowercase strings, e.g. `['david conn']`.

On startup, seed the DB key if it doesn't exist yet:
```js
// near the top of server.js, after the pool is set up — add to the existing startup/init block, or just inside the first admin API that uses it with a lazy-load pattern
```

Add a helper used by both enforcement points:
```js
async function isBlocked(name) {
  const list = await getKey('blocklist') || [];
  return list.includes(name.toLowerCase().trim());
}
```

Replace the two hardcoded `BLOCKED_PLAYER_NAMES.has(...)` checks with `await isBlocked(playerName)`. Remove the `const BLOCKED_PLAYER_NAMES = new Set(...)` line.

Seed on first use inside `isBlocked` (or a one-time init):
```js
async function isBlocked(name) {
  let list = await getKey('blocklist');
  if (!list) {
    list = ['david conn'];
    await setKey('blocklist', list);
  }
  return list.includes(name.toLowerCase().trim());
}
```

### 2. Add admin API endpoints (server.js)

Pattern: all admin routes check `req.headers['x-admin-token'] !== adminToken` and return 403 if it fails. Follow the same pattern.

**GET /api/admin/blocklist** — returns `{ blocklist: ['david conn', ...] }`

**POST /api/admin/blocklist** — body `{ name: 'string' }` — adds name (lowercased) if not already present, saves, returns updated list

**DELETE /api/admin/blocklist/:name** — removes name, saves, returns updated list

### 3. Add UI inside Player Management section (news-quiz.html)

The Player Management collapsible is at **~line 2973**:
```html
<div class="admin-collapsible" style="margin-top:20px;" id="anc-players">
  <details>
    <summary>
      <span class="summary-left">Player Management</span>
      ...
    </summary>
    <div class="collapsible-body">
      <div id="player-list" ...>  ← existing player list
      </div>
    </div>
  </details>
</div>
```

Add a "Blocked Names" subsection **after** the `#player-list` div, still inside `.collapsible-body`. Style it to match the existing admin panel aesthetic (monospace labels, `var(--muted)`, `var(--rule)` borders, `var(--ink)`/`var(--paper)` button colors).

Suggested markup (adapt styling to match surrounding elements):
```html
<div style="margin-top:20px;border-top:1px solid var(--rule);padding-top:16px;">
  <div style="font-family:monospace;font-size:11px;letter-spacing:1px;color:var(--muted);margin-bottom:8px;">BLOCKED NAMES</div>
  <div id="blocklist-items" style="margin-bottom:10px;font-family:monospace;font-size:13px;"></div>
  <div style="display:flex;gap:8px;align-items:center;">
    <input id="blocklist-input" type="text" placeholder="name to block"
      style="font-family:monospace;font-size:13px;padding:5px 8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);flex:1;">
    <button onclick="adminAddBlock()"
      style="font-family:monospace;font-size:11px;letter-spacing:1px;padding:6px 14px;background:var(--ink);color:var(--paper);border:none;cursor:pointer;">BLOCK</button>
  </div>
  <div id="blocklist-status" style="font-family:monospace;font-size:11px;color:var(--muted);margin-top:6px;"></div>
</div>
```

### 4. Add JS functions (news-quiz.html)

Add near the other admin functions (search for `async function adminLoad` or similar to find the right neighborhood):

```js
async function loadBlocklist() {
  const adminToken = lsGet('dnq_admin_token') || '';
  const res = await fetch('/api/admin/blocklist', { headers: { 'x-admin-token': adminToken } });
  const data = await res.json();
  const el = document.getElementById('blocklist-items');
  if (!el) return;
  if (!data.blocklist || data.blocklist.length === 0) {
    el.innerHTML = '<span style="color:var(--muted);">None</span>';
    return;
  }
  el.innerHTML = data.blocklist.map(name =>
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
      <span>${name}</span>
      <button onclick="adminUnblock('${name}')"
        style="font-family:monospace;font-size:10px;letter-spacing:1px;padding:2px 8px;background:none;border:1px solid var(--muted);color:var(--muted);cursor:pointer;">UNBLOCK</button>
    </div>`
  ).join('');
}

async function adminAddBlock() {
  const name = document.getElementById('blocklist-input').value.trim();
  const statusEl = document.getElementById('blocklist-status');
  if (!name) return;
  const adminToken = lsGet('dnq_admin_token') || '';
  const res = await fetch('/api/admin/blocklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('blocklist-input').value = '';
    statusEl.textContent = `"${name}" blocked.`;
    loadBlocklist();
  } else {
    statusEl.textContent = data.error || 'Error.';
  }
}

async function adminUnblock(name) {
  const adminToken = lsGet('dnq_admin_token') || '';
  const res = await fetch('/api/admin/blocklist/' + encodeURIComponent(name), {
    method: 'DELETE',
    headers: { 'x-admin-token': adminToken }
  });
  const data = await res.json();
  const statusEl = document.getElementById('blocklist-status');
  if (res.ok) {
    statusEl.textContent = `"${name}" unblocked.`;
    loadBlocklist();
  } else {
    statusEl.textContent = data.error || 'Error.';
  }
}
```

### 5. Call loadBlocklist() when the admin panel loads

Find where other admin data is loaded on panel open (search for `loadAdminData` or the function called when the admin panel first appears). Call `loadBlocklist()` there.

### 6. Remove the hardcoded client-side check in registerPlayer()

Around line 4558, remove these lines:
```js
const BLOCKED_NAMES = ['david conn'];
if (BLOCKED_NAMES.includes(name.toLowerCase())) {
  errEl.textContent = 'This player name is reserved. Please create a new name.';
  errEl.style.display = 'block';
  return;
}
```

The server already returns `{ error: '...', blocked: true }` — make sure the `registerPlayer()` error handling displays the server error message. Look for where the fetch to `/api/progress` handles errors and confirm it shows `data.error` in `errEl`.

---

## Key codebase facts

- **Database**: Postgres on Railway, accessed only via `getKey(key)` / `setKey(key, value)`. Single table `store(key TEXT PRIMARY KEY, value JSONB)`. Values can be arrays, objects, strings, numbers.
- **Admin token**: `process.env.ADMIN_TOKEN || 'admin'`. Client sends it as `x-admin-token` header. Client retrieves it via `lsGet('dnq_admin_token')`.
- **Admin panel**: Lives inside `news-quiz.html` in a collapsible section structure. Admin sections use `.admin-collapsible` > `<details>` > `.collapsible-body`.
- **CSS variables**: `var(--ink)`, `var(--paper)`, `var(--muted)`, `var(--cream)`, `var(--rule)` — use these for all new UI elements.
- **`lsGet`**: Helper for `localStorage.getItem`.

---

## Commit message when done

```
Add admin UI to manage blocked player names

Blocklist moved from hardcoded constant to database key 'blocklist'.
New admin endpoints GET/POST/DELETE /api/admin/blocklist. Player
Management section now shows blocked names with unblock buttons and
an add-name input.
```
