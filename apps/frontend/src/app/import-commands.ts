/**
 * Import Commands: read an `.apkg` archive in the browser and stream what it
 * holds into the Worker, one batch at a time.
 *
 * The reader runs here, not in the Worker, because it needs a SQLite engine:
 * workerd ships `node:sqlite` as a stub that cannot open a database, and the
 * wasm engine locates its `.wasm` from its own module URL, which only a browser
 * serves. The archive's bytes therefore never cross the network — only the
 * Notes and Cards read out of it do.
 *
 * `PrepareImport` picks the file and hashes it. The hash is the Import's id, so
 * the same archive always lands on the same Import and a second run resumes
 * from the cursors `start` returns. `RunImport` reads the archive, writes the
 * manifest, streams Notes then Cards, and marks the Import done. A failure is a
 * Message, never a thrown error, and it records itself in D1 so the cursors and
 * the reason survive a page reload.
 */

import { Effect, Option, Stream } from 'effect'
import { Command, File, Http } from 'foldkit'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { AnkiArchive, AnkiSqliteMemory, layer as ankiLayer, toHex } from '@nook/anki'
import type { AnkiManifest } from '@nook/anki'
import { ImportBatchPayload, ImportFailure, ImportId, ImportStart, ImportStatus } from '@nook/api'
import type {
  ImportBatchPayload as ImportBatch,
  ImportManifest,
  ImportStart as ImportStartPayload,
} from '@nook/api'
import { Message } from './model'

/** How many Notes or Cards ride in one request. Each row is one SQLite statement. */
const ROWS_PER_REQUEST = 200

const IMPORTS_URL = '/api/imports'

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

export const PrepareImport = Command.define('PrepareImport', {
  messages: [Message.GotImportFile, Message.CancelledImportSelect, Message.FailedImport],
  execute: Effect.gen(function* () {
    const picked = yield* File.select(['.apkg'])
    if (Option.isNone(picked)) return Message.CancelledImportSelect()
    const file = picked.value

    const read = yield* File.readAsArrayBuffer(file).pipe(Effect.result)
    if (read._tag === 'Failure') {
      return Message.FailedImport({ error: 'Could not read that file. Pick it again.' })
    }

    const digest = yield* Effect.promise(() => crypto.subtle.digest('SHA-256', read.success))
    return Message.GotImportFile({ file, id: ImportId.make(toHex(new Uint8Array(digest))) })
  }),
})

export const RunImport = Command.define('RunImport', {
  args: { file: File.File, id: ImportId },
  messages: [Message.CompletedImport, Message.FailedImport],
  execute: ({ file, id }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const buffer = yield* File.readAsArrayBuffer(file)
        const archive = yield* AnkiArchive
        const client = yield* HttpClient.HttpClient

        const opened = yield* archive.open(new Blob([buffer]))
        const manifest = yield* opened.manifest
        const started = yield* send(
          client,
          startRequest({ id, filename: file.name, manifest: toManifest(manifest) }),
        )

        const writeBatch = (batch: ImportBatch) => send(client, batchRequest(id, batch))

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

        const status = yield* send(client, completeRequest(id))
        return Message.CompletedImport({ status })
      }),
    ).pipe(
      // The read is scoped, so the archive's zip reader and its SQLite database
      // close when the run ends, however it ends.
      Effect.provide(ankiLayer(AnkiSqliteMemory.source)),
      Effect.provide(Http.layer),
      // Last, because providing the reader's layer is itself declared to fail:
      // the handler needs its own HttpClient, since the one above is out of
      // scope here.
      Effect.catch((error) =>
        Effect.gen(function* () {
          const sentence = toSentence(error)
          const client = yield* HttpClient.HttpClient
          // Record the reason in D1 so a reload still shows why the run stopped.
          // Failing to record it must not replace the failure the Learner sees.
          yield* send(client, failRequest(id, { error: sentence })).pipe(
            Effect.catch(() => Effect.void),
          )
          return Message.FailedImport({ error: sentence })
        }).pipe(Effect.provide(Http.layer)),
      ),
    ),
})
