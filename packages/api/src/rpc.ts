/**
 * The RPC handlers: translate the wire payloads from `@nook/shared` into
 * `CounterService` calls and back into `CounterState`. Visibility and
 * storage rules stay in the service.
 */

import { Effect } from 'effect'
import { CounterRpcs } from '@nook/shared'
import { CounterService } from './counter'

export const CounterRpcHandlersLive = CounterRpcs.toLayer({
  GetCounter: () =>
    CounterService.use((service) => service.get).pipe(Effect.map((count) => ({ count }))),
  ChangeCounter: ({ delta }) =>
    CounterService.use((service) => service.change(delta)).pipe(Effect.map((count) => ({ count }))),
  ResetCounter: () =>
    CounterService.use((service) => service.reset).pipe(Effect.map((count) => ({ count }))),
})
