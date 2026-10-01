/**
 * Service worker: makes a cold launch work without a network.
 *
 * The app shell is a single self-contained index.html (React and CSS are
 * inlined), so there is very little to cache: the HTML, the manifest, the two
 * icons, and whatever Google Fonts serves.
 *
 * Strategies:
 *  - the HTML is network-first with a short timeout, so a pushed update is
 *    picked up as soon as there is signal, and a dead/slow connection falls
 *    back to the cached copy instead of hanging;
 *  - everything else is cache-first with a background refresh, because those
 *    files only change when the build id changes.
 *
 * Every URL is relative: GitHub Pages serves this from /<repo>/, not /.
 * BUILD_ID is substituted by build.mjs, so each build gets its own cache and
 * the previous one is deleted on activate.
 */
const VERSION = '__BUILD_ID__';
const CACHE = 'gpc-' + VERSION;
const HTML_KEY = './index.html';
const HTML_TIMEOUT_MS = 3000;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-512.png', './apple-touch-icon-180.png'];

const isFontHost = (h) => h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com';

/** Cache.put tolerates opaque (cross-origin, status 0) responses; Response.ok does not. */
const storable = (res) => Boolean(res) && (res.ok || res.type === 'opaque');

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Network-first. Keeps the cached shell current, and serves it when offline. */
async function htmlFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetchWithTimeout(request, HTML_TIMEOUT_MS);
    if (fresh && fresh.ok) await cache.put(HTML_KEY, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = (await cache.match(HTML_KEY)) || (await cache.match('./'));
    if (cached) return cached;
    throw e;
  }
}

/** Cache-first, refreshed in the background so the next launch is current. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) {
    fetch(request)
      .then((res) => {
        if (storable(res)) cache.put(request, res.clone());
      })
      .catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (storable(res)) await cache.put(request, res.clone());
  return res;
}

self.addEventListener('install', (event) => {
  // Individual addAll failures must not abort the install, so add one by one.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(htmlFirst(request));
    return;
  }
  if (url.origin === self.location.origin || isFontHost(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
});

/** Lets the page ask the worker to hand over immediately after an update. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
