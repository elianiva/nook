/**
 * The browser's RPC client: one typed handle for every procedure the Worker
 * serves.
 *
 * The layer posts to the Worker's RPC route over the fetch-backed `HttpClient`
 * the `Http` layer provides, and speaks the same JSON serialization. Commands
 * and Queries call through `NookRpc` and get back the procedure's declared
 * success or typed error — no URL building, no status checks, no response
 * decoding at the call site.
 */

import { Context, Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { RpcClient, RpcClientError, RpcSerialization } from 'effect/rpc'
import { Http } from 'foldkit'
import { Api } from '@nook/api'
import { RPC_PATH } from './api'

/** What the browser should do when Access rejects or redirects an RPC call. */
export type AccessAuthenticationAction =
  | { readonly _tag: 'reload' }
  | { readonly _tag: 'redirect'; readonly url: string }

export const getAccessAuthenticationAction = (
  requestUrl: string,
  responseUrl: string,
  status: number,
  appOrigin: string,
): AccessAuthenticationAction | null => {
  if (responseUrl !== '') {
    const requested = new URL(requestUrl, appOrigin)
    const resolved = new URL(responseUrl, appOrigin)
    if (requested.origin !== resolved.origin || requested.pathname !== resolved.pathname) {
      return { _tag: 'redirect', url: resolved.href }
    }
  }

  return status === 401 || status === 403 ? { _tag: 'reload' } : null
}

export class NookRpc extends Context.Service<
  NookRpc,
  RpcClient.FromGroup<typeof Api, RpcClientError.RpcClientError>
>()('nook/frontend/NookRpc') {
  static readonly layer = Layer.effect(NookRpc, RpcClient.make(Api)).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url: RPC_PATH,
        transformClient: (client) =>
          HttpClient.transformResponse(client, (response) =>
            response.pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (typeof window !== 'undefined') {
                    const action = getAccessAuthenticationAction(
                      result.request.url,
                      result.url,
                      result.status,
                      window.location.origin,
                    )
                    if (action?._tag === 'redirect') window.location.assign(action.url)
                    else if (action?._tag === 'reload') window.location.reload()
                  }
                }),
              ),
            ),
          ),
      }),
    ),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(Http.layer),
  )
}
