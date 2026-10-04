/**
 * Commands: one request each, whose answer comes back as a Message.
 *
 * Navigation lives here; fetch/save Commands live in `api-commands`. Every
 * Command answers with a result Message, failure included, rather than a
 * thrown error.
 */

import { Effect } from 'effect'
import { Command, Navigation, Url } from 'foldkit'
import { Message } from './model'

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Url.Url },
  messages: [Message.CompletedNavigate],
  execute: ({ url }) =>
    Navigation.pushUrl(Url.toString(url)).pipe(Effect.as(Message.CompletedNavigate())),
})
