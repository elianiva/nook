/**
 * The Worker entry `Cloudflare.Website.Foldkit` bundles and uploads.
 *
 * It owns `/api/*`: a liveness probe, the Media store, and the RPC group the
 * browser calls. Every other request goes to the static asset binding, which
 * serves the Foldkit client build and its `index.html` fallback for client
 * routes.
 *
 * Media is handled before the router because it is binary: the router speaks
 * `HttpServerResponse`, and a Card's image or audio is a stream from R2.
 */

import type { D1Database } from '@cloudflare/workers-types'
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Api } from '@nook/api'
import {
  Decks,
  DecksHandlers,
  Home,
  HomeHandlers,
  Imports,
  ImportsHandlers,
  Restore,
  RestoreHandlers,
  Reviews,
  ReviewsHandlers,
  Settings,
  SettingsHandlers,
  SqlLive,
} from '@nook/backend'
import { HEALTH_PATH, MEDIA_PATH, RPC_PATH } from './lib/api'
import { mediaResponse, type MediaBucket } from './lib/media'

/** The static asset binding, as much of it as this Worker uses. */
type Assets = {
  fetch(request: Request): Promise<Response>
}

type Env = {
  ASSETS: Assets
  DB: D1Database
  MEDIA: MediaBucket
}

const healthRoute = HttpRouter.add('GET', HEALTH_PATH, () => HttpServerResponse.json({ ok: true }))

const apiRoutes = RpcServer.layerHttp({
  group: Api,
  path: RPC_PATH,
  protocol: 'http',
}).pipe(
  Layer.provide([
    DecksHandlers,
    HomeHandlers,
    ImportsHandlers,
    RestoreHandlers,
    ReviewsHandlers,
    SettingsHandlers,
  ]),
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Restore.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(RpcSerialization.layerJson),
)

const assetRoute = (env: Env) =>
  HttpRouter.add('*', '/*', (request) =>
    HttpServerRequest.toWeb(request).pipe(
      Effect.flatMap((web) => Effect.promise(() => env.ASSETS.fetch(web))),
      Effect.map(HttpServerResponse.fromWeb),
    ),
  )

const appLayer = (env: Env) =>
  Layer.mergeAll(healthRoute, apiRoutes, assetRoute(env)).pipe(
    Layer.provideMerge(SqlLive(env.DB)),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  )

/** The bindings are an argument of `fetch`, so the handler closes over them
 *  rather than a module-scoped layer. Build it per request and never cache it
 *  across requests: it owns I/O created inside the first request, which
 *  Cloudflare forbids reusing from another request, and Effect hits the same
 *  limit (Effect-TS/effect#6319, effect-smol#2179). A cached handler hangs under
 *  workerd when a cold isolate's first request is not an RPC call (for example
 *  `GET /api/health`), and every later RPC call then fails with "Worker's code
 *  had hung". The rebuild costs about a millisecond of CPU. */
const handlerFor = (env: Env): ((request: Request) => Promise<Response>) =>
  HttpRouter.toWebHandler(appLayer(env), { disableLogger: true }).handler

const isMedia = (pathname: string): boolean =>
  pathname === MEDIA_PATH || pathname.startsWith(`${MEDIA_PATH}/`)

/** One JSON line for Workers Logs. Carries the method and path only: never
 *  headers, query strings, bodies, or the failure's message, which may quote content. */
const logFailure = (request: Request, url: URL, error: unknown): void => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'unhandled request failure',
      method: request.method,
      path: url.pathname,
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (isMedia(url.pathname)) return await mediaResponse(env.MEDIA, request, url)
      return await handlerFor(env)(request)
    } catch (error) {
      logFailure(request, url, error)
      return new Response('Internal Server Error', { status: 500 })
    }
  },
}
