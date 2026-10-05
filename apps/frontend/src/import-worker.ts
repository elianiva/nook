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
 * The app starts this worker when an Import becomes active and terminates it
 * when the Import leaves that state. Terminating mid-run is safe: the cursors
 * in D1 are the commit point, so the next run resumes from them.
 */

import { Effect, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { AnkiArchive, AnkiSqliteMemory, layer as ankiLayer } from '@nook/anki'
import type { AnkiManifest, OpenedMedia } from '@nook/anki'
import { ImportBatchPayload, ImportFailure, ImportId, ImportStart, ImportStatus } from '@nook/api'
import type {
  ImportBatchPayload as ImportBatch,
  ImportManifest,
  ImportStart as ImportStartPayload,
} from '@nook/api'
import type {
  ImportProgress,
  ImportWorkerCommand,
  ImportWorkerEvent,
} from './lib/import-worker-protocol'

/** How many Notes or Cards ride in one request. Each row is one SQLite statement. */
const ROWS_PER_REQUEST = 200

/** How many Media files upload per progress tick. Media is heavier than a row. */
const MEDIA_PER_REQUEST = 4

const IMPORTS_URL = '/api/imports'
const MEDIA_URL = '/api/media'

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

/** The counts the panel shows, as plain data a `postMessage` can carry. */
const toProgress = (status: ImportStatus, mediaImported: number): ImportProgress => ({
  notesImported: status.notesImported,
  cardsImported: status.cardsImported,
  mediaImported,
  noteCount: status.noteCount,
  cardCount: status.cardCount,
  mediaCount: status.mediaCount,
})

const startRequest = (body: ImportStartPayload) =>
  HttpClientRequest.post(IMPORTS_URL).pipe(HttpClientRequest.schemaBodyJson(ImportStart)(body))

const batchRequest = (id: ImportId, body: ImportBatch) =>
  HttpClientRequest.post(`${IMPORTS_URL}/${encodeURIComponent(id)}/batch`).pipe(
    HttpClientRequest.schemaBodyJson(ImportBatchPayload)(body),
  )

const failRequest = (id: ImportId, body: { readonly error: string }) =>
  HttpClientRequest.post(`${IMPORTS_URL}/${encodeURIComponent(id)}/fail`).pipe(
    HttpClientRequest.schemaBodyJson(ImportFailure)(body),
  )

const completeRequest = (id: ImportId) =>
  Effect.succeed(HttpClientRequest.post(`${IMPORTS_URL}/${encodeURIComponent(id)}/complete`))

/** Sends a request and decodes the `ImportStatus` that comes back. */
const send = <E, R>(
  client: HttpClient.HttpClient,
  request: Effect.Effect<HttpClientRequest.HttpClientRequest, E, R>,
) =>
  request.pipe(
    Effect.flatMap((built) => client.execute(built)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ImportStatus)),
  )

/** Uploads one Media file. The name is the archive's own, so a re-upload overwrites. */
const putMedia = (client: HttpClient.HttpClient, file: OpenedMedia) =>
  client
    .execute(
      HttpClientRequest.put(`${MEDIA_URL}/${encodeURIComponent(file.name)}`).pipe(
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

/** Reads the archive and writes it, reporting every step to the app. */
const runImport = (command: ImportWorkerCommand): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      post({ type: 'phase', phase: 'reading' })
      const archive = yield* AnkiArchive
      const client = yield* HttpClient.HttpClient

      const opened = yield* archive.open(command.blob)
      const manifest = yield* opened.manifest
      const started = yield* send(
        client,
        startRequest({
          id: command.id,
          filename: command.filename,
          manifest: toManifest(manifest),
        }),
      )

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
        send(client, batchRequest(command.id, batch)).pipe(
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

      const status = yield* send(client, completeRequest(command.id))
      post({ type: 'done', progress: toProgress(status, mediaImported) })
    }),
  ).pipe(
    // The read is scoped, so the archive's zip reader and its SQLite database
    // close when the run ends, however it ends.
    Effect.provide(ankiLayer(AnkiSqliteMemory.source)),
    Effect.provide(FetchHttpClient.layer),
    // Last, because providing the reader's layer is itself declared to fail:
    // the handler needs its own HttpClient, since the one above is out of
    // scope here.
    Effect.catch((error) =>
      Effect.gen(function* () {
        const sentence = toSentence(error)
        const client = yield* HttpClient.HttpClient
        // Record the reason in D1 so a reload still shows why the run stopped.
        // Failing to record it must not replace the failure the Learner sees.
        yield* send(client, failRequest(command.id, { error: sentence })).pipe(
          Effect.catch(() => Effect.void),
        )
        post({ type: 'failed', error: sentence })
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  )

scope.onmessage = (event) => {
  if (event.data.type !== 'run') return
  Effect.runPromise(runImport(event.data)).catch(() =>
    post({ type: 'failed', error: 'The import stopped unexpectedly. Try again.' }),
  )
}
