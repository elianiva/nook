import { Context, Effect, Layer, Stream } from 'effect'
import type * as Scope from 'effect/Scope'
import type { AnkiCard, AnkiMediaEntry, AnkiNote } from './AnkiContent'
import type { AnkiDiagnostic } from './AnkiDiagnostic'
import type { AnkiOpenError, AnkiReadError } from './AnkiErrors'
import { AnkiCorruptArchive, AnkiUnsupportedArchive } from './AnkiErrors'
import type { AnkiManifest } from './AnkiManifest'
import {
  countCards,
  countNotes,
  readDecks,
  readNoteTypes,
  readSchemaVersion,
  streamCards,
  streamNotes,
} from './ArchiveReader'
import {
  checkArchiveFormat,
  COLLECTION_ENTRY,
  MEDIA_ENTRY,
  META_ENTRY,
  readMediaIndex,
} from './PackageFormat'
import type { AnkiSqliteSource } from './SqliteArchive'
import { openZip, readCollectionBytes, readMediaBytes, readZipEntry } from './ZipArchive'

export type { AnkiSqliteSource }

/** A Media file, with the SHA-1 the archive declares beside its bytes. */
export interface OpenedMedia {
  readonly name: string
  readonly bytes: Uint8Array
  readonly checksum: string
}

/**
 * An opened archive, ready to read.
 *
 * The manifest answers how big the archive is without reading it. Notes, Cards,
 * and Media stream, one item at a time, so an archive of any size imports
 * without holding all of it at once. Diagnostics never stop a read: the handle
 * collects what the reader worked around so the caller can decide what to tell
 * the Learner.
 */
export interface OpenedArchive {
  readonly manifest: Effect.Effect<AnkiManifest, AnkiReadError>
  readonly notes: Stream.Stream<AnkiNote, AnkiReadError>
  readonly cards: Stream.Stream<AnkiCard, AnkiReadError>
  readonly media: Stream.Stream<OpenedMedia, AnkiReadError>
  readonly diagnostics: Effect.Effect<ReadonlyArray<AnkiDiagnostic>, never>
}

/** Opens an `.apkg` archive and hands back a handle that reads it. */
export class AnkiArchive extends Context.Service<
  AnkiArchive,
  {
    /** Reads `archive` and returns a handle over its Notes, Cards, and Media. */
    readonly open: (archive: Blob) => Effect.Effect<OpenedArchive, AnkiOpenError, Scope.Scope>
  }
>()('nook/anki/AnkiArchive') {}

/** The oldest schema nook reads. Anki 2.1.50 wrote schema 11. */
const SCHEMA_OLDEST = 11

/** The newest schema nook knows. Anki 25.02 writes schema 18. */
const SCHEMA_NEWEST = 18

const tooOld = new AnkiUnsupportedArchive({
  reason: 'schemaTooOld',
  message:
    'This Anki export is older than nook reads. In Anki, open the deck with a recent version, then export it again.',
})

const tooNew = new AnkiUnsupportedArchive({
  reason: 'schemaTooNew',
  message:
    'This Anki export is newer than nook knows. Update nook, or export the deck again from the version of Anki you normally use.',
})

const missingCollection = new AnkiCorruptArchive({
  reason: 'missingCollection',
  message:
    'This Anki export is damaged: its collection database is missing. Export it again from Anki.',
})

const notADatabase = new AnkiCorruptArchive({
  reason: 'notADatabase',
  message:
    'This Anki export is damaged: its collection database does not open. Export it again from Anki.',
})

const badMediaIndex = new AnkiCorruptArchive({
  reason: 'integrity',
  message:
    'This Anki export is damaged: its media index does not parse. Export it again from Anki.',
})

/**
 * `col.ver`, checked against the schemas nook knows.
 *
 * Schemas 12 and 13 never shipped in an export: Anki used them as migration
 * snapshots while upgrading, so meeting one means the database is mid-migration
 * rather than readable. Anything below 11 predates the `notetypes` tables the
 * reader needs, and anything above 18 may hold columns the reader does not know.
 */
