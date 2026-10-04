import './styles.css'
import { Navigation, Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'
import { Message } from './app/model'
import { Model } from './app/model'
import { init, update } from './app/update'
import { view } from './app/view'

const program = Runtime.makeApplication({
  Model,
  init: (url: Url) => init(url),
  update,
  view,
  routing: {
    onUrlRequest: (request: Navigation.UrlRequest): Message => Message.ClickedLink({ request }),
    onUrlChange: (url: Url): Message => Message.ChangedUrl({ url }),
  },
  container: document.getElementById('root'),
})

Runtime.run(program)
