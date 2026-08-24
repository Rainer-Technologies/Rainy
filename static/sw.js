/**
 * Rainy Service Worker — PWA support with offline shell caching
 */
const CACHE_NAME = 'rainy-v8';
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/player.js',
  '/js/components/index.js',
  '/js/helper/context.js',
  '/js/helper/request.js',
  '/js/helper/result.js',
  '/js/helper/router.js',
  '/js/helper/logger.js',
  '/js/services/index.js',
  '/js/services/auth.js',
  '/js/services/music.js',
  '/js/services/playlist.js',
  '/js/services/rating.js',
  '/js/services/playback.js',
  '/js/services/album.js',
  '/js/services/friends.js',
  '/js/modules/utils.js',
  '/js/modules/bpmShuffle.js',
  '/js/modules/keyboardShortcuts.js',
  '/js/modules/sleepTimer.js',
  '/js/modules/globalSearch.js',
  '/js/modules/mediaSession.js',
  '/js/modules/friends.js'
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch(() => {
        // Non-critical: some assets may not exist yet
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or streams
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Cache-first for static assets
  if (url.pathname.match(/\.(js|css|png|jpg|svg|woff2?|json)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // Network-first for HTML pages
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/')))
  );
});
