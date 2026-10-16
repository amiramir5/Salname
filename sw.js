/*
 * Salname service worker — makes the app fully usable with no internet.
 *
 * Strategy
 *   • Navigation (the HTML document) → NETWORK FIRST. When the device is online you
 *     always get the newest build, so a stale cache can never masquerade as a bug.
 *     The cached copy is only used when the network is unavailable.
 *   • Same-origin assets (CSS / JS / fonts / icons) → CACHE FIRST. They are only
 *     read from the cache, so start-up stays instant and works offline.
 *   • Cross-origin (e.g. the Wikipedia reference pictures in the mind-map) → network
 *     first, and remember what we saw so already-viewed pictures still show offline.
 *
 * IMPORTANT: because assets are cache-first, ALWAYS bump CACHE_VERSION below whenever
 * you change anything under assets/. Changing index.html alone needs no bump.
 */
const CACHE_VERSION = 'v2';
const CACHE = `salname-${CACHE_VERSION}`;
const RUNTIME = `salname-runtime-${CACHE_VERSION}`;

const PRECACHE = [
    './',
    'index.html',
    'manifest.webmanifest',
    'assets/tailwind.css',
    'assets/fonts/vazirmatn/vazirmatn.css',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Black.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Bold.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-ExtraBold.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-ExtraLight.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Light.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Medium.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Regular.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-SemiBold.woff2',
    'assets/fonts/vazirmatn/fonts/webfonts/Vazirmatn-Thin.woff2',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'assets/icons/icon-maskable-512.png',
    'assets/icons/icon.svg',
    'assets/katex/katex.min.css',
    'assets/katex/katex.min.js',
    'assets/katex/fonts/KaTeX_AMS-Regular.woff2',
    'assets/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
    'assets/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
    'assets/katex/fonts/KaTeX_Fraktur-Bold.woff2',
    'assets/katex/fonts/KaTeX_Fraktur-Regular.woff2',
    'assets/katex/fonts/KaTeX_Main-Bold.woff2',
    'assets/katex/fonts/KaTeX_Main-BoldItalic.woff2',
    'assets/katex/fonts/KaTeX_Main-Italic.woff2',
    'assets/katex/fonts/KaTeX_Main-Regular.woff2',
    'assets/katex/fonts/KaTeX_Math-BoldItalic.woff2',
    'assets/katex/fonts/KaTeX_Math-Italic.woff2',
    'assets/katex/fonts/KaTeX_SansSerif-Bold.woff2',
    'assets/katex/fonts/KaTeX_SansSerif-Italic.woff2',
    'assets/katex/fonts/KaTeX_SansSerif-Regular.woff2',
    'assets/katex/fonts/KaTeX_Script-Regular.woff2',
    'assets/katex/fonts/KaTeX_Size1-Regular.woff2',
    'assets/katex/fonts/KaTeX_Size2-Regular.woff2',
    'assets/katex/fonts/KaTeX_Size3-Regular.woff2',
    'assets/katex/fonts/KaTeX_Size4-Regular.woff2',
    'assets/katex/fonts/KaTeX_Typewriter-Regular.woff2',
    'assets/pdfjs/pdf.min.js',
    'assets/pdfjs/pdf.worker.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // Add one by one: a single missing file must not abort the whole install.
        await Promise.all(PRECACHE.map(async (url) => {
            try {
                await cache.add(new Request(url, { cache: 'reload' }));
            } catch (_) {
                /* offline during install, or file absent — the others still cache */
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // 1) The document itself — network first so online devices always run the newest build.
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const offlineCopy = async () =>
                (await cache.match('index.html', { ignoreSearch: true }))
                || (await cache.match('./', { ignoreSearch: true }));

            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok) {
                    await cache.put('index.html', fresh.clone());
                    return fresh;
                }
                // A dead proxy or captive portal answers with an error page instead of
                // failing outright. Never show that — keep serving the cached app.
                return (await offlineCopy()) || fresh;
            } catch (_) {
                return (await offlineCopy()) || Response.error();
            }
        })());
        return;
    }

    // 2) Our own static assets — cache first.
    if (url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const hit = await cache.match(req, { ignoreSearch: true });
            if (hit) return hit;
            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok) cache.put(req, fresh.clone());
                return fresh;
            } catch (_) {
                return Response.error();
            }
        })());
        return;
    }

    // 3) Third-party pictures — network first, but remember them for offline use.
    event.respondWith((async () => {
        const cache = await caches.open(RUNTIME);
        try {
            const fresh = await fetch(req);
            if (fresh && (fresh.ok || fresh.type === 'opaque')) {
                await cache.put(req, fresh.clone());
                return fresh;
            }
            return (await cache.match(req)) || fresh;
        } catch (_) {
            return (await cache.match(req)) || Response.error();
        }
    })());
});
