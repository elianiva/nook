/**
 * Query submodels: one retained resource each.
 *
 * A Query owns a fetch Command, the `AsyncData` state it lands in, and a
 * generation number that rejects a late answer from an older request. The
 * parent stores the Query Model, delegates its Messages, and decides when to
 * load or refresh by calling `loadIfMissing`, `revalidateOrLoad`, or
 * `revalidate`. See `docs/adr/0004-queries-own-fetch-state.md`.
 *
 * Every `execute` calls one RPC procedure through `withCache`, so a network
 * failure falls back to the query cache (`lib/query-cache`) before returning
 * unavailable, and a fresh answer saves itself on the way through. Any
 * failure (transport, typed error) maps to one sentence for the Learner.
 * Failure is a value in the error channel, never a thrown error, so the
 * Query settles into `Failure` or keeps the last good data as `Stale`.
 *
 * The persist metadata beside each query names its cache key, its max age,
 * and its `toCache` mapping; boot hydrate and the stale fallback both read
 * from that one table. `fetchedAt` rides alongside the domain data so a
 * cached screen can name its age.
 */

import { Effect, Option, Schema as S } from 'effect'
import { Query } from 'foldkit/experimental'
import { DeckDetail, DeckId, DeckSummary, Overview } from '@nook/api'
import { clearQuery, loadQuery, saveQuery } from '@/lib/query-cache'
import { NookRpc } from '@/lib/rpc'

/**
 * The deck read answers `DeckNotFound` for an id no Deck has, which is an
 * answer, not an outage. Every other failure is retryable.
 */
export const DeckDetailError = S.Literals(['notFound', 'unavailable'])
export type DeckDetailError = typeof DeckDetailError.Type

/** A cached answer with its landing time, for the age display. */
export interface CachedAnswer<Data> {
  readonly data: Data
  readonly fetchedAt: number
}

/**
 * What boot hydrate and the stale fallback need to know about one query.
 *
 * The wire (`toCache`) and store (`fromCache`) sides deliberately differ.
 * `toCache` encodes a fresh answer to plain JSON through the query's own
 * Schema — the same JSON-safe shape the backend sends — because an `Option`
 * instance does not survive IndexedDB's structured clone (its tag fields
 * are non-enumerable, so a stored `None` reads back as `{}`). `fromCache`
 * decodes that JSON back into domain data. Both sides share one cache key
 * and max age, so boot hydrate and the stale fallback read the same table.
 */
export interface QueryPersist<Data, Encoded> {
  /** The IndexedDB record key. */
  readonly cacheKey: string
  /** How long a cached answer stays usable. */
  readonly maxAgeMs: number
  /** Encodes a fresh answer to plain JSON, or `None` when it cannot be stored. */
  readonly toCache: (data: Data) => Option.Option<CachedQuery<Encoded>>
  /** Decodes stored JSON, or `None` when it is missing, stale, or misshapen. */
  readonly fromCache: (value: unknown) => Option.Option<CachedQuery<Data>>
}

/** A cached answer as the store holds it: data plus landing time. */
export interface CachedQuery<Data> {
  readonly data: Data
  readonly fetchedAt: number
}

/** One day: the list reads stay usable offline for a full learner-day. */
const DAY_MS = 24 * 60 * 60 * 1000

const makePersist = <Data, Encoded>(
  cacheKey: string,
  dataSchema: S.Codec<Data, Encoded, never, never>,
): QueryPersist<Data, S.Json> => {
  const json = S.toCodecJson(dataSchema)
  const cachedSchema = S.Struct({ data: json, fetchedAt: S.Number })
  return {
    cacheKey,
    maxAgeMs: DAY_MS,
    toCache: (data) =>
      Option.map(S.encodeUnknownOption(json)(data), (encoded) => ({
        data: encoded,
        fetchedAt: Date.now(),
      })),
    fromCache: (value) => S.decodeUnknownOption(cachedSchema)(value),
  }
}

/** The overview: due counts, streak, and the 14-day activity strip. */
export const overviewPersist = makePersist('query:overview', Overview)

/** Every Deck as a list-screen projection. Home and Decks share this one query. */
export const decksPersist = makePersist('query:decks', S.Array(DeckSummary))

/** One Deck's detail, per deck id. Only the last 20 decks stay cached. */
export const deckDetailPersistFor = (deckId: DeckId): QueryPersist<DeckDetail, S.Json> =>
  makePersist(`query:deck-detail:${deckId}`, DeckDetail)

/** Deck-detail cache keys, oldest first. Capped so one collection cannot claim unbounded storage. */
const DECK_DETAIL_INDEX_KEY = 'query:deck-detail:index'
export const DECK_DETAIL_CACHE_LIMIT = 20

/**
 * Runs `fresh`, saves a good answer, and falls back to the query cache when
 * the network fails. A usable cached answer resolves instead of the
 * unavailable sentence; only a cold miss (nothing cached, too old, or
 * misshapen) rejects.
 */
