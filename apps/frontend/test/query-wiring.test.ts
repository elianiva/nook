/**
 * The Query wiring: which read each route starts, how a Retry reloads one, and
 * that a late answer from an older request cannot overwrite a newer one.
 *
 * These transitions are pure, so they are tested without a browser. The fetch
 * itself lives behind an Effect the test never runs.
 */

import { describe, expect, it } from 'vitest'
import { AsyncData } from 'foldkit'
import { Option, Result } from 'effect'
import type { Url } from 'foldkit/url'
import { DeckId, type DeckDetail } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import {
  deckDetailPersistFor,
  deckDetailQuery,
  decksPersist,
  overviewPersist,
  overviewQuery,
} from '../src/app/queries'
import { init, update } from '../src/app/update'

const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const names = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string }>
}): string[] => (result.commands ?? []).map((command) => command.name)

const deckId = DeckId.make('deck-a')

/** The request generation the deck-detail fetch Command carries. */
const fetchGeneration = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}): number => {
  const command = (result.commands ?? []).find((entry) => entry.name === 'FetchDeckDetail')
  const args = command?.args as { readonly generation?: unknown } | undefined
  if (typeof args?.generation !== 'number') throw new Error('expected a FetchDeckDetail generation')
  return args.generation
}

const detail = (name: string): DeckDetail => ({
  summary: {
    id: deckId,
    name,
    description: '',
    newCount: 0,
    dueCount: 0,
    totalCount: 0,
    lastStudiedAt: Option.none(),
    retention7d: 0,
  },
  cards: [],
})

