import { Context, Effect, Layer, Option, Schema } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import * as Sql from 'effect/sql/SqlClient'
import { Api, ImportId, ImportNotFound, StorageUnavailable } from '@nook/api'
import type { ImportCard, ImportManifest, ImportNote, ImportStatus } from '@nook/api'
import { runStatements } from './batch'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'

/** One row of the `imports` table, as SQLite returns it. */
const ImportRow = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  status: Schema.Literals(['running', 'done', 'failed']),
  notesCursor: Schema.Number,
  cardsCursor: Schema.Number,
  notesImported: Schema.Number,
  cardsImported: Schema.Number,
  noteCount: Schema.Number,
  cardCount: Schema.Number,
  mediaCount: Schema.Number,
  error: Schema.NullOr(Schema.String),
})

const toStatus = (row: typeof ImportRow.Type): ImportStatus => ({
  id: ImportId.make(row.id),
  filename: row.filename,
  status: row.status,
  notesCursor: row.notesCursor,
  cardsCursor: row.cardsCursor,
  notesImported: row.notesImported,
  cardsImported: row.cardsImported,
  noteCount: row.noteCount,
  cardCount: row.cardCount,
  mediaCount: row.mediaCount,
  error: row.error === null ? Option.none() : Option.some(row.error),
})

/** What an Import start carries. */
export interface StartImport {
  readonly id: ImportId
  readonly filename: string
  readonly manifest: ImportManifest
}

/** One step of each stream. Either array may be empty: Notes and Cards are separate streams. */
export interface ImportBatch {
  readonly notes: ReadonlyArray<ImportNote>
  readonly cards: ReadonlyArray<ImportCard>
}

/**
 * Imports read and write the `imports`, `note_types`, `notes`, and `cards`
 * tables through the `SqlClient` the layer closes over, so the service
 * interface carries no requirements — see `Decks` for why.
 *
 * Every write is an upsert keyed by Anki's own id, and the cursor advances in
 * the same batch as the rows it counts. A run that dies midway leaves its
 * cursor where it stopped, so the next run continues rather than restarts, and
 * re-importing the same archive overwrites rather than duplicates.
 *
 * Multi-statement writes go through one D1 `batch` when the driver offers one
 * (ADR 0003), and run in order otherwise — the node driver the tests use has
 * no batch. Either way the cursor is the commit point, and the statements
 * before it are idempotent, so a half-landed batch is repaired by the next
 * attempt.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry). An id no Import answers to is a 404 `ImportNotFound`.
 */
