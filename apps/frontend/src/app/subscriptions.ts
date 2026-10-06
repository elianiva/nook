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
    case 'readStage':
      return [Message.ReportedImportReadStage({ stage: event.stage })]
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

  networkOnline: entry(
    { listening: Schema.Boolean },
    {
      modelToDependencies: () => ({ listening: true }),
      dependenciesToStream: () =>
        Subscription.fromEvent({
          target: () => window,
          type: 'online',
          // Grades flush through the existing handler, which also refreshes the
          // shown queries behind them.
          mapEvent: () => Message.RegainedNetwork(),
        }),
    },
  ),

  /**
   * A tab left open goes stale: returning to it refreshes the shown queries.
   * Only the visible transition emits — hiding the tab starts nothing.
   */
  tabVisible: entry(
    { listening: Schema.Boolean },
    {
      modelToDependencies: () => ({ listening: true }),
      dependenciesToStream: () =>
        Subscription.fromEventFilterMap({
          target: () => document,
          type: 'visibilitychange',
          filterMapEvent: () =>
            document.visibilityState === 'visible'
              ? Option.some(Message.RevalidateVisible())
              : Option.none(),
        }),
    },
  ),

  /**
   * The worker posts `nook:sw-update` when a newer shell waits. The update
   * banner offers the reload; the learner takes it outside review.
   */
  swUpdate: entry(
    { listening: Schema.Boolean },
    {
      modelToDependencies: () => ({ listening: true }),
      dependenciesToStream: () =>
        Subscription.fromEvent({
          target: () => window as Subscription.TypedEventTarget<{ 'nook:sw-update': CustomEvent }>,
          type: 'nook:sw-update',
          mapEvent: () => Message.ServiceWorkerAvailable(),
        }),
    },
  ),

  /**
   * Review shortcuts: Space or Enter reveals, then grades Good; 1–4 grade
   * directly. Grading is one tap on a phone, but a keyboard makes it faster.
   */
  reviewKeys: entry(
    { onReview: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        onReview: model.route._tag === 'Review' || model.route._tag === 'ReviewDeck',
      }),
      dependenciesToStream: ({ onReview }) =>
        onReview
          ? Subscription.keyBindings<Message>({
              bindings: [
                { keys: 'Space', mapEvent: () => Message.PressedSpace() },
                { keys: 'Enter', mapEvent: () => Message.PressedSpace() },
                { keys: '1', mapEvent: () => Message.PressedGrade({ grade: 'Again' }) },
                { keys: '2', mapEvent: () => Message.PressedGrade({ grade: 'Hard' }) },
                { keys: '3', mapEvent: () => Message.PressedGrade({ grade: 'Good' }) },
                { keys: '4', mapEvent: () => Message.PressedGrade({ grade: 'Easy' }) },
              ],
            })
          : Stream.empty,
    },
  ),
}))
