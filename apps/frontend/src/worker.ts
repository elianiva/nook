/**
 * The Worker entry `Cloudflare.Website.Foldkit` bundles and uploads.
 *
 * It owns `/api/*`: a liveness probe on `/api/health` today, and the RPC
 * endpoint on `/api/rpc` once the first contract exists. Every other request
 * goes to the static asset binding, which serves the Foldkit client build and
 * its `index.html` fallback for client routes.
 */

import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { HEALTH_PATH } from './lib/api'

/** The static asset binding, as much of it as this Worker uses. */
type Assets = {
  fetch(request: Request): Promise<Response>
}

type Env = {
  ASSETS: Assets
}

const healthRoute = HttpRouter.add('GET', HEALTH_PATH, () => HttpServerResponse.json({ ok: true }))

const assetRoute = (env: Env, request: Request) =>
  HttpRouter.add('*', '/*', () =>
    Effect.promise(() => env.ASSETS.fetch(request)).pipe(Effect.map(HttpServerResponse.fromWeb)),
  )

const appLayer = (env: Env, request: Request) =>
  Layer.mergeAll(healthRoute, assetRoute(env, request)).pipe(Layer.provideMerge(HttpRouter.layer))

/** Built per request: the bindings are an argument of `fetch`, so the route
 *  handlers close over them rather than a module-scoped layer. */
const handlerFor = (env: Env, request: Request) =>
  HttpRouter.toWebHandler(appLayer(env, request), { disableLogger: true }).handler

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handlerFor(env, request)(request)
  },
}
