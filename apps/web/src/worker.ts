/**
 * The Worker entry `Cloudflare.Website.Foldkit` bundles and uploads.
 *
 * It owns `/api/*`: the counter RPC on `/api/rpc` and a liveness probe on
 * `/api/health`. Every other request is handed to the static asset binding,
 * which serves the Foldkit client build (and its `index.html` fallback for
 * client routes). The asset layer already routes `/api/*` here first, so the
 * fallback below only runs during local dev.
 */

import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { CounterRpcHandlersLive, CounterServiceLive, type CounterKv } from '@nook/api'
import { CounterRpcs } from '@nook/shared'
import { HEALTH_PATH, RPC_PATH } from './lib/api'

/** The static asset binding, as much of it as this Worker uses. */
type Assets = {
  fetch(request: Request): Promise<Response>
}

type Env = {
  COUNTER: CounterKv
  ASSETS: Assets
}

const rpcRoute = (env: Env) =>
  RpcServer.layerHttp({ group: CounterRpcs, path: RPC_PATH, protocol: 'http' }).pipe(
    Layer.provide(CounterRpcHandlersLive),
    Layer.provide(CounterServiceLive(env.COUNTER)),
    Layer.provide(RpcSerialization.layerJson),
  )

const healthRoute = HttpRouter.add('GET', HEALTH_PATH, () => HttpServerResponse.json({ ok: true }))

const assetRoute = (env: Env, request: Request) =>
  HttpRouter.add('*', '/*', () =>
    Effect.promise(() => env.ASSETS.fetch(request)).pipe(Effect.map(HttpServerResponse.fromWeb)),
  )

const appLayer = (env: Env, request: Request) =>
  Layer.mergeAll(rpcRoute(env), healthRoute, assetRoute(env, request)).pipe(
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
