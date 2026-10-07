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
 * Stored values are untrusted and decoded at the boundary; anything misshapen
 * reads as absent.
 */

import { Effect, Option } from 'effect'
import { runIdbRequest } from './idb'

const STORE_NAME = 'queryCache'

/** Bump when a cached shape changes. Older records read as absent. */
const QUERY_CACHE_VERSION = 1

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
    try: () => runIdbRequest(STORE_NAME, mode, run),
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
