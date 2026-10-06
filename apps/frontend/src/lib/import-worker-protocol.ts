/**
 * The Import worker's protocol: the messages the app sends it and the events
 * it sends back.
 *
 * The worker reads the archive and writes it to D1, so the app never touches
 * the archive's bytes. Keeping the two message shapes in one module lets the
 * app and the worker agree on them without importing each other.
 *
 * Every value here is plain data. A `postMessage` clones its payload, and an
 * Effect `Option` carries its tag on non-enumerable fields, so an `Option`
 * would arrive empty. The progress event therefore carries the numbers the
 * panel shows rather than an `ImportStatus`.
 */

import { Schema } from 'effect'
import type { ImportId } from '@nook/api'

/** What the app asks the worker to do. There is one job at a time. */
export type ImportWorkerCommand = {
  readonly type: 'run'
  readonly id: ImportId
  readonly filename: string
  readonly blob: Blob
}

/** The two steps the worker reports while it runs. */
export type ImportWorkerPhase = 'reading' | 'writing'

/**
 * Where the read of an archive has reached. The worker forwards the reader's
 * own open steps (`AnkiArchive` names them the same way), so the panel names
 * what the run is doing while a large archive opens instead of holding on one
 * line. `database` is the step a damaged collection fails at; `manifest`
 * counts the Notes and Cards.
 */
export const ImportReadStage = Schema.Literals([
  'opening',
  'listing',
  'collection',
  'mediaIndex',
  'database',
  'manifest',
])
export type ImportReadStage = typeof ImportReadStage.Type

/** The numbers the Import panel shows, as the Worker reports them. */
export const ImportProgress = Schema.Struct({
  notesImported: Schema.Number,
  cardsImported: Schema.Number,
  mediaImported: Schema.Number,
  noteCount: Schema.Number,
  cardCount: Schema.Number,
  mediaCount: Schema.Number,
})
export type ImportProgress = typeof ImportProgress.Type

/** What the worker tells the app. `progress` arrives once per written batch. */
export type ImportWorkerEvent =
  | { readonly type: 'phase'; readonly phase: ImportWorkerPhase }
  | { readonly type: 'readStage'; readonly stage: ImportReadStage }
  | { readonly type: 'progress'; readonly progress: ImportProgress }
  | { readonly type: 'done'; readonly progress: ImportProgress }
  | { readonly type: 'failed'; readonly error: string }
