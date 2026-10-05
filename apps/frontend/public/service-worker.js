/**
 * The service worker: an installable shell that reviews from cache.
 *
 * The app shell (HTML, JS, CSS) is cached on install and served
 * cache-first, so the review screen opens with no network. The API is never
 * cached: queue fetches and grades go to the network, and the prefetched
 * queue in IndexedDB — not this worker — is what makes grading instant
 * offline (ADR 0001). Navigation requests fall back to the cached shell, so a
 * reload offline still opens the app.
 *
 * Plain JavaScript on purpose: the workspace formatter checks `.ts` sources,
 * and this file ships verbatim from `public/`. Bump `CACHE` when the shell
 * changes.
 */

const CACHE = 'nook-shell-v1'

const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // The API and Media stay network-only: caching a grade or a queue would
  // serve a stale collection as if it were due.
  if (url.pathname.startsWith('/api/')) return

  // Navigations open the cached shell; the client router picks the screen.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html').then((hit) => hit || fetch(event.request)),
      ),
    )
    return
  }

  // The shell serves cache-first and refreshes in the background.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      return hit || network
    }),
  )
})
