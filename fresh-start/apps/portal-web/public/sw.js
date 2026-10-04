/*
 * JobWork portal service worker (F-11.6; doc 21 §8; DS-14; BR-AUTH-05; ADR-0005).
 *
 * What it keeps, and only this:
 *   - the offline page, fetched without credentials so it is nobody's page;
 *   - content-hashed build assets under /_next/static/ (code and styles, the same for
 *     every visitor).
 * What it never keeps: any /api/ response, any page a person navigated to, anything
 * that is not a GET. A customer's quotation or a supplier's purchase order cannot be
 * read back from this device's caches, because it was never written to them.
 *
 * Navigation goes to the network first; only when the network is unreachable does the
 * offline page answer. Commands are never queued for later (no background sync): the
 * page refuses them while offline and says nothing was sent.
 */

const VERSION = 'v1';
const SHELL_CACHE = `jobwork-shell-${VERSION}`;
const ASSET_CACHE = `jobwork-assets-${VERSION}`;
const OFFLINE_PATH = '/offline';
const MAX_ASSETS = 300;

function offlineRequest() {
  return new Request(new URL(OFFLINE_PATH, self.location.origin).href, { credentials: 'omit', cache: 'reload' });
}

async function seedShell() {
  const cache = await caches.open(SHELL_CACHE);
  await cache.add(offlineRequest());
}

self.addEventListener('install', (event) => {
  event.waitUntil(seedShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Sign-out and a 401 purge every cache from the page; this re-seeds the offline page.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'purge') {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(seedShell),
    );
  }
});

async function cachedAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    // Every deploy adds new hashed files; the oldest are dropped rather than kept forever.
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(stale);
  }
  return response;
}

async function navigate(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(new URL(OFFLINE_PATH, self.location.origin).href);
    return offline || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) event.respondWith(cachedAsset(request));
});
