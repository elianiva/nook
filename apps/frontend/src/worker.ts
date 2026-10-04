/**
 * The Worker entry `Cloudflare.Website.Foldkit` bundles and uploads.
 *
 * It owns `/api/*`: a liveness probe plus the HttpApi the browser calls.
 * Every other request goes to the static asset binding, which serves the
 * Foldkit client build and its `index.html` fallback for client routes.
 */

import type { D1Database } from '@cloudflare/workers-types'
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { Api } from '@nook/api'
import {
  Decks,
  DecksHandlers,
  Home,
  HomeHandlers,
  Imports,
  ImportsHandlers,
  Settings,
  SettingsHandlers,
  SqlLive,
} from '@nook/backend'
import { API_PATHS, HEALTH_PATH } from './lib/api'

/** The static asset binding, as much of it as this Worker uses. */
type Assets = {
  fetch(request: Request): Promise<Response>
}

type Env = {
  ASSETS: Assets
  DB: D1Database
}

const healthRoute = HttpRouter.add('GET', HEALTH_PATH, () => HttpServerResponse.json({ ok: true }))

const apiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: API_PATHS.openapi,
}).pipe(
  Layer.provide([DecksHandlers, HomeHandlers, ImportsHandlers, SettingsHandlers]),
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Settings.layer),
)

const assetRoute = (env: Env, request: Request) =>
  HttpRouter.add('*', '/*', () =>
    Effect.promise(() => env.ASSETS.fetch(request)).pipe(Effect.map(HttpServerResponse.fromWeb)),
  )

const appLayer = (env: Env, request: Request) =>
  Layer.mergeAll(healthRoute, apiRoutes, assetRoute(env, request)).pipe(
    Layer.provideMerge(SqlLive(env.DB)),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  )

/** Built per request: the bindings are an argument of `fetch`, so the route
 *  handlers close over them rather than a module-scoped layer. */
const handlerFor = (env: Env, request: Request) =>
  HttpRouter.toWebHandler(appLayer(env, request), { disableLogger: true }).handler

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handlerFor(env, request)(request)
  },
}
