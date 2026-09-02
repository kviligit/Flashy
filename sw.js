/**
 * Service worker: makes Flashy work with no network at all.
 *
 * The collection already lives in IndexedDB, so offline support is only a
 * question of having the app's own files.
 *
 * Strategy: network first, falling back to the cache, for everything
 * same-origin.
 *
 * The obvious alternative — cache first with a background revalidate — is
 * faster but wrong here. The app is a graph of ES modules that import each
 * other, so after a deploy it would happily serve a cached entry module
 * alongside freshly fetched dependencies and run a half-old, half-new
 * build. Consistency beats a few milliseconds. Offline still works
 * identically, because that is exactly when the fallback fires.
 *
 * Bump CACHE_VERSION to evict everything on the next activation.
 */

const CACHE_VERSION = 'flashy-v4';

/**
 * What this worker is willing to cache.
 *
 * A service worker is an amplifier: anything that can run script on this
 * origin can write into the cache, and what it writes is then served back
 * after reloads, after the offending deck is deleted, and — on an
 * installed app with no address bar — with no obvious way to clear it.
 *
 * Narrowing the cache to the app's own files does not stop a page-context
 * attacker from calling `caches.open()` itself; nothing a worker does can.
 * What it does stop is *this* worker turning an arbitrary same-origin URL
 * into a cached response on the attacker's behalf, and it means anything
 * in the cache that is not one of these files is not something the app
 * put there.
 *
 * Recovery, which matters more than either: the settings screen has a
 * button that unregisters this worker and deletes every cache.
 */
function isCacheable(url) {
  const path = url.pathname;
  if (url.search) return false;
  if (path.endsWith('/')) return true;
  if (path.endsWith('/index.html')) return true;
  if (path.endsWith('/manifest.webmanifest')) return true;
  if (/\/dist\/[\w./-]+\.js$/.test(path)) return true;
  if (/\/src\/[\w./-]+\.css$/.test(path)) return true;
  if (/\/icon[\w-]*\.(svg|png)$/.test(path)) return true;
  return false;
}

const SHELL = [
  './',
  './index.html',
  './src/ui/theme.css',
  './dist/app/main.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // A missing file must not abort the whole install, so each is added
      // on its own and failures are tolerated.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const fallback = request.mode === 'navigate' ? './index.html' : request;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          response.type === 'basic' &&
          isCacheable(url)
        ) {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(fallback).then((cached) => cached ?? Response.error()),
      ),
  );
});

/**
 * Let the page tell this worker to stand down.
 *
 * Used by the "Reset the offline copy" button. The page can delete the
 * caches and unregister the worker by itself, but a worker already
 * controlling the page keeps serving until it is gone; taking the caches
 * down from in here removes any chance of one last cached response
 * between the two steps.
 */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'flashy-reset') return;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister()),
  );
});
