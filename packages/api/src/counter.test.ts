import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { CounterService, CounterServiceLive, type CounterKv } from './counter'

const memoryKv = (): CounterKv => {
  const store = new Map<string, string>()
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value)
    },
  }
}

const run = <A, E>(kv: CounterKv, effect: Effect.Effect<A, E, CounterService>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, CounterServiceLive(kv)))

describe('CounterService', () => {
  it('reads zero from an empty namespace', async () => {
    expect(
      await run(
        memoryKv(),
        CounterService.use((service) => service.get),
      ),
    ).toBe(0)
  })

  it('keeps a change across service instances', async () => {
    const kv = memoryKv()
    await run(
      kv,
      CounterService.use((service) => service.change(1)),
    )
    await run(
      kv,
      CounterService.use((service) => service.change(1)),
    )
    expect(
      await run(
        kv,
        CounterService.use((service) => service.get),
      ),
    ).toBe(2)
  })

  it('resets to zero', async () => {
    const kv = memoryKv()
    await run(
      kv,
      CounterService.use((service) => service.change(5)),
    )
    await run(
      kv,
      CounterService.use((service) => service.reset),
    )
    expect(
      await run(
        kv,
        CounterService.use((service) => service.get),
      ),
    ).toBe(0)
  })

  it('treats a corrupt stored value as zero', async () => {
    const kv = memoryKv()
    await kv.put('count', 'not-a-number')
    expect(
      await run(
        kv,
        CounterService.use((service) => service.get),
      ),
    ).toBe(0)
  })
})
