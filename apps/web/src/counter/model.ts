/**
 * The counter's Model and Message (the TEA core).
 *
 * `count` is an `Option` because the first read is asynchronous: the page
 * boots before the RPC answers, and `None` is "no value yet" rather than a
 * placeholder zero. `pending` gates the buttons so two changes cannot overlap.
 */

import { Schema as S } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

export const Model = S.Struct({
  count: S.Option(S.Number),
  pending: S.Boolean,
  error: S.Option(S.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  Loaded: { count: S.Number },
  Changed: { count: S.Number },
  Failed: { message: S.String },
  ClickedIncrement: {},
  ClickedDecrement: {},
  ClickedReset: {},
})
export type Message = typeof Message.Type
