import './styles.css'
// Rubik ships with the bundle (Fontsource), so the boot font survives an
// offline load. Latin subsets only: the CDN link they replace served every
// subset, most of which no deck names.
import '@fontsource/rubik/latin-400.css'
import '@fontsource/rubik/latin-500.css'
import '@fontsource/rubik/latin-600.css'
import '@fontsource/rubik/latin-700.css'
import '@fontsource/rubik/latin-800.css'
import { Navigation, Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'
import { Message } from './app/model'
import { Model } from './app/model'
import { subscriptions } from './app/subscriptions'
import { init, update } from './app/update'
import { view } from './app/view'
import { readTheme } from './lib/theme'

// The stored Mochi theme lands before the first render, so a reload never
// flashes the default tint. A plain read is enough: the choice is
// localStorage only, and `data-theme` falls back to the default CSS values
// when nothing is stored.
document.documentElement.dataset['theme'] = readTheme()

const program = Runtime.makeApplication({
  Model,
  init: (url: Url) => init(url),
  update,
  view,
  subscriptions,
  routing: {
    onUrlRequest: (request: Navigation.UrlRequest): Message => Message.ClickedLink({ request }),
    onUrlChange: (url: Url): Message => Message.ChangedUrl({ url }),
  },
  container: document.getElementById('root'),
})

Runtime.run(program)

// The shell serves from cache (see `src/sw.ts`): register it once the page
// has loaded, and let an update wait for the next load rather than
// interrupting a review session mid-grade. `ServiceWorkerAvailable` only
// marks the update as ready; the shell renders the reload affordance, and the
// learner picks when to take it — never during review.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        const signalUpdate = (): void => {
          window.dispatchEvent(new CustomEvent('nook:sw-update'))
        }
        // An update that landed while the page was open.
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing
          if (worker === null) return
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller !== null) {
              signalUpdate()
            }
          })
        })
        // An update that was already waiting when the page loaded.
        void registration.update().catch(() => {})
      })
      .catch(() => {})
  })
}