describe('Query wiring', () => {
  it('starts the reads each route needs', () => {
    expect(names(init(url('/')))).toEqual([
      'FetchOverview',
      'FetchDecks',
      'RestoreImportJob',
      'RestoreQueries',
    ])
    expect(names(init(url('/decks')))).toEqual(['FetchDecks', 'RestoreImportJob', 'RestoreQueries'])
    expect(names(init(url('/decks/deck-a')))).toEqual([
      'FetchDeckDetail',
      'RestoreImportJob',
      'RestoreQueries',
    ])
  })

  it('seeds idle Queries from restored cache and keeps a fresher answer', () => {
    const cached = update(
      seedModel(url('/')),
      Message.RestoredCachedQueries({
        answers: [
          {
            kind: 'overview',
            value: {
              dueNow: 3,
              reviewedToday: 1,
              streakDays: 2,
              todayProgress: 25,
              activity14d: [],
            },
          },
          { kind: 'decks', value: [] },
          { kind: 'deckDetail', deckId, value: detail('Cached') },
        ],
      }),
    ).model

    // Each restored answer seeds its Query as data: a cold boot offline
    // shows the last cached screen at once.
    expect(AsyncData.getData(overviewQuery.read(cached.overview))).toEqual(
      Option.some({
        dueNow: 3,
        reviewedToday: 1,
        streakDays: 2,
        todayProgress: 25,
        activity14d: [],
      }),
    )
    expect(AsyncData.getData(deckDetailQuery.read(cached.deckDetail, { deckId }))).toEqual(
      Option.some(detail('Cached')),
    )

    // A fetch that already completed holds fresher data: a late restore
    // never overwrites it.
    const loaded = update(seedModel(url('/')), Message.ClickedRetryOverview()).model
    const reseeded = update(
      loaded,
      Message.RestoredCachedQueries({
        answers: [
          {
            kind: 'overview',
            value: {
              dueNow: 99,
              reviewedToday: 0,
              streakDays: 0,
              todayProgress: 0,
              activity14d: [],
            },
          },
        ],
      }),
    ).model
    expect(AsyncData.isLoading(overviewQuery.read(reseeded.overview))).toBe(true)
  })

  it('refreshes the shown queries when the tab becomes visible', () => {
    // Revalidate only refreshes loaded queries: idle screens stay quiet, so
    // a visibility event never starts a cold fetch storm.
    const overviewValue = {
      dueNow: 0,
      reviewedToday: 0,
      streakDays: 0,
      todayProgress: 0,
      activity14d: [],
    }
    const seededHome = update(
      seedModel(url('/')),
      Message.RestoredCachedQueries({
        answers: [
          { kind: 'overview', value: overviewValue },
          { kind: 'decks', value: [] },
        ],
      }),
    ).model
    expect(names(update(seededHome, Message.RevalidateVisible()))).toEqual([
      'FetchOverview',
      'FetchDecks',
    ])
    expect(names(update(seedModel(url('/')), Message.RevalidateVisible()))).toEqual([])

    const seededDeck = update(
      seedModel(url('/decks/deck-a')),
      Message.RestoredCachedQueries({
        answers: [{ kind: 'deckDetail', deckId, value: detail('Cached') }],
      }),
    ).model
    expect(names(update(seededDeck, Message.RevalidateVisible()))).toEqual(['FetchDeckDetail'])

    // Review and settings own their reads: visibility starts nothing there.
    expect(names(update(seedModel(url('/review')), Message.RevalidateVisible()))).toEqual([])
    expect(names(update(seedModel(url('/settings')), Message.RevalidateVisible()))).toEqual([])
  })

  it('warms a deck link on hover without refetching a loaded detail', () => {
    const cold = update(seedModel(url('/decks')), Message.PrefetchedDeckDetail({ deckId }))
    expect(names(cold)).toEqual(['FetchDeckDetail'])

    const seeded = update(
      seedModel(url('/decks')),
      Message.RestoredCachedQueries({
        answers: [{ kind: 'deckDetail', deckId, value: detail('Cached') }],
      }),
    )
    expect(names(update(seeded.model, Message.PrefetchedDeckDetail({ deckId })))).toEqual([])
  })

  it('round-trips a cached answer through its persist metadata', () => {
    // The store holds plain JSON, not `Option` instances: `toCache` encodes
    // through the query's own Schema (the same JSON-safe shape the backend
    // sends), and `fromCache` decodes it back. A structured-clone trip in
    // between must not lose the answer — that is what broke offline decks
    // and deck details, whose `Option` fields came back as `{}`.
    const fresh = {
      dueNow: 5,
      reviewedToday: 2,
      streakDays: 1,
      todayProgress: 40,
      activity14d: [1],
    }
    const stored = overviewPersist.toCache(fresh)
    expect(Option.isSome(stored)).toBe(true)
    if (Option.isSome(stored)) {
      const cloned = JSON.parse(JSON.stringify(stored.value)) as unknown
      const decoded = overviewPersist.fromCache(cloned)
      expect(Option.isSome(decoded)).toBe(true)
      if (Option.isSome(decoded)) {
        expect(decoded.value.data).toEqual(fresh)
        expect(typeof decoded.value.fetchedAt).toBe('number')
      }
    }
    expect(Option.isNone(overviewPersist.fromCache({ nope: true }))).toBe(true)
    expect(Option.isNone(decksPersist.fromCache(null))).toBe(true)
  })

  it('round-trips a deck detail with Option fields through a clone', () => {
    // Deck rows carry `lastStudiedAt`/`dueAt` Options: the regression that
    // read every cached deck back as absent.
    const persist = deckDetailPersistFor(deckId)
    const stored = persist.toCache(detail('Cached'))
    expect(Option.isSome(stored)).toBe(true)
    if (Option.isSome(stored)) {
      const cloned = JSON.parse(JSON.stringify(stored.value)) as unknown
      const decoded = persist.fromCache(cloned)
      expect(Option.isSome(decoded)).toBe(true)
      if (Option.isSome(decoded)) {
        expect(decoded.value.data).toEqual(detail('Cached'))
      }
    }
  })

  it('reloads a failed list from its own Retry', () => {
    const failed = update(
      seedModel(url('/decks')),
      Message.LoadFailed({ error: 'offline', retry: 'settings' }),
    ).model

    expect(names(update(failed, Message.ClickedRetryDecks()))).toEqual(['FetchDecks'])
  })

  it('ignores a late answer from an older request for the same deck', () => {
    const loaded = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedRetryDeckDetail({ deckId }),
    )
    const generation = fetchGeneration(loaded)

    const newer = update(
      loaded.model,
      Message.GotDeckDetailMessage({
        message: {
          _tag: 'CompletedFetch',
          args: { deckId },
          generation,
          result: Result.succeed(detail('Newer')),
        },
      }),
    ).model

    const stale = update(
      newer,
      Message.GotDeckDetailMessage({
        message: {
          _tag: 'CompletedFetch',
          args: { deckId },
          generation: generation - 1,
          result: Result.succeed(detail('Older')),
        },
      }),
    ).model

    const data = AsyncData.getData(deckDetailQuery.read(stale.deckDetail, { deckId }))
    expect(Option.isSome(data) && data.value.summary.name).toBe('Newer')
  })
})
