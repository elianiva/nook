/**
 * The Decks page sections: due decks group into `Needs attention`, clean
 * decks stay in `Up to date`, and the Import entry ends the page as one
 * dark footer button.
 *
 * These run through the real `decksView` with Query state prefilled, so the
 * test asserts the shipped structure instead of a copy of it. The decks are
 * seeded through `RestoredCachedQueries`, the same path a cold boot reads
 * from IndexedDB.
 */

import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import type { Url } from 'foldkit/url'
import { DeckId, type DeckSummary } from '@nook/api'
import { getAllByText, getByText, given, scene, tap } from 'foldkit/scene'
import { Message, seedModel } from '../src/app/model'
import type { Model } from '../src/app/model'
import type { HtmlBuilder } from 'foldkit/html'
import { update } from '../src/app/update'
import { decksView } from '../src/app/decks'

const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const deck = (
  id: string,
  name: string,
  counts: Pick<DeckSummary, 'newCount' | 'dueCount' | 'totalCount'>,
): DeckSummary => ({
  id: DeckId.make(id),
  name,
  description: '',
  newCount: counts.newCount,
  dueCount: counts.dueCount,
  totalCount: counts.totalCount,
  newToday: counts.newCount,
  dueToday: counts.dueCount,
  limits: { newPerDay: null, reviewsPerDay: null, lapseMinutes: null },
  lastStudiedAt: Option.none(),
  retention7d: 0,
})

const seedDecks = (model: Model, decks: ReadonlyArray<DeckSummary>): Model =>
  update(model, Message.RestoredCachedQueries({ answers: [{ kind: 'decks', value: [...decks] }] }))
    .model

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.div([h.Class('decks-sections')], decksView(model, h))

describe('decks sections', () => {
  it('groups due decks into Needs attention and clean decks into Up to date', () => {
    const model = seedDecks(seedModel(url('/decks')), [
      deck('n5', 'N5 Vocab', { newCount: 5, dueCount: 32, totalCount: 100 }),
      deck('default', 'Default', { newCount: 0, dueCount: 0, totalCount: 0 }),
    ])
    scene(
      { update, view },
      given(model),
      tap((simulation) => {
        expect(getByText('Needs attention')(simulation.html)).toBeDefined()
        expect(getByText('Up to date')(simulation.html)).toBeDefined()
        expect(getByText('N5 Vocab')(simulation.html)).toBeDefined()
        expect(getByText('Default')(simulation.html)).toBeDefined()
        expect(getByText('Import a deck…')(simulation.html)).toBeDefined()
      }),
    )
  })

  it('hides Needs attention when nothing is due', () => {
    const model = seedDecks(seedModel(url('/decks')), [
      deck('default', 'Default', { newCount: 0, dueCount: 0, totalCount: 0 }),
      deck('kaishi', 'Kaishi 1.5k', { newCount: 0, dueCount: 0, totalCount: 0 }),
    ])
    scene(
      { update, view },
      given(model),
      tap((simulation) => {
        expect(getAllByText('Needs attention')(simulation.html)).toEqual([])
        expect(getByText('Up to date')(simulation.html)).toBeDefined()
        expect(getByText('Import a deck…')(simulation.html)).toBeDefined()
      }),
    )
  })

  it('shows neither section when no decks exist yet', () => {
    const model = seedDecks(seedModel(url('/decks')), [])
    scene(
      { update, view },
      given(model),
      tap((simulation) => {
        expect(getByText('No decks yet')(simulation.html)).toBeDefined()
        expect(getByText('Import a deck…')(simulation.html)).toBeDefined()
      }),
    )
  })
})
