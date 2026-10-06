/**
 * The query cache: durable `AsyncData` for the list reads (ADR 0001's
 * younger sibling).
 *
 * Foldkit Query keeps data in memory only, so a reload starts every screen
 * empty. This store keeps the last good answer for each list query in
 * IndexedDB — one object store, one record per cache key — with a version
 * and a timestamp, so boot can reseed each Query as `Success` before the
 * network answers and a failed refresh can fall back to data within its max
 * age instead of failing cold.
 *
 * The open/transaction pattern mirrors `review-queue-store.ts`: one request
 * per connection, closed when it lands. Stored values are untrusted and
 * decoded at the boundary; anything misshapen reads as absent.
 */

import { Effect, Option } from 'effect'

const DB_NAME = 'nook'
const STORE_NAME = 'queryCache'
const DB_VERSION = 4

/** Bump when a cached shape changes. Older records read as absent. */
export const QUERY_CACHE_VERSION = 1

/** A cached answer: the data, when it landed, and the shape version. */
export interface CachedQuery<Data> {
  readonly data: Data
  readonly cachedAt: number
  readonly version: number
}

/** The browser refused to read or write its own storage. */
export class QueryCacheUnavailable extends Error {
  readonly _tag = 'QueryCacheUnavailable'
}

/** Runs one request against the store and closes the database when it lands. */
const request = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, QueryCacheUnavailable> =>
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
          // The database is shared (see `review-queue-store.ts`): create every
          // store the app owns, so whichever module upgrades first leaves a
          // complete database behind.
          for (const name of ['reviewQueues', 'queryCache', 'importJobs'] as const) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name)
            }
          }
        }
        open.onerror = () => reject(open.error ?? new Error('Could not open the query store.'))
        open.onsuccess = () => {
          const db = open.result
          const close = (): void => db.close()
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            // The database predates this store: widen the schema, then retry
            // the open so the upgrade that creates the store can run (see
            // `review-queue-store.ts` for the full pattern).
            const version = db.version + 1
            close()
            const retry = indexedDB.open(DB_NAME, version)
            retry.onupgradeneeded = () => {
              const upgraded = retry.result
              for (const name of ['reviewQueues', 'queryCache', 'importJobs'] as const) {
                if (!upgraded.objectStoreNames.contains(name)) {
                  upgraded.createObjectStore(name)
                }
              }
            }
            retry.onerror = () =>
              reject(retry.error ?? new Error('Could not open the query store.'))
            retry.onsuccess = () => {
              const retried = retry.result
              const transaction = retried.transaction(STORE_NAME, mode)
              transaction.oncomplete = () => retried.close()
              transaction.onabort = () => retried.close()
              const result = run(transaction.objectStore(STORE_NAME))
              result.onsuccess = () => resolve(result.result)
              result.onerror = () =>
                reject(result.error ?? new Error('The query store did not answer.'))
            }
            return
          }
          const transaction = db.transaction(STORE_NAME, mode)
          transaction.oncomplete = close
          transaction.onabort = close
          const result = run(transaction.objectStore(STORE_NAME))
          result.onsuccess = () => resolve(result.result)
          result.onerror = () =>
            reject(result.error ?? new Error('The query store did not answer.'))
        }
      }),
    catch: () => new QueryCacheUnavailable(),
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Keeps `data` under `key`. Overwrites any earlier cache for that key. */
export const saveQuery = <Data>(
  key: string,
  data: Data,
): Effect.Effect<void, QueryCacheUnavailable> =>
  request('readwrite', (store) =>
    store.put({ data, cachedAt: Date.now(), version: QUERY_CACHE_VERSION }, key),
  ).pipe(Effect.asVoid)

/**
 * The cached answer under `key`, or `None` when nothing usable is cached.
 *
 * A record reads as absent when its version moved on, its timestamp is not a
 * number, its age passed `maxAgeMs`, or its `decode` rejects the data.
 * IndexedDB hands back `unknown`; the shape check lives here, not in the
 * caller.
 */
export const loadQuery = <Data>(
  key: string,
  maxAgeMs: number,
  decode: (value: unknown) => Option.Option<Data>,
): Effect.Effect<Option.Option<CachedQuery<Data>>, QueryCacheUnavailable> =>
  request('readonly', (store) => store.get(key)).pipe(
    Effect.map((value: unknown) => {
      if (!isRecord(value)) return Option.none()
      const { data, cachedAt, version } = value
      if (version !== QUERY_CACHE_VERSION) return Option.none()
      if (typeof cachedAt !== 'number' || Number.isNaN(cachedAt)) return Option.none()
      if (Date.now() - cachedAt > maxAgeMs) return Option.none()
      return Option.map(decode(data), (decoded) => ({
        data: decoded,
        cachedAt,
        version: QUERY_CACHE_VERSION,
      }))
    }),
  )

/** Drops the cached answer under `key`. */
export const clearQuery = (key: string): Effect.Effect<void, QueryCacheUnavailable> =>
  request('readwrite', (store) => store.delete(key)).pipe(Effect.asVoid)
