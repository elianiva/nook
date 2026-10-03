/**
 * The counter's update core: message → model transition plus init.
 *
 * `init` starts the first read as a Command; the count is `None` until it
 * answers. Every change sets `pending`, so the buttons are disabled while a
 * call is in flight and two changes cannot race.
 */

import { Option } from 'effect'
import type { Update } from 'foldkit'
import { ChangeCounter, LoadCounter, ResetCounter } from './commands'
import { Message } from './model'
import type { Model } from './model'

export const init = (): Update.Return<Model, Message> => ({
  model: {
    count: Option.none(),
    pending: true,
    error: Option.none(),
  },
  commands: [LoadCounter()],
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    Loaded: ({ count }) => ({
      model: { ...model, count: Option.some(count), pending: false, error: Option.none() },
    }),
    Changed: ({ count }) => ({
      model: { ...model, count: Option.some(count), pending: false, error: Option.none() },
    }),
    Failed: ({ message }) => ({
      model: { ...model, pending: false, error: Option.some(message) },
    }),
    ClickedIncrement: () => ({
      model: { ...model, pending: true, error: Option.none() },
      commands: [ChangeCounter({ delta: 1 })],
    }),
    ClickedDecrement: () => ({
      model: { ...model, pending: true, error: Option.none() },
      commands: [ChangeCounter({ delta: -1 })],
    }),
    ClickedReset: () => ({
      model: { ...model, pending: true, error: Option.none() },
      commands: [ResetCounter()],
    }),
  })
