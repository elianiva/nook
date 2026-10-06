/**
 * The browser's exact wire path, without a browser.
 *
 * A real typed `RpcClient` (the same stack `NookRpc` uses) posts through a
 * stub `HttpClient` into the Worker's real `RpcServer.layerHttp` handler. The
 * handler and `migrate` share one `:memory:` database through a common
 * `Layer.MemoMap`, so there is no split-instance surprise.
 *
 * This locks in what the HAR verified by hand: the browser envelope reaches
 * the procedures and typed errors come back over HTTP.
 */

import { assert, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from 'effect/http'
import { RpcClient, RpcSerialization, RpcServer } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Api, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Home, HomeHandlers } from '../src/home'
import { Imports, ImportsHandlers } from '../src/imports'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { Settings, SettingsHandlers } from '../src/settings'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const ApiLive = RpcServer.layerHttp({ group: Api, path: '/api/rpc', protocol: 'http' }).pipe(
  Layer.provide([DecksHandlers, HomeHandlers, ImportsHandlers, ReviewsHandlers, SettingsHandlers]),
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(RpcSerialization.layerJson),
)

const AppLive = Layer.mergeAll(ApiLive).pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(HttpRouter.layer),
)

it.effect('serves the browser RPC envelope over real HTTP', () =>
  Effect.gen(function* () {
    const memoMap = yield* Layer.makeMemoMap
    const scope = yield* Effect.scope
    const { handler, dispose } = HttpRouter.toWebHandler(AppLive, {
      disableLogger: true,
      memoMap,
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))

    // The same memoized SqlClient the handler reads, so `migrate` seeds the
    // database the requests see.
    const sql = yield* Layer.buildWithMemoMap(SqlLive, memoMap, scope)
    yield* migrate.pipe(Effect.provide(Layer.succeedContext(sql)))

    const stub = HttpClient.make((request, _url, signal) =>
      Effect.gen(function* () {
        const encoded = HttpClientRequest.toWebResult(request, { signal })
        if (encoded._tag === 'Failure') {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.InvalidUrlError({ request }),
          })
        }
        const response = yield* Effect.promise(() => handler(encoded.success)).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
          ),
        )
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
    const protocol = RpcClient.layerProtocolHttp({ url: 'http://localhost/api/rpc' }).pipe(
      Layer.provide([RpcSerialization.layerJson, Layer.succeed(HttpClient.HttpClient, stub)]),
    )
    const client = yield* RpcClient.make(Api).pipe(Effect.provide(protocol))

    const decks = yield* client.decksList()
    assert.isAtLeast(decks.length, 1)
    const showcase = decks.find((deck) => deck.id === 'deck-showcase-japanese')
    assert.isDefined(showcase)
    expect(showcase?.dueCount).toBe(4)
    expect(showcase?.newCount).toBe(2)
    expect(showcase?.totalCount).toBe(8)

    const detail = yield* client.decksGetById({
      deckId: DeckId.make('deck-showcase-japanese'),
    })
    expect(detail.cards.length).toBe(8)

    const missing = yield* Effect.flip(client.decksGetById({ deckId: DeckId.make('deck-nope') }))
    expect(missing._tag).toBe('DeckNotFound')
  }).pipe(Effect.scoped),
)
