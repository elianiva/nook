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
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { Api } from '@nook/api'
import {
  Decks,
  DecksHandlers,
  Home,
  HomeHandlers,
  Imports,
  ImportsHandlers,
  Reviews,
  ReviewsHandlers,
  Settings,
  SettingsHandlers,
  SqlLive,
} from '@nook/backend'
import { HEALTH_PATH, MEDIA_PATH, RPC_PATH } from './lib/api'

/** The static asset binding, as much of it as this Worker uses. */
type Assets = {
  fetch(request: Request): Promise<Response>
}

/**
 * The slice of the R2 binding this Worker uses.
 *
 * It is typed with the DOM's `ReadableStream`/`Headers` rather than the Workers
 * types, which do not line up with `lib.dom`. The binding is the same object at
 * runtime; only the type differs.
 */
type MediaObject = {
  body: ReadableStream
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

type MediaBucket = {
  get(key: string): Promise<MediaObject | null>
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
}

type Env = {
  ASSETS: Assets
  DB: D1Database
  MEDIA: MediaBucket
}

const healthRoute = HttpRouter.add('GET', HEALTH_PATH, () => HttpServerResponse.json({ ok: true }))

const apiRoutes = RpcServer.layerHttp({ group: Api, path: RPC_PATH, protocol: 'http' }).pipe(
  Layer.provide([DecksHandlers, HomeHandlers, ImportsHandlers, ReviewsHandlers, SettingsHandlers]),
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(RpcSerialization.layerJson),
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

/**
 * Media is a Card's images and audio, keyed by the name the archive used.
 *
 * The Import writes each file with a PUT and the review screen reads it back
 * with a GET. Objects are immutable — a Media name identifies one file — so
 * they are cached hard.
 */
const mediaResponse = async (env: Env, request: Request, url: URL): Promise<Response> => {
  const name = decodeURIComponent(url.pathname.slice(MEDIA_PATH.length + 1))
  if (name === '') return new Response('Not found', { status: 404 })

  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await env.MEDIA.get(name)
    if (object === null) return new Response('Not found', { status: 404 })
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    return new Response(object.body, { headers })
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? 'application/octet-stream'
    await env.MEDIA.put(name, request.body, { httpMetadata: { contentType } })
    return new Response(null, { status: 204 })
  }

  return new Response('Method not allowed', { status: 405 })
}

const isMedia = (pathname: string): boolean =>
  pathname === MEDIA_PATH || pathname.startsWith(`${MEDIA_PATH}/`)

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (isMedia(url.pathname)) return mediaResponse(env, request, url)
    return handlerFor(env, request)(request)
  },
}
