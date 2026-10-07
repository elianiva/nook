/**
 * Import worker: read an `.apkg` archive and stream what it holds into D1, off
 * the main thread.
 *
 * The reader needs a SQLite engine, which only the browser has, so the archive
 * never reaches the server. The worker reports each step to the app as it goes,
 * which is what makes the progress bar live: every written batch answers with
 * the Worker's own counts, and the worker forwards that answer straight to the
 * app instead of the app polling for it.
 *
 * Rows travel through the shared RPC client; Media files stay plain HTTP PUTs
 * because they are binary, not procedures.
 *
 * The app starts this worker when an Import becomes active and terminates it
 * when the Import leaves that state. Terminating mid-run is safe: the cursors
 * in D1 are the commit point, so the next run resumes from them.
 */

import { Effect, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { AnkiArchive, AnkiSqliteMemory, layer as ankiLayer } from '@nook/anki'
import type { AnkiManifest, OpenedMedia } from '@nook/anki'
import type {
  ImportBatchPayload as ImportBatch,
  ImportManifest,
  ImportStart as ImportStartPayload,
} from '@nook/api'
import type {
  ImportPreview,
  ImportProgress,
  ImportReadStage,
  ImportWorkerCommand,
  ImportWorkerEvent,
} from './lib/import-worker-protocol'
import { MEDIA_PATH } from './lib/api'
import { NookRpc } from './lib/rpc'

/** How many Notes or Cards ride in one request. Each row is one SQLite statement. */
const ROWS_PER_REQUEST = 200

/** How many Media files upload per progress tick. Media is heavier than a row. */
const MEDIA_PER_REQUEST = 4

/** As much of the worker global scope as this module uses. */
type WorkerScope = {
  postMessage: (event: ImportWorkerEvent) => void
  onmessage: ((event: MessageEvent<ImportWorkerCommand>) => void) | null
}

const scope = self as unknown as WorkerScope

const post = (event: ImportWorkerEvent): void => scope.postMessage(event)

/** Anki joins a Deck's components with a unit separator; nook shows them with `::`. */
const deckName = (deck: AnkiManifest['decks'][number]): string => deck.components.join('::')

const toManifest = (manifest: AnkiManifest): ImportManifest => ({
  schemaVersion: manifest.schemaVersion,
  noteTypes: [...manifest.noteTypes],
  decks: manifest.decks.map((deck) => ({
    id: deck.id,
    name: deckName(deck),
    description: deck.description,
  })),
  noteCount: manifest.noteCount,
  cardCount: manifest.cardCount,
  mediaCount: manifest.mediaCount,
})

/** What the detail panel shows, read without reading a Note or a Card. */
const toPreview = (manifest: AnkiManifest): ImportPreview => ({
  schemaVersion: manifest.schemaVersion,
  noteCount: manifest.noteCount,
  cardCount: manifest.cardCount,
  mediaCount: manifest.mediaCount,
  mediaBytes: manifest.mediaBytes,
  decks: manifest.decks.map((deck) => ({ id: deck.id, name: deckName(deck) })),
  noteTypes: manifest.noteTypes.map((noteType) => ({
    id: noteType.id,
    name: noteType.name,
    kind: noteType.kind,
    templateCount: noteType.templates.length,
  })),
})

/** The counts the panel shows, as plain data a `postMessage` can carry. */
const toProgress = (
  status: {
    notesImported: number
    cardsImported: number
    noteCount: number
    cardCount: number
    mediaCount: number
  },
  mediaImported: number,
): ImportProgress => ({
  notesImported: status.notesImported,
  cardsImported: status.cardsImported,
  mediaImported,
  noteCount: status.noteCount,
  cardCount: status.cardCount,
  mediaCount: status.mediaCount,
})

/** Uploads one Media file. The name is the archive's own, so a re-upload overwrites. */
const putMedia = (client: HttpClient.HttpClient, file: OpenedMedia) =>
  client
    .execute(
      HttpClientRequest.put(`${MEDIA_PATH}/${encodeURIComponent(file.name)}`).pipe(
        HttpClientRequest.bodyUint8Array(file.bytes, 'application/octet-stream'),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid)

/** The sentences an Anki error carries are written for the Learner; anything else is not. */
const toSentence = (error: unknown): string => {
  const tag =
    typeof error === 'object' && error !== null && '_tag' in error
      ? String((error as { _tag: unknown })._tag)
      : ''
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? (error as { message: unknown }).message
      : undefined
  if (tag.startsWith('Anki') && typeof message === 'string') return message
  return 'Could not import that archive. Check the connection and try again.'
}

/** Forwards the reader's open steps to the app as they happen. */
const reportStage = (stage: ImportReadStage): void => post({ type: 'readStage', stage })

/** Reads the archive and answers what it holds, writing nothing. */
const runPreview = (
  command: Extract<ImportWorkerCommand, { type: 'preview' }>,
): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* AnkiArchive
      const opened = yield* archive.open(command.blob, reportStage)
      const manifest = yield* opened.manifest
      post({ type: 'preview', preview: toPreview(manifest) })
    }),
  ).pipe(
    Effect.provide(ankiLayer(AnkiSqliteMemory.source)),
    Effect.catch((error) => Effect.sync(() => post({ type: 'failed', error: toSentence(error) }))),
  )

