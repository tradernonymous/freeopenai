/**
 * NeuraOS Service Worker
 * Caches app shell for offline access
 */

const CACHE_NAME = 'neuraos-v1';
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

// Fetch: cache-first for app shell, network-first for API
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // API requests: network only
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }
    
    // Static assets: cache first
    event.respondWith(
        caches.match(event.request)
            .then(cached => cached || fetch(event.request)
                .then(response => {
                    // Cache new static assets
                    if (response.ok && event.request.method === 'GET') {
                        const clone = response.clone();
                        caches.open(CACHE_NAME)
                            .then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
            )
    );
});
