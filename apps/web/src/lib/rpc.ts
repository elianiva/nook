/**
 * The browser's Effect RPC client for the counter group.
 *
 * The client owns a protocol fiber, so it is built once behind a promise with
 * an explicitly open `Scope` and lives in a long-lived `ManagedRuntime`. The
 * exported functions wrap a call in `Effect.tryPromise`, so the returned
 * `Effect` has no requirements and a Foldkit `Command` can run it as-is.
 */

import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Option, Scope } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcSerialization } from 'effect/rpc'
import { layerProtocolHttp, make as makeRpcClient } from 'effect/rpc/RpcClient'
import { CounterRpcs, type CounterState } from '@nook/shared'
import { RPC_PATH } from './api'

/** Every RPC failure — a declared storage error or a transport problem —
 *  collapses into one message the UI can print. */
export class RpcFailure extends Data.TaggedError('RpcFailure')<{
  readonly message: string
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const failureMessage = (error: unknown): string => {
  if (typeof error === 'string' && error !== '') return error
  if (error instanceof Error && error.message !== '') return error.message
  if (isRecord(error)) {
    const message = error['message']
    if (typeof message === 'string' && message !== '') return message
    const tag = error['_tag']
    if (typeof tag === 'string') return tag
  }
  return String(error)
}

const makeClient = () => makeRpcClient(CounterRpcs)
type CounterClient = Effect.Success<ReturnType<typeof makeClient>>

const protocolLayer = layerProtocolHttp({ url: RPC_PATH }).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerJson),
)

const runtime = ManagedRuntime.make(Layer.empty)
let clientPromise: Promise<CounterClient> | undefined

const getClient = (): Promise<CounterClient> =>
  (clientPromise ??= runtime.runPromise(
    Effect.flatMap(Scope.make(), (scope) =>
      Effect.provideService(makeClient(), Scope.Scope, scope),
    ).pipe(Effect.provide(protocolLayer)),
  ))

const call = <A>(
  run: (client: CounterClient) => Effect.Effect<A, unknown, never>,
): Effect.Effect<A, RpcFailure> =>
  Effect.tryPromise({
    try: async () => {
      const client = await getClient()
      const exit = await runtime.runPromiseExit(run(client))
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause)
        throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
      }
      return exit.value
    },
    catch: (error) => new RpcFailure({ message: failureMessage(error) }),
  })

export const getCounter = (): Effect.Effect<CounterState, RpcFailure> =>
  call((client) => client.GetCounter({}))

export const changeCounter = (delta: number): Effect.Effect<CounterState, RpcFailure> =>
  call((client) => client.ChangeCounter({ delta }))

export const resetCounter = (): Effect.Effect<CounterState, RpcFailure> =>
  call((client) => client.ResetCounter({}))
