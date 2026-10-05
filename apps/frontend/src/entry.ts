import './styles.css'
import { Navigation, Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'
import { Message } from './app/model'
import { Model } from './app/model'
import { subscriptions } from './app/subscriptions'
import { init, update } from './app/update'
import { view } from './app/view'

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

// The shell serves from cache (see `public/service-worker.js`): register it
// once, and let an update wait for the next load rather than interrupting a
// review session mid-grade.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {})
  })
}
