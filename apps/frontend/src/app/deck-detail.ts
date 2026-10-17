/**
 * Deck page: one Deck's summary plus its Card list.
 *
 * The header carries the counts and a Start action; the list shows each
 * Card's prompt preview with its scheduling state underneath. The read is
 * the deck-detail KeyedQuery, so an unknown id renders its not-found state
 * and a known Deck keeps its last answer while a refresh runs.
 */

import { AsyncData } from 'foldkit'
import { Option } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { CircleAlert } from 'lucide'
import { Empty } from '@/components/ui/empty'
import { icon } from '@/lib/icons'
import type { DeckDetail, DeckId } from '@nook/api'
import { errorPanel, loadingHero, loadingRows } from './load-state'
import { Message } from './model'
import type { DeckManage, Model } from './model'
import { deckDetailQuery } from './queries'
import { routeToUrl } from './routes'
import { cardsSection } from './deck-detail/cards'
import { header } from './deck-detail/header'
import { manageSection } from './deck-detail/manage'
import type { Child } from './deck-detail/child'

/** A deck id that names no Deck. This is an answer, not a failure to retry. */
const deckNotFound = (h: HtmlBuilder<Message>): ReadonlyArray<Child> => [
  Empty<Message>(
    {},
    [
      Empty.media<Message>({ variant: 'icon' }, [icon(h, CircleAlert, 'size-4')], h),
      Empty.title<Message>({}, ['Deck not found'], h),
      Empty.description<Message>({}, ['This deck does not exist on this device.'], h),
      Empty.content<Message>(
        {},
        [
          h.a(
            [
              h.Href(routeToUrl({ _tag: 'Decks' })),
              h.Class('text-xs font-medium text-primary hover:underline'),
            ],
            ['Back to decks'],
          ),
        ],
        h,
      ),
    ],
    h,
  ),
]

const deckBody = (
  detail: DeckDetail,
  manage: DeckManage,
  forDeck: boolean,
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => [
  header(detail, h),
  cardsSection(detail, forDeck ? manage : null, model, h),
  h.h2([h.Class('text-sm font-semibold')], ['Manage']),
  manageSection(detail, forDeck ? manage : null, h),
]

export const deckDetailView = (
  model: Model,
  deckId: DeckId,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> =>
  AsyncData.matchData(deckDetailQuery.read(model.deckDetail, { deckId }), {
    onEmpty: () => [loadingHero('Loading this deck…', h), loadingRows('Loading Cards…', h, 4)],
    onFailure: (error) =>
      error === 'notFound'
        ? deckNotFound(h)
        : [
            errorPanel(
              'Could not load this deck. Check the connection and try again.',
              Message.ClickedRetryDeckDetail({ deckId }),
              h,
            ),
          ],
    // The manage draft belongs to one deck; only hand it over when it names
    // this page's deck, so a stale draft never renders under another deck.
    onData: (detail) =>
      deckBody(
        detail,
        model.deckManage,
        Option.match(model.deckManage.deckId, {
          onNone: () => false,
          onSome: (id) => id === deckId,
        }),
        model,
        h,
      ),
  })
