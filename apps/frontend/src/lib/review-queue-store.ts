/**
 * The prefetched review queue: rendered Cards the device holds for offline
 * review (ADR 0001).
 *
 * The device keeps the next ~200 Cards, already rendered. The queue is a
 * cache, not the system of record: the server stays authoritative, and a grade
 * lands through the normal procedure when the network returns.
 * `review_snapshots` make a replayed id safe, so a flush that half-lands
 * repairs itself on retry.
 *
 * One record per deck scope (`all` or one deck id). IndexedDB is the only
 * durable state the review client adds; D1 stays the source of truth for what
 * is due.
 */

import { Effect, Option, Schema as S } from 'effect'
import { DeckId } from '@nook/api'
import { runIdbRequest } from './idb'

const STORE_NAME = 'reviewQueues'

/** One cached queue: the rendered Cards. */
export interface CachedQueue {
  /**
   * The queued cards as plain JSON (the `ReviewCard` wire shape), not domain
   * `ReviewCard` values: `dueAt` is an `Option`, which does not survive the
   * structured clone. `LoadCachedQueue` decodes these back on the way out.
   */
  readonly cards: S.Json
  readonly dayStartUtc: string
  readonly lapseMinutes: number
  readonly cachedAt: number
}

/** The browser refused to read or write its own storage. */
export class ReviewQueueStoreUnavailable extends Error {
  readonly _tag = 'ReviewQueueStoreUnavailable'
}

const keyFor = (deckId: Option.Option<DeckId>): string =>
  Option.match(deckId, { onNone: () => 'all', onSome: (id) => id })

/** Runs one request against the store and closes the database when it lands. */
const request = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, ReviewQueueStoreUnavailable> =>
  Effect.tryPromise({
    try: () => runIdbRequest(STORE_NAME, mode, run),
    catch: () => new ReviewQueueStoreUnavailable(),
  })

/** Keeps `queue` as the cached Cards for `deckId`. Overwrites any earlier cache. */
export const saveReviewQueue = (
  deckId: Option.Option<DeckId>,
  queue: CachedQueue,
): Effect.Effect<void, ReviewQueueStoreUnavailable> =>
  request('readwrite', (store) => store.put(queue, keyFor(deckId))).pipe(Effect.asVoid)

/** The cached Cards for `deckId`, or `None` when nothing is cached. */
export const loadReviewQueue = (
  deckId: Option.Option<DeckId>,
): Effect.Effect<Option.Option<CachedQueue>, ReviewQueueStoreUnavailable> =>
  request('readonly', (store) => store.get(keyFor(deckId))).pipe(
    Effect.map((value: unknown) => {
      if (typeof value !== 'object' || value === null) return Option.none()
      const record = value as Record<string, unknown>
      if (!Array.isArray(record['cards']) || typeof record['dayStartUtc'] !== 'string') {
        return Option.none()
      }
      return Option.some(record as unknown as CachedQueue)
    }),
  )
