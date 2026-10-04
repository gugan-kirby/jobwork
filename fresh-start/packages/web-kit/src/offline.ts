/**
 * The installable portal's offline side (F-11.6; doc 21 §8; `DS-14`; `BR-AUTH-05`).
 *
 * The service worker (`apps/portal-web/public/sw.js`) caches the offline page and
 * content-hashed build assets — nothing a person's session produced. Purging is still
 * done on sign-out and on a 401, so a shared phone keeps nothing of the last person even
 * if a later version caches more.
 */

/** Empties every cache this origin holds and asks the service worker to re-seed only its offline page. */
export async function purgeOfflineCaches(): Promise<void> {
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  if (typeof navigator !== 'undefined') navigator.serviceWorker?.controller?.postMessage({ type: 'purge' });
}

/** Registers the service worker; a browser without one simply has no offline page. */
export function registerServiceWorker(path = '/sw.js'): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(path, { scope: '/' }).catch(() => undefined);
}
