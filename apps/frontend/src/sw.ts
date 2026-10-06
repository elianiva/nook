/**
 * The service worker: an installable shell that reviews from cache.
 *
 * Built by `vite-plugin-pwa` in `injectManifest` mode: the plugin precaches
 * the build output (the manifest Workbox injects) instead of a hand-written
 * shell list, so no file here names a hashed asset and no version is bumped
 * by hand. The app's own routes and Media behaviour stay in this file.
 *
 * - The shell precache answers offline first; an update waits for the next
 *   load rather than interrupting a review session mid-grade.
 * - `/api/media/*` is cache-first with a long max age: card images and audio
 *   change only when the media row changes, and the prefetched queue's HTML
 *   already names the URLs a session needs.
 * - Other `/api/*` JSON stays network-only: caching a grade or a queue would
 *   serve a stale collection as if it were due. The prefetched queue in
 *   IndexedDB — not this worker — is what makes grading instant offline
 *   (ADR 0001).
 * - Navigations fall back to the cached shell, so a reload offline still
 *   opens the app and the client router picks the screen.
 */

/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

cleanupOutdatedCaches()

// The build's precache manifest lands here. `self.__WB_MANIFEST` is the
// injection point `vite-plugin-pwa` fills; there is no fallback list because
// a fallback would serve a stale shell after a deploy.
precacheAndRoute(self.__WB_MANIFEST)

// Card images and audio, cache-first: the queue HTML names the URLs, and a
// media row rarely changes. Thirty days keeps a studied deck's images on the
// device; a few hundred entries cap the storage a large collection can claim.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/media/'),
  new CacheFirst({
    cacheName: 'nook-media',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      }),
    ],
  }),
)

// Navigations open the cached shell; the client router picks the screen. The
// precached `index.html` is the fallback, so a reload offline still boots.
const navigationRoute = new NavigationRoute(async ({ request }) => {
  try {
    return await fetch(request)
  } catch {
    const cached = await caches.match('/index.html', { ignoreSearch: true })
    if (cached !== undefined) return cached
    throw new Error('The app shell is not cached yet. Load once online first.')
  }
})
registerRoute(navigationRoute)

void self.skipWaiting()
self.addEventListener('activate', () => self.clients.claim())
