/**
 * The app shell's Commands. Each is one request whose answer comes back as a
 * Message. The Effects here have no requirements, so a Command can run one
 * directly.
 */

import { Effect } from 'effect'
import { Command } from 'foldkit'
import { HEALTH_PATH } from '@/lib/api'
import { Message } from './model'

const checkHealth = Effect.tryPromise({
  try: () => fetch(HEALTH_PATH).then((response) => response.ok),
  catch: (error) => (error instanceof Error ? error.message : String(error)),
})

export const CheckHealth = Command.define('CheckHealth', {
  messages: [Message.Healthy, Message.Unreachable],
  execute: checkHealth.pipe(
    Effect.map((online) => Message.Healthy({ online })),
    Effect.catch((message) => Effect.succeed(Message.Unreachable({ message }))),
  ),
})
