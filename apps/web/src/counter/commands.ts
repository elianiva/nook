/**
 * The counter's Commands: each is one RPC call whose answer comes back as a
 * Message. The `Effect` from `@/lib/rpc` has no requirements, so a Command can
 * run it directly.
 */

import { Effect, Schema as S } from 'effect'
import { Command } from 'foldkit'
import { changeCounter, getCounter, resetCounter } from '@/lib/rpc'
import { Message } from './model'

export const LoadCounter = Command.define('LoadCounter', {
  messages: [Message.Loaded, Message.Failed],
  execute: getCounter().pipe(
    Effect.map((state) => Message.Loaded({ count: state.count })),
    Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))),
  ),
})

export const ChangeCounter = Command.define('ChangeCounter', {
  args: { delta: S.Number },
  messages: [Message.Changed, Message.Failed],
  execute: ({ delta }) =>
    changeCounter(delta).pipe(
      Effect.map((state) => Message.Changed({ count: state.count })),
      Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))),
    ),
})

export const ResetCounter = Command.define('ResetCounter', {
  messages: [Message.Changed, Message.Failed],
  execute: resetCounter().pipe(
    Effect.map((state) => Message.Changed({ count: state.count })),
    Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))),
  ),
})