const checkSchemaVersion = (version: number): Effect.Effect<number, AnkiUnsupportedArchive> => {
  if (version === 12 || version === 13) {
    return Effect.fail(tooNew)
  }
  if (version < SCHEMA_OLDEST) {
    return Effect.fail(tooOld)
  }
  if (version > SCHEMA_NEWEST) {
    return Effect.fail(tooNew)
  }
  return Effect.succeed(version)
}

/** Fails with the refusal when the format check says no. */
const requireFormat = (meta: Uint8Array | undefined): Effect.Effect<number, AnkiOpenError> =>
  checkArchiveFormat(meta)

/** Parses the Media index, refusing an index that is not one. The protobuf walk and the row decode both fail in the error channel. */
const requireMediaIndex = (
  bytes: Uint8Array,
): Effect.Effect<ReadonlyArray<AnkiMediaEntry>, AnkiOpenError> =>
  readMediaIndex(bytes).pipe(
    Effect.mapError((error): AnkiOpenError =>
      error instanceof AnkiCorruptArchive ? error : badMediaIndex,
    ),
  )

/** Builds the service over one SQLite source. Worker and node differ only here. */
export const layer = (source: AnkiSqliteSource): Layer.Layer<AnkiArchive, AnkiOpenError> =>
  Layer.effect(
    AnkiArchive,
    Effect.sync(() => {
      const open = (archive: Blob): Effect.Effect<OpenedArchive, AnkiOpenError, Scope.Scope> =>
        Effect.gen(function* () {
          const zip = yield* openZip(archive)
          yield* requireFormat(yield* readZipEntry(zip, META_ENTRY))
          const collectionEntry = yield* readZipEntry(zip, COLLECTION_ENTRY)
          if (collectionEntry === undefined) {
            return yield* Effect.fail(missingCollection)
          }
          const collectionBytes = yield* readCollectionBytes(collectionEntry)
          const mediaEntry = yield* readZipEntry(zip, MEDIA_ENTRY)
          const mediaIndex =
            mediaEntry === undefined
              ? []
              : yield* requireMediaIndex(yield* readMediaBytes(mediaEntry))

          const sql = yield* source(collectionBytes)

          const schemaVersion = yield* readSchemaVersion(sql).pipe(
            Effect.mapError((): AnkiOpenError => notADatabase),
            Effect.flatMap(checkSchemaVersion),
          )

          const manifest: Effect.Effect<AnkiManifest, AnkiReadError> = Effect.gen(function* () {
            const [noteTypes, decks, noteCount, cardCount] = yield* Effect.all(
              [readNoteTypes(sql), readDecks(sql), countNotes(sql), countCards(sql)],
              { concurrency: 'unbounded' },
            )
            return {
              schemaVersion,
              noteTypes: [...noteTypes],
              decks: [...decks],
              media: [...mediaIndex],
              noteCount,
              cardCount,
              mediaCount: mediaIndex.length,
              mediaBytes: mediaIndex.reduce((total, entry) => total + entry.bytes, 0),
            }
          })

          // A zip read after open is a damaged archive, not a crash: map the
          // zip-reader failure into the read-error channel as missing bytes.
          const media: Stream.Stream<OpenedMedia, AnkiReadError> = Stream.fromIterable(
            mediaIndex,
          ).pipe(
            Stream.mapEffect((entry) =>
              readZipEntry(zip, entry.entry).pipe(
                Effect.mapError((error): AnkiReadError => error),
                Effect.map((bytes) => ({
                  name: entry.name,
                  bytes: bytes ?? new Uint8Array(0),
                  checksum: entry.checksum,
                })),
              ),
            ),
          )

          return {
            manifest,
            notes: streamNotes(sql),
            cards: streamCards(sql),
            media,
            diagnostics: Effect.succeed([]),
          }
        })
      return AnkiArchive.of({ open })
    }),
  )
