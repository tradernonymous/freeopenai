/**
 * NeuraOS Service Worker
 * Caches app shell for offline access
 */

// v2: was cache-first for the app shell with a CACHE_NAME that never changed
// between deploys, so a browser that had ever loaded the app kept serving the
// index.html/app.js bytes from its very first visit -- forever, since the
// cache key never invalidated and the network was never even asked. Every
// push to main after that first visit was invisible until a user manually
// cleared site data. Network-first fixes it: try the network (the normal,
// online case, so the shell is always current), fall back to cache only when
// the network genuinely fails -- offline access is kept without a stale-cache
// trap. Bumping CACHE_NAME also forces one cleanup sweep of the old,
// permanently-stale cache via the activate handler below.
const CACHE_NAME = 'neuraos-v2';
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/phase1-zen.css',
    '/app.js',
    '/chatlib.js',
    '/hub.js',
    '/hub.css',
    '/manifest.json'
];

// Install: cache app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch: network-first for the app shell, network-only for the API. Cache is
// the offline fallback, not the primary source -- a deploy has to actually
// reach an already-visited browser.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API requests: network only
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME)
                        .then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
