/**
 * The prefetched review queue: rendered Cards the device holds for offline
 * review (ADR 0001).
 *
 * The device keeps the next ~200 Cards, already rendered, plus the grades it
 * made while offline. The queue is a cache, not the system of record: the
 * server stays authoritative, and a grade lands through the normal endpoint
 * when the network returns. `review_snapshots` make a replayed id safe, so a
 * flush that half-lands repairs itself on retry.
 *
 * One record per deck scope (`all` or one deck id). IndexedDB is the only
 * durable state the review client adds; D1 stays the source of truth for what
 * is due.
 */

import { Effect, Option } from 'effect'
import { CardId, DeckId, ReviewCard } from '@nook/api'
import type { Grade } from '@nook/api'

const DB_NAME = 'nook'
const STORE_NAME = 'reviewQueues'
const DB_VERSION = 2

/** A grade made while offline, waiting for the network. */
export interface OfflineGrade {
  readonly id: string
  readonly cardId: CardId
  readonly grade: Grade
}

/** One cached queue: the rendered Cards plus the offline grades against them. */
export interface CachedQueue {
  readonly cards: ReadonlyArray<ReviewCard>
  readonly dayStartUtc: string
  readonly lapseMinutes: number
  readonly cachedAt: number
  readonly grades: ReadonlyArray<OfflineGrade>
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
    try: () =>
      new Promise<A>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('No IndexedDB in this environment.'))
          return
        }
        const open = indexedDB.open(DB_NAME, DB_VERSION)
        open.onupgradeneeded = () => {
          const db = open.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        open.onerror = () => reject(open.error ?? new Error('Could not open the review store.'))
        open.onsuccess = () => {
          const db = open.result
          const transaction = db.transaction(STORE_NAME, mode)
          const result = run(transaction.objectStore(STORE_NAME))
          result.onsuccess = () => resolve(result.result)
          result.onerror = () =>
            reject(result.error ?? new Error('The review store did not answer.'))
          transaction.oncomplete = () => db.close()
        }
      }),
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

/** Drops the cached Cards for `deckId`. */
export const clearReviewQueue = (
  deckId: Option.Option<DeckId>,
): Effect.Effect<void, ReviewQueueStoreUnavailable> =>
  request('readwrite', (store) => store.delete(keyFor(deckId))).pipe(Effect.asVoid)

/** Grades made while offline, oldest first. */
export const loadOfflineGrades = (): Effect.Effect<
  ReadonlyArray<OfflineGrade>,
  ReviewQueueStoreUnavailable
> =>
  request('readonly', (store) => store.get('offline-grades')).pipe(
    Effect.map((value: unknown) => (Array.isArray(value) ? (value as Array<OfflineGrade>) : [])),
  )

/** Keeps the offline grades. Overwrites the earlier list. */
export const saveOfflineGrades = (
  grades: ReadonlyArray<OfflineGrade>,
): Effect.Effect<void, ReviewQueueStoreUnavailable> =>
  request('readwrite', (store) => store.put([...grades], 'offline-grades')).pipe(Effect.asVoid)
