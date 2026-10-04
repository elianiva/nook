/**
 * Subscriptions: the running Import.
 *
 * A Command answers with one Message, so the stream of progress a Learner
 * watches while an Import runs comes from here instead. This subscription owns
 * the Import worker's lifetime: it starts one when the Import becomes active,
 * turns each event the worker posts into a Message, and terminates the worker
 * when the Import leaves that state. Because the worker pushes its counts after
 * every batch, the app never polls.
 *
 * The worker reads the archive from IndexedDB, so the Model carries no Blob.
 * If the archive is gone, the subscription ends quietly; the Import panel still
 * shows the last counts the Model holds.
 */

import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'
import { ImportId } from '@nook/api'
import { loadImportJob } from '@/lib/import-jobs'
import type { ImportWorkerEvent } from '@/lib/import-worker-protocol'
import { Message } from './model'
import type { Model } from './model'

/** One worker event, as the Message it becomes. */
export const toMessages = (event: ImportWorkerEvent): ReadonlyArray<Message> => {
  switch (event.type) {
    case 'phase':
      return [Message.ImportWorkerPhase({ phase: event.phase })]
    case 'progress':
      return [Message.ReportedImport({ progress: event.progress })]
    case 'done':
      return [Message.CompletedImport({ progress: event.progress })]
    case 'failed':
      return [Message.FailedImport({ error: event.error })]
  }
}

/**
 * Starts the Import worker for `id` and streams its events.
 *
 * The archive comes from IndexedDB rather than the Model. When it is missing,
 * the stream ends without starting a worker. The finalizer terminates the
 * worker when the subscription tears down, which is also how a run is
 * cancelled: the cursors in D1 make the next run pick up where this one
 * stopped.
 */
const streamImport = (id: ImportId): Stream.Stream<Message, never> =>
  Stream.callback<Message>((queue) =>
    Effect.gen(function* () {
      const job = yield* loadImportJob().pipe(Effect.catch(() => Effect.succeed(Option.none())))
      if (Option.isNone(job)) {
        Queue.endUnsafe(queue)
        return
      }

      const worker = new Worker(new URL('../import-worker.ts', import.meta.url), {
        type: 'module',
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => worker.terminate()))

      worker.onmessage = (event: MessageEvent<ImportWorkerEvent>) => {
        for (const message of toMessages(event.data)) Queue.offerUnsafe(queue, message)
        if (event.data.type === 'done' || event.data.type === 'failed') Queue.endUnsafe(queue)
      }
      worker.onerror = () => {
        Queue.offerUnsafe(
          queue,
          Message.FailedImport({ error: 'The import stopped unexpectedly. Try again.' }),
        )
        Queue.endUnsafe(queue)
      }

      worker.postMessage({ type: 'run', id, filename: job.value.filename, blob: job.value.blob })
    }),
  )

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  importRun: entry(
    { importId: Schema.Option(ImportId), active: Schema.Boolean },
    {
      // Only the id and the active flag matter here. The phase moves on every
      // progress tick, and keying on it would tear the worker down mid-run.
      modelToDependencies: (model) => ({
        importId: model.importState.id,
        active: model.importState.active,
      }),
      dependenciesToStream: ({ importId, active }) =>
        active && Option.isSome(importId) ? streamImport(importId.value) : Stream.empty,
    },
  ),
}))
