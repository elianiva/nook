/**
 * The app shell's Model and Message (the TEA core).
 *
 * This is the only screen that exists so far. The first real feature replaces
 * it, but it keeps the `model` / `commands` / `update` / `view` split that
 * every later screen follows.
 *
 * `online` is an `Option` because the health check is asynchronous: the page
 * boots before the Worker answers, so `None` means "not known yet" rather than
 * "offline".
 */

import { Schema as S } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

export const Model = S.Struct({
  online: S.Option(S.Boolean),
  detail: S.Option(S.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Healthy: { online: S.Boolean },
  Unreachable: { message: S.String },
})
export type Message = typeof Message.Type
