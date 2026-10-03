/**
 * The counter's durable state, backed by one Cloudflare KV key.
 *
 * KV has no atomic increment, so `change` is a read-modify-write. That is
 * deliberate for this template: the counter is a proof that server-side state
 * survives a reload, not a linearizable counter. Swap `CounterServiceLive` for
 * a Durable Object or D1 when the increment has to be atomic.
 */

import { Context, Effect, Layer } from 'effect'
import { CounterStorageError } from '@nook/shared'

const COUNTER_KEY = 'count'

/** The slice of the Workers KV binding the counter uses. Structural, so the
 *  tests can pass an in-memory object without the Workers runtime types. */
export type CounterKv = {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** KV stores text; anything that is not a finite number reads as zero. */
const parseCount = (value: string | null): number => {
  if (value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const readCount = (kv: CounterKv): Effect.Effect<number, CounterStorageError> =>
  Effect.tryPromise({
    try: () => kv.get(COUNTER_KEY),
    catch: (cause) => new CounterStorageError({ message: describeCause(cause) }),
  }).pipe(Effect.map(parseCount))

const writeCount = (kv: CounterKv, value: number): Effect.Effect<void, CounterStorageError> =>
  Effect.tryPromise({
    try: () => kv.put(COUNTER_KEY, String(value)),
    catch: (cause) => new CounterStorageError({ message: describeCause(cause) }),
  })

export class CounterService extends Context.Service<
  CounterService,
  {
    readonly get: Effect.Effect<number, CounterStorageError>
    readonly change: (delta: number) => Effect.Effect<number, CounterStorageError>
    readonly reset: Effect.Effect<number, CounterStorageError>
  }
>()('nook/CounterService') {}

export const CounterServiceLive = (kv: CounterKv): Layer.Layer<CounterService> =>
  Layer.succeed(CounterService, {
    get: readCount(kv),
    change: (delta) =>
      Effect.gen(function* () {
        const current = yield* readCount(kv)
        const next = current + delta
        yield* writeCount(kv, next)
        return next
      }),
    reset: Effect.gen(function* () {
      yield* writeCount(kv, 0)
      return 0
    }),
  })
