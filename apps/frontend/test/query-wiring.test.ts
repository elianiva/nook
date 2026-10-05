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
import { deckDetailQuery } from '../src/app/queries'
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
    expect(names(init(url('/')))).toEqual(['FetchOverview', 'FetchDecks', 'RestoreImportJob'])
    expect(names(init(url('/decks')))).toEqual(['FetchDecks', 'RestoreImportJob'])
    expect(names(init(url('/decks/deck-a')))).toEqual(['FetchDeckDetail', 'RestoreImportJob'])
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
