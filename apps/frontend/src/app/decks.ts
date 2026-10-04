/**
 * Decks page: the full deck list with search and an import entry point.
 *
 * Each row is the same `DeckSummary` projection as on Home — counts plus the
 * next Review, never Card bodies. Search filters locally on name and
 * description; the backend will accept the same query string later.
 */

import type { Html, HtmlBuilder } from 'foldkit/html'
import { Inbox, Search, Upload } from 'lucide'
import { Empty } from '@/components/ui/empty'
import { input } from '@/components/ui/input'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import type { DeckSummary } from '@nook/api'
import { deckRow } from './home'
import { Message } from './model'
import type { Model } from './model'

type Child = Html | string

export const visibleDecks = (model: Model): ReadonlyArray<DeckSummary> => {
  const query = model.decksQuery.trim().toLowerCase()
  if (query === '') return model.decks
  return model.decks.filter(
    (deck) =>
      deck.name.toLowerCase().includes(query) || deck.description.toLowerCase().includes(query),
  )
}

export const decksView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const decks = visibleDecks(model)
  return [
    h.div(
      [h.Class('flex gap-2')],
      [
        h.div(
          [h.Class('relative flex-1')],
          [
            h.div(
              [
                h.Class(
                  'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground',
                ),
              ],
              [icon(h, Search, 'size-4')],
            ),
            input<Message>(
              {
                id: 'decks-search',
                label: 'Search decks',
                labelClass: 'sr-only',
                wrapperClass: 'gap-0',
                placeholder: 'Search decks…',
                value: model.decksQuery,
                onInput: (value) => Message.TypedDecksQuery({ value }),
                className: 'pl-8',
              },
              h,
            ),
          ],
        ),
        button<Message>(
          { variant: 'outline', size: 'icon', attributes: [h.AriaLabel('Import deck')] },
          [icon(h, Upload, 'size-4')],
          h,
        ),
      ],
    ),
    h.div(
      [h.Class('text-xs text-muted-foreground')],
      [
        `${decks.length} of ${model.decks.length} decks · ${model.decks.reduce((sum, deck) => sum + deck.dueCount, 0)} due total`,
      ],
    ),
    ...(decks.length === 0
      ? [
          Empty<Message>(
            {},
            [
              Empty.media<Message>({ variant: 'icon' }, [icon(h, Inbox, 'size-4')], h),
              Empty.title<Message>(
                {},
                [model.decks.length === 0 ? 'No decks yet' : 'No matching decks'],
                h,
              ),
              Empty.description<Message>(
                {},
                [
                  model.decks.length === 0
                    ? 'Import an .apkg archive to start reviewing.'
                    : `Nothing matches “${model.decksQuery.trim()}”.`,
                ],
                h,
              ),
            ],
            h,
          ),
        ]
      : decks.map((deck) => deckRow(deck, h))),
  ]
}
