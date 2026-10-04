/**
 * Subscriptions: the running Import's progress, read from the Worker.
 *
 * A Command answers with one Message, so the stream of processing a Learner
 * watches while an Import runs comes from here instead. The Worker holds the
 * durable counts — Notes and Cards written so far — and this polls them while
 * an Import is in flight. When the Import finishes or fails, `importState.id`
 * goes back to `None` and the stream tears down.
 */

import { Effect, Option, Result, Schedule, Schema, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { Http, Subscription } from 'foldkit'
import { ImportId, ImportStatus } from '@nook/api'
import { Message } from './model'
import type { Model } from './model'

/** Often enough to look live, rarely enough to leave the Worker alone. */
const POLL_INTERVAL = '400 millis'

/** Reads the Import's status, or fails quietly when the Worker cannot answer this tick. */
const pollImport = (id: ImportId): Effect.Effect<Result.Result<ImportStatus, void>, never> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(`/api/imports/${encodeURIComponent(id)}`)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ImportStatus)),
    Effect.map(Result.succeed),
    Effect.catch(() => Effect.succeed(Result.fail<void>(undefined))),
    Effect.provide(Http.layer),
  )

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  importProgress: entry(
    { importId: Schema.Option(ImportId) },
    {
      modelToDependencies: (model) => ({ importId: model.importState.id }),
      dependenciesToStream: ({ importId }) =>
        Option.match(importId, {
          onNone: () => Stream.empty,
          onSome: (id) =>
            Stream.fromEffectSchedule(pollImport(id), Schedule.spaced(POLL_INTERVAL)).pipe(
              // A tick the Worker could not answer is skipped, not shown.
              Stream.filterMap((status) => status),
              // A finished Import needs no more ticks; the Model tears the
              // stream down anyway, and this keeps the last tick the last one.
              Stream.takeWhile((status) => status.status !== 'done'),
              Stream.map((status) => Message.PolledImport({ status })),
            ),
        }),
    },
  ),
}))
