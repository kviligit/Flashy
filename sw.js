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

const CACHE_VERSION = 'flashy-v2';

const SHELL = [
  './',
  './index.html',
  './src/ui/theme.css',
  './dist/app/main.js',
  './manifest.webmanifest',
  './icon.svg',
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
        if (response && response.status === 200 && response.type === 'basic') {
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