/** Reads the archive and writes it, reporting every step to the app. */
const runImport = (command: Extract<ImportWorkerCommand, { type: 'run' }>): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      post({ type: 'phase', phase: 'reading' })
      const archive = yield* AnkiArchive
      const rpc = yield* NookRpc
      const client = yield* HttpClient.HttpClient

      const opened = yield* archive.open(command.blob, reportStage)
      const read = yield* opened.manifest
      const manifest = toManifest(read)
      // An excluded Media choice rewrites the denominator, so progress still
      // reaches 100: the archive carries files the run never writes.
      const manifestForRun: ImportManifest = command.includeMedia
        ? manifest
        : { ...manifest, mediaCount: 0 }
      const startPayload: ImportStartPayload = {
        id: command.id,
        filename: command.filename,
        manifest: manifestForRun,
      }
      const started = yield* rpc.importsStart(startPayload)

      post({ type: 'phase', phase: 'writing' })

      // The last counts the Worker answered with, so a Media tick reports
      // progress without another round trip.
      let last = started
      let mediaImported = 0
      const report = (): void =>
        post({ type: 'progress', progress: toProgress(last, mediaImported) })
      report()

      // The Import already finished on an earlier run: there is nothing to
      // write, and the cursors say so.
      if (started.status === 'done') {
        post({ type: 'done', progress: toProgress(started, mediaImported) })
        return
      }

      const writeBatch = (batch: ImportBatch) =>
        rpc.importsWriteBatch({ importId: command.id, batch }).pipe(
          Effect.tap((status) =>
            Effect.sync(() => {
              last = status
              report()
            }),
          ),
        )

      // Notes first, then Cards: a Card names the Note it renders, and writing
      // the Notes in their own stream keeps each cursor a clean high-water mark.
      yield* opened.notes.pipe(
        Stream.filter((note) => note.id > started.notesCursor),
        Stream.grouped(ROWS_PER_REQUEST),
        Stream.runForEach((notes) => writeBatch({ notes: Array.from(notes), cards: [] })),
      )
      yield* opened.cards.pipe(
        Stream.filter((card) => card.id > started.cardsCursor),
        Stream.grouped(ROWS_PER_REQUEST),
        Stream.runForEach((cards) => writeBatch({ notes: [], cards: Array.from(cards) })),
      )

      // Media last, one file per request: a Card renders without its audio, but
      // a half-written Note cannot. A re-run overwrites, so a retry is safe.
      // Excluded Media never uploads: Cards render without their files.
      if (command.includeMedia) {
        yield* opened.media.pipe(
          Stream.grouped(MEDIA_PER_REQUEST),
          Stream.runForEach((group) => {
            const files = Array.from(group)
            return Effect.forEach(files, (file) => putMedia(client, file), {
              concurrency: 1,
              discard: true,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  mediaImported += files.length
                  report()
                }),
              ),
            )
          }),
        )
      }

      const status = yield* rpc.importsComplete({ importId: command.id })
      post({ type: 'done', progress: toProgress(status, mediaImported) })
    }),
  ).pipe(
    // The read is scoped, so the archive's zip reader and its SQLite database
    // close when the run ends, however it ends.
    Effect.provide(ankiLayer(AnkiSqliteMemory.source)),
    Effect.provide(NookRpc.layer),
    Effect.provide(FetchHttpClient.layer),
    // Last, because providing the reader's layer is itself declared to fail:
    // the handler needs its own client, since the one above is out of
    // scope here.
    Effect.catch((error) =>
      Effect.gen(function* () {
        const sentence = toSentence(error)
        const rpc = yield* NookRpc
        // Record the reason in D1 so a reload still shows why the run stopped.
        // Failing to record it must not replace the failure the Learner sees.
        yield* rpc
          .importsFail({ importId: command.id, error: sentence })
          .pipe(Effect.catch(() => Effect.void))
        post({ type: 'failed', error: sentence })
      }).pipe(Effect.provide(NookRpc.layer), Effect.provide(FetchHttpClient.layer)),
    ),
  )

scope.onmessage = (event: MessageEvent<ImportWorkerCommand>) => {
  const command = event.data
  if (command.type !== 'preview' && command.type !== 'run') return
  const run =
    command.type === 'preview'
      ? runPreview(command)
      : runImport({ ...command, includeMedia: command.includeMedia ?? true })
  Effect.runPromise(run).catch(() =>
    post({ type: 'failed', error: 'The import stopped unexpectedly. Try again.' }),
  )
}
