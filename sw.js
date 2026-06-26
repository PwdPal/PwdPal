// PwdPal Service Worker — Offline support
//
// Strategy:
//   - HTML / navigation requests: network-first, cache fallback when offline
//     (ensures online users always see the latest deployed version)
//   - Versioned assets (CSS / JS / manifest): cache-first
//     (the ?v= query string changes per release, so cached entries are safe to keep)
//   - CACHE_NAME is tied to VERSION below, so a version bump automatically
//     purges the previous cache in the activate handler.
//
// IMPORTANT: bump VERSION below whenever you bump the version in index.html / app.js.

const VERSION = '1.5.16';
const CACHE_NAME = `pwdpal-${VERSION}`;
const ASSETS = [
    '/',
    '/index.html',
    '/error.html',
    '/how-it-works.html',
    `/css/style.css?v=${VERSION}`,
    `/js/crypto.js?v=${VERSION}`,
    `/js/pattern.js?v=${VERSION}`,
    `/js/app.js?v=${VERSION}`,
    `/manifest.json?v=${VERSION}`,
    `/icons/apple-touch-icon.png?v=${VERSION}`
];

// Install: pre-cache all assets keyed by the current version
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

// Activate: delete any cache that isn't the current version
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch:
//   - HTML / navigation: network-first, cache fallback
//   - Everything else: cache-first
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const isHTML =
        event.request.mode === 'navigate' ||
        url.pathname.endsWith('.html') ||
        url.pathname === '/';

    if (isHTML) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
    }
});