export class Imports extends Context.Service<
  Imports,
  {
    start(input: StartImport): Effect.Effect<ImportStatus, StorageUnavailable>
    writeBatch(
      id: ImportId,
      batch: ImportBatch,
    ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable>
    complete(id: ImportId): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable>
    fail(
      id: ImportId,
      error: string,
    ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable>
    get(id: ImportId): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable>
  }
>()('nook/backend/Imports') {
  static readonly layer = Layer.effect(
    Imports,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const read = (id: ImportId): Effect.Effect<ImportStatus | undefined, StorageUnavailable> =>
        Effect.gen(function* () {
          // Progress is counted from the rows this Import owns, in the same
          // query that reads its cursors, so the two can never disagree.
          const rows = yield* sql`SELECT id, filename, status, notes_cursor AS "notesCursor",
            cards_cursor AS "cardsCursor",
            (SELECT COUNT(*) FROM notes WHERE import_id = imports.id) AS "notesImported",
            (SELECT COUNT(*) FROM cards WHERE import_id = imports.id) AS "cardsImported",
            note_count AS "noteCount", card_count AS "cardCount",
            media_count AS "mediaCount", error
            FROM imports WHERE id = ${id}`
          const decoded = yield* decodeRows(ImportRow, rows)
          const row = decoded[0]
          return row === undefined ? undefined : toStatus(row)
        }).pipe(Effect.withSpan('Imports.read'), (self) =>
          withStorageErrorPassThrough(self, 'read the import'),
        )

      const status = (
        id: ImportId,
      ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const found = yield* read(id)
          if (found === undefined) return yield* new ImportNotFound({ importId: id })
          return found
        })

      const start = (input: StartImport): Effect.Effect<ImportStatus, StorageUnavailable> =>
        Effect.gen(function* () {
          const { id, filename, manifest } = input
          const existing = yield* read(id)

          // Decks and Note Types come first: a Note or Card references them, and
          // they are identical for every run of the same archive.
          yield* runStatements([
            ...manifest.decks.map(
              (
                deck,
              ) => sql`INSERT INTO decks (id, name, description) VALUES (${String(deck.id)}, ${deck.name}, ${deck.description})
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = datetime('now')`,
            ),
            ...manifest.noteTypes.map(
              (
                noteType,
              ) => sql`INSERT INTO note_types (id, name, kind, sort_field_ord, css, fields, templates)
                VALUES (${String(noteType.id)}, ${noteType.name}, ${noteType.kind}, ${noteType.sortFieldOrd}, ${noteType.css}, ${JSON.stringify(noteType.fields)}, ${JSON.stringify(noteType.templates)})
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
                  sort_field_ord = excluded.sort_field_ord, css = excluded.css,
                  fields = excluded.fields, templates = excluded.templates, updated_at = datetime('now')`,
            ),
          ])

          if (existing === undefined) {
            yield* sql`INSERT INTO imports (id, filename, status, note_count, card_count, media_count)
              VALUES (${id}, ${filename}, 'running', ${manifest.noteCount}, ${manifest.cardCount},
              ${manifest.mediaCount})`
          } else if (existing.status !== 'done') {
            // A run that was interrupted keeps its cursors: this is what lets
            // the same Import continue instead of starting over.
            yield* sql`UPDATE imports SET filename = ${filename}, status = 'running', error = NULL,
              note_count = ${manifest.noteCount}, card_count = ${manifest.cardCount},
              media_count = ${manifest.mediaCount},
              updated_at = datetime('now') WHERE id = ${id}`
          }

          // The row was written above, so a missing one is a storage problem,
          // not a 404 the caller should handle.
          const written = yield* read(id)
          if (written === undefined) {
            return yield* new StorageUnavailable({
              message: 'Could not start the import. Its row is missing after writing it.',
            })
          }
          return written
        }).pipe(Effect.withSpan('Imports.start'), (self) =>
          withStorageErrorPassThrough(self, 'start the import'),
        )

      const writeBatch = (
        id: ImportId,
        batch: ImportBatch,
      ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const current = yield* status(id)

          let notesCursor = current.notesCursor
          const noteStatements = batch.notes.map((note) => {
            if (note.id > notesCursor) notesCursor = note.id
            return sql`INSERT INTO notes (id, note_type_id, guid, fields, tags, modified, import_id)
              VALUES (${String(note.id)}, ${String(note.noteTypeId)}, ${note.guid}, ${JSON.stringify(note.fields)}, ${JSON.stringify(note.tags)}, ${note.modified}, ${id})
              ON CONFLICT (id) DO UPDATE SET note_type_id = excluded.note_type_id, guid = excluded.guid,
                fields = excluded.fields, tags = excluded.tags, modified = excluded.modified,
                import_id = excluded.import_id, updated_at = datetime('now')`
          })

          let cardsCursor = current.cardsCursor
          const cardStatements = batch.cards.map((card) => {
            if (card.id > cardsCursor) cardsCursor = card.id
            return sql`INSERT INTO cards (id, deck_id, note_id, template_ord, suspended, flag,
              due_in_days, stability, difficulty, state, import_id)
              VALUES (${String(card.id)}, ${String(card.deckId)}, ${String(card.noteId)}, ${card.templateOrd},
              ${card.suspended ? 1 : 0}, ${card.flag}, 0, 0, 1, 'new', ${id})
              ON CONFLICT (id) DO UPDATE SET deck_id = excluded.deck_id, note_id = excluded.note_id,
                template_ord = excluded.template_ord, suspended = excluded.suspended, flag = excluded.flag,
                import_id = excluded.import_id, updated_at = datetime('now')`
          })

          // The cursor moves in the same batch as the rows it just wrote, and
          // it is the only thing that has to be durable for the run to resume.
          yield* runStatements([
            ...noteStatements,
            ...cardStatements,
            sql`UPDATE imports SET notes_cursor = ${notesCursor}, cards_cursor = ${cardsCursor},
              updated_at = datetime('now') WHERE id = ${id}`,
          ])

          return yield* status(id)
        }).pipe(Effect.withSpan('Imports.writeBatch'), (self) =>
          withStorageErrorPassThrough(self, 'write the import batch'),
        )

      const complete = (
        id: ImportId,
      ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          yield* status(id)
          yield* sql`UPDATE imports SET status = 'done', error = NULL, updated_at = datetime('now') WHERE id = ${id}`
          return yield* status(id)
        }).pipe(Effect.withSpan('Imports.complete'), (self) =>
          withStorageErrorPassThrough(self, 'finish the import'),
        )

      const fail = (
        id: ImportId,
        error: string,
      ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          yield* status(id)
          yield* sql`UPDATE imports SET status = 'failed', error = ${error}, updated_at = datetime('now') WHERE id = ${id}`
          return yield* status(id)
        }).pipe(Effect.withSpan('Imports.fail'), (self) =>
          withStorageErrorPassThrough(self, 'record the import failure'),
        )

      return Imports.of({ start, writeBatch, complete, fail, get: status })
    }),
  )
}

export const ImportsHandlers = HttpApiBuilder.group(Api, 'imports', (handlers) =>
  Effect.gen(function* () {
    const imports = yield* Imports
    return handlers.handleAll({
      start: ({ payload }) => imports.start(payload),
      writeBatch: ({ params, payload }) => imports.writeBatch(params.importId, payload),
      complete: ({ params }) => imports.complete(params.importId),
      fail: ({ params, payload }) => imports.fail(params.importId, payload.error),
      get: ({ params }) => imports.get(params.importId),
    })
  }),
)
