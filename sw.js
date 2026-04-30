const CACHE_NAME = 'ddq-static-v1';
const STATIC_ASSETS = [
  '/',
  '/news-quiz.html',
  '/manifest.webmanifest',
  '/images/icon-192.png',
  '/images/icon-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }))
    )
  );
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache live app data — quizzes, scores, progress, admin, RSS, email
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // For page navigation: network first, fall back to cached shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/news-quiz.html'))
    );
    return;
  }
  // For static assets: cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Push: display notification when server sends one ─────────
self.addEventListener('push', event => {
  let data = {
    title: 'Daily Dispatch Quiz',
    body: "Today's quiz is live — can you ace it?",
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png',
    url: '/'
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (e) {
      data.body = event.data.text() || data.body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      data: { url: data.url },
      tag: 'ddq-quiz-ready',   // collapses duplicate notifications
      renotify: true,
      vibrate: [200, 100, 200]
    })
  );
});

// ── Notification click: open or focus the app ────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open somewhere, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
