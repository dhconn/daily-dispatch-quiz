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
