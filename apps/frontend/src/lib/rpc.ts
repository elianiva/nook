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

import { Context, Layer } from 'effect'
import { RpcClient, RpcClientError, RpcSerialization } from 'effect/rpc'
import { Http } from 'foldkit'
import { Api } from '@nook/api'
import { RPC_PATH } from './api'

export class NookRpc extends Context.Service<
  NookRpc,
  RpcClient.FromGroup<typeof Api, RpcClientError.RpcClientError>
>()('nook/frontend/NookRpc') {
  static readonly layer = Layer.effect(NookRpc, RpcClient.make(Api)).pipe(
    Layer.provide(RpcClient.layerProtocolHttp({ url: RPC_PATH })),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(Http.layer),
  )
}
