/**
 * The app shell's update core: message → model transition, plus `init`.
 *
 * `init` runs the first health check as a Command. Every message folds back
 * into the model, and no Command can fail the program: a transport problem
 * arrives as `Unreachable`, not as a thrown error.
 */

import { Option } from 'effect'
import type { Update } from 'foldkit'
import { CheckHealth } from './commands'
import { Message } from './model'
import type { Model } from './model'

export const init = (): Update.Return<Model, Message> => ({
  model: {
    online: Option.none(),
    detail: Option.none(),
  },
  commands: [CheckHealth()],
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Healthy: ({ online }) => ({
      model: { online: Option.some(online), detail: Option.none() },
    }),
    Unreachable: ({ message }) => ({
      model: { ...model, online: Option.some(false), detail: Option.some(message) },
    }),
  })