const withCache = <A, Encoded, E>(
  persist: QueryPersist<A, Encoded>,
  fresh: Effect.Effect<A, E, never>,
  unavailable: E,
): Effect.Effect<A, E, never> =>
  fresh.pipe(
    Effect.tap((data) =>
      Option.match(persist.toCache(data), {
        onNone: () => Effect.void,
        onSome: (cached) => saveQuery(persist.cacheKey, cached).pipe(Effect.ignore),
      }),
    ),
    Effect.catch(() =>
      loadQuery(persist.cacheKey, persist.maxAgeMs, persist.fromCache).pipe(
        Effect.flatMap((cached) =>
          Option.match(cached, {
            onNone: () => Effect.fail(unavailable),
            onSome: (answer) => Effect.succeed(answer.data.data),
          }),
        ),
        Effect.catch(() => Effect.fail(unavailable)),
      ),
    ),
    Effect.tap(() =>
      persist.cacheKey.startsWith('query:deck-detail:')
        ? touchDeckDetailIndex(persist.cacheKey).pipe(Effect.ignore)
        : Effect.void,
    ),
  )

/**
 * Keeps the deck-detail index fresh and drops the oldest entries past the
 * cap. The index is best-effort: a lost index only means the next boots keep
 * more than 20 until touches rebuild it.
 */
const touchDeckDetailIndex = (key: string): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const decodeIndex = (value: unknown): Option.Option<ReadonlyArray<string>> => {
      if (!Array.isArray(value)) return Option.none()
      const entries: Array<string> = []
      for (const entry of value) {
        if (typeof entry !== 'string') return Option.none()
        entries.push(entry)
      }
      return Option.some(entries)
    }
    const cached = yield* loadQuery(DECK_DETAIL_INDEX_KEY, DAY_MS * 365, decodeIndex).pipe(
      Effect.catch(() => Effect.succeed(Option.none())),
    )
    const previous = Option.match(cached, {
      onNone: () => [] as ReadonlyArray<string>,
      onSome: (answer) => answer.data,
    })
    const next = [...previous.filter((entry) => entry !== key), key]
    const evicted = next.slice(0, Math.max(0, next.length - DECK_DETAIL_CACHE_LIMIT))
    yield* saveQuery(DECK_DETAIL_INDEX_KEY, next.slice(-DECK_DETAIL_CACHE_LIMIT)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    for (const evictedKey of evicted) {
      yield* clearQuery(evictedKey).pipe(Effect.catch(() => Effect.succeed(undefined)))
    }
  })

/** The learner timezone, for the day boundary. The server defaults to UTC without it. */
const timezone = (): string | undefined => {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone !== undefined && zone !== '' ? zone : undefined
  } catch {
    // No Intl: the server falls back to UTC.
    return undefined
  }
}

/** Call one RPC procedure, collapse every failure to one sentence. */
const call = <A, E>(
  run: (rpc: NookRpc['Service']) => Effect.Effect<A, E>,
  message: string,
): Effect.Effect<A, string, never> =>
  NookRpc.pipe(
    Effect.flatMap(run),
    Effect.mapError(() => message),
    Effect.provide(NookRpc.layer),
  )

/** The overview: due counts, streak, and the 14-day activity strip. */
export const overviewQuery = Query.define({
  name: 'Overview',
  data: Overview,
  error: S.String,
  execute: withCache(
    overviewPersist,
    call(
      (rpc) => rpc.homeOverview({ timezone: timezone() }),
      'Could not load the overview. Check the connection and try again.',
    ),
    'Could not load the overview. Check the connection and try again.',
  ),
})

/** Every Deck as a list-screen projection. Home and Decks share this one query. */
export const decksQuery = Query.define({
  name: 'Decks',
  data: S.Array(DeckSummary),
  error: S.String,
  execute: withCache(
    decksPersist,
    call((rpc) => rpc.decksList(), 'Could not load the decks. Check the connection and try again.'),
    'Could not load the decks. Check the connection and try again.',
  ),
})

/**
 * One Deck per id, retained. A KeyedQuery keeps a separate entry for each
 * `deckId`, so returning to a Deck shows its last data while a refresh runs,
 * and a slow answer for one Deck cannot overwrite another.
 */
export const deckDetailQuery = Query.define({
  name: 'DeckDetail',
  args: { deckId: DeckId },
  data: DeckDetail,
  error: DeckDetailError,
  execute: ({ deckId }) =>
    withCache(
      deckDetailPersistFor(deckId),
      NookRpc.pipe(
        Effect.flatMap((rpc) => rpc.decksGetById({ deckId })),
        Effect.catchTag('DeckNotFound', () => Effect.fail('notFound' as const)),
        Effect.mapError((error): DeckDetailError =>
          error === 'notFound' ? 'notFound' : 'unavailable',
        ),
        Effect.provide(NookRpc.layer),
      ),
      'unavailable' as const,
    ),
})
