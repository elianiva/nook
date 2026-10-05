/**
 * View dispatch: shell plus the active screen.
 *
 * Each Route arm delegates to its own screen module. Screen functions are
 * identity boundaries for the differ, so one screen per function.
 */

import { Option } from 'effect'
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

const homeShell = (model: Model, h: HtmlBuilder<Message>) => shell(model, homeView(model, h), h)

const decksShell = (model: Model, h: HtmlBuilder<Message>) => shell(model, decksView(model, h), h)

const settingsShell = (model: Model, h: HtmlBuilder<Message>) =>
  shell(model, settingsView(model, h), h)

const reviewShell = (model: Model, h: HtmlBuilder<Message>) => shell(model, reviewView(model, h), h)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  void Option.isSome
  const body = AppRoute.match(model.route, {
    Home: () => homeShell(model, h),
    Decks: () => decksShell(model, h),
    DeckDetail: ({ deckId }) => shell(model, deckDetailView(model, deckId, h), h),
    Review: () => reviewShell(model, h),
    ReviewDeck: () => reviewShell(model, h),
    Settings: () => settingsShell(model, h),
    NotFound: () => notFoundView(model, h),
  })
  return { title: 'nook', body }
}
