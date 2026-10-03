/**
 * The counter RPC contract — the one description both the Worker and the
 * browser typecheck against. `CounterRpcs` is the group the Worker mounts at
 * `/api/rpc` and the browser client calls.
 */

import { Schema as S } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

/** The counter's whole state: the durable value. */
export const CounterState = S.Struct({
  count: S.Number,
})
export type CounterState = typeof CounterState.Type

/** A KV read or write failed. Storage is infrastructure, not user input. */
export class CounterStorageError extends S.TaggedError<CounterStorageError>()(
  'CounterStorageError',
  {
    message: S.String,
  },
) {}

/** Read the durable count. */
export class GetCounter extends Rpc.make('GetCounter', {
  payload: {},
  success: CounterState,
  error: CounterStorageError,
}) {}

/** Add `delta` to the durable count and answer the new value. */
export class ChangeCounter extends Rpc.make('ChangeCounter', {
  payload: {
    delta: S.Number.pipe(S.check(S.isBetween({ minimum: -10, maximum: 10 }))),
  },
  success: CounterState,
  error: CounterStorageError,
}) {}

/** Set the durable count back to zero. */
export class ResetCounter extends Rpc.make('ResetCounter', {
  payload: {},
  success: CounterState,
  error: CounterStorageError,
}) {}

export const CounterRpcs = RpcGroup.make(GetCounter, ChangeCounter, ResetCounter)
