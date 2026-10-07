/**
 * View dispatch: shell plus the active screen.
 *
 * Each Route arm delegates to its own screen module. Screen functions are
 * identity boundaries for the differ, so one screen per function.
 */

import type { Document, HtmlBuilder } from 'foldkit/html'
import { deckDetailView } from './deck-detail'
import { decksView } from './decks'
import { homeView } from './home'
import type { Message, Model } from './model'
import { AppRoute } from './routes'
import { reviewView } from './review'
import { settingsView } from './settings'
import { shell } from './shell'

const notFoundView = (model: Model, h: HtmlBuilder<Message>) =>
  shell(
    model,
    [
      h.div(
        [h.Class('flex flex-col items-center gap-2 py-16 text-center')],
        [
          h.span([h.Class('text-4xl font-bold tabular-nums')], ['404']),
          h.p([h.Class('text-sm text-muted-foreground')], [`Nothing lives at this URL.`]),
          h.a(
            [h.Href('/'), h.Class('text-xs font-medium text-primary hover:underline')],
            ['Back home'],
          ),
        ],
      ),
    ],
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const body = AppRoute.match(model.route, {
    Home: () => shell(model, homeView(model, h), h),
    Decks: () => shell(model, decksView(model, h), h),
    DeckDetail: ({ deckId }) => shell(model, deckDetailView(model, deckId, h), h),
    Review: () => shell(model, reviewView(model, h), h),
    ReviewDeck: () => shell(model, reviewView(model, h), h),
    Settings: () => shell(model, settingsView(model, h), h),
    NotFound: () => notFoundView(model, h),
  })
  return { title: 'nook', body }
}
