/**
 * Rainy Service Worker â€” PWA support with offline shell caching
 */
const CACHE_NAME = 'rainy-v44';
const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/player.js',
  '/css/base.css',
  '/css/components/buttons.css',
  '/css/components/cards.css',
  '/css/components/connect.css',
  '/css/components/context-menu.css',
  '/css/components/forms.css',
  '/css/components/friends.css',
  '/css/components/fullscreen.css',
  '/css/components/header.css',
  '/css/components/modals.css',
  '/css/components/new-features.css',
  '/css/components/player-bar.css',
  '/css/components/settings-page.css',
  '/css/components/sidebar.css',
  '/css/components/toast.css',
  '/css/components/ui-consistency.css',
  '/css/pages/artists.css',
  '/css/pages/discover.css',
  '/css/pages/library.css',
  '/css/pages/login.css',
  '/css/pages/mixes.css',
  '/css/pages/setup.css',
  '/css/variables.css',
  '/js/components/addMusicModal.js',
  '/js/components/connectModal.js',
  '/js/components/contextMenu.js',
  '/js/components/icon.js',
  '/js/components/index.js',
  '/js/components/lyricsModal.js',
  '/js/components/metadataModal.js',
  '/js/components/modal.js',
  '/js/components/newPlaylistModal.js',
  '/js/components/songContextMenu.js',
  '/js/components/songSettingsModal.js',
  '/js/data/playlist-icons.js',
  '/js/helper/context.js',
  '/js/helper/logger.js',
  '/js/helper/request.js',
  '/js/helper/result.js',
  '/js/helper/router.js',
  '/js/i18n/index.js',
  '/js/i18n/locales/ca.js',
  '/js/i18n/locales/en.js',
  '/js/i18n/locales/es.js',
  '/js/i18n/locales/pl.js',
  '/js/audioGraph.js',
  '/js/lightshow/clock.js',
  '/js/lightshow/engine.js',
  '/js/lightshow/fixtures.js',
  '/js/lightshow/lyrics.js',
  '/js/lightshow/palette.js',
  '/js/lightshow/scenes.js',
  '/js/lightshow/score.js',
  '/js/lightshow/sources.js',
  '/js/main.js',
  '/js/modules/bpmShuffle.js',
  '/js/modules/friends.js',
  '/js/modules/globalSearch.js',
  '/js/modules/keyboardShortcuts.js',
  '/js/modules/library.js',
  '/js/modules/mediaSession.js',
  '/js/modules/mixes.js',
  '/js/modules/newViews.js',
  '/js/modules/playlists.js',
  '/js/modules/shortcutOverlay.js',
  '/js/modules/sleepTimer.js',
  '/js/modules/utils.js',
  '/js/services/album.js',
  '/js/services/auth.js',
  '/js/services/base.js',
  '/js/services/cast.js',
  '/js/services/connect.js',
  '/js/services/enrichment.js',
  '/js/services/friends.js',
  '/js/services/importJobs.js',
  '/js/services/index.js',
  '/js/services/lightshow.js',
  '/js/services/listenTracker.js',
  '/js/services/lyrics.js',
  '/js/services/metadata.js',
  '/js/services/music.js',
  '/js/services/playback.js',
  '/js/services/playlist.js',
  '/js/services/rating.js',
  '/js/services/scan.js',
  '/js/services/server.js',
  '/js/services/setup.js',
  '/js/services/users.js',
  '/js/setup.js',
  '/js/view/app.js',
  '/js/view/login.js',
  '/js/view/setup.js',
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

// Fetch: API never cached; CODE assets (js/css) are NETWORK-FIRST so a
// deployed fix is live on the next reload (cache is only an offline
// fallback); images/icons keep cache-first with network fallback.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or streams
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Code assets: network-first â€” the server is on the user's LAN, so a
  // stale cache must never outlive a deploy. The last-good copy is kept
  // as an offline fallback.
  if (url.pathname.match(/\.(js|css)$/)) {
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
    return;
  }

  // Other static assets (images, icons, fonts, manifests): cache-first.
  if (url.pathname.match(/\.(png|jpg|svg|woff2?|json)$/)) {
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
