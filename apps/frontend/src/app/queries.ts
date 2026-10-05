/**
 * Query submodels: one retained resource each.
 *
 * A Query owns a fetch Command, the `AsyncData` state it lands in, and a
 * generation number that rejects a late answer from an older request. The
 * parent stores the Query Model, delegates its Messages, and decides when to
 * load or refresh by calling `loadIfMissing`, `revalidateOrLoad`, or
 * `revalidate`. See `docs/adr/0004-queries-own-fetch-state.md`.
 *
 * Every `execute` decodes the response with the same `@nook/api` Schema the
 * backend encodes with, and maps any failure (network, 503, decode) to one
 * sentence for the Learner. Failure is a value in the error channel, never a
 * thrown error, so the Query settles into `Failure` or keeps the last good data
 * as `Stale`.
 */

import { Effect, Schema as S } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { Http } from 'foldkit'
import { Query } from 'foldkit/experimental'
import { DeckDetail, DeckId, DeckSummary, Overview } from '@nook/api'
import { API_PATHS } from '@/lib/api'

/**
 * The decks endpoint answers 404 for an id no Deck has, which is an answer,
 * not an outage. Every other failure is retryable.
 */
export const DeckDetailError = S.Literals(['notFound', 'unavailable'])
export type DeckDetailError = typeof DeckDetailError.Type

/** GET a JSON body, decode it, and collapse every failure to one sentence. */
const getJson = <A, AI>(
  path: string,
  schema: S.Codec<A, AI, never, never>,
  message: string,
): Effect.Effect<A, string, never> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(path)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.mapError(() => message),
    Effect.provide(Http.layer),
  )

/** The overview: due counts, streak, and the 14-day activity strip. */
export const overviewQuery = Query.define({
  name: 'Overview',
  data: Overview,
  error: S.String,
  execute: getJson(
    API_PATHS.home,
    Overview,
    'Could not load the overview. Check the connection and try again.',
  ),
})

/** Every Deck as a list-screen projection. Home and Decks share this one query. */
export const decksQuery = Query.define({
  name: 'Decks',
  data: S.Array(DeckSummary),
  error: S.String,
  execute: getJson(
    API_PATHS.decks,
    S.Array(DeckSummary),
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
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(`${API_PATHS.decks}/${encodeURIComponent(deckId)}`)
      if (response.status === 404) return yield* Effect.fail('notFound' as const)
      const ok = yield* HttpClientResponse.filterStatusOk(response)
      return yield* HttpClientResponse.schemaBodyJson(DeckDetail)(ok)
    }).pipe(
      Effect.mapError((error): DeckDetailError =>
        error === 'notFound' ? 'notFound' : 'unavailable',
      ),
      Effect.provide(Http.layer),
    ),
})
