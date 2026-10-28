import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import type * as Statement from 'effect/sql/Statement'
import { ImportId, ImportNotFound, ImportsRpc, StorageUnavailable } from '@nook/api'
import type { ImportCard, ImportManifest, ImportNote, ImportReview, ImportStatus } from '@nook/api'
import { runStatements } from './batch'
import { IMPORTED_REVIEW_PREFIX, replayHistory } from './history'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'
import { CurrentUser } from './users'

/** One row of the `imports` table, as SQLite returns it. */
const ImportRow = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  status: Schema.Literals(['running', 'done', 'failed']),
  notesCursor: Schema.Number,
  cardsCursor: Schema.Number,
  notesImported: Schema.Number,
  cardsImported: Schema.Number,
  includeHistory: Schema.Number,
  reviewsCursor: Schema.Number,
  reviewsImported: Schema.Number,
  noteCount: Schema.Number,
  cardCount: Schema.Number,
  reviewCount: Schema.Number,
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
  includeHistory: row.includeHistory === 1,
  reviewsCursor: row.reviewsCursor,
  reviewsImported: row.reviewsImported,
  noteCount: row.noteCount,
  cardCount: row.cardCount,
  reviewCount: row.reviewCount,
  mediaCount: row.mediaCount,
  error: row.error === null ? Option.none() : Option.some(row.error),
})

/** What an Import start carries. */
export interface StartImport {
  readonly id: ImportId
  readonly filename: string
  readonly manifest: ImportManifest
  /** Opt in to replaying Anki's review history. Defaults to off. */
  readonly includeHistory?: boolean | undefined
}

/**
 * One step of each stream. Any array may be empty: Notes, Cards, and Reviews
 * are separate streams. `reviews` carries whole Cards' histories, by Card.
 */
export interface ImportBatch {
  readonly notes: ReadonlyArray<ImportNote>
  readonly cards: ReadonlyArray<ImportCard>
  readonly reviews?: ReadonlyArray<ImportReview> | undefined
}

/** A Card an Import wrote and may seed, with the Deck's lapse override. */
const SeedableRow = Schema.Struct({ id: Schema.String, lapseMinutes: Schema.NullOr(Schema.Number) })

const SchedulerRow = Schema.Struct({
  weights: Schema.String,
  desiredRetention: Schema.Number,
  maximumInterval: Schema.Number,
  lapseMinutes: Schema.Number,
})

/**
 * Imports read and write the `imports`, `note_types`, `notes`, and `cards`
 * tables through the `SqlClient` the layer closes over, so the service
 * interface carries no requirements — see `Decks` for why.
 *
 * A re-import moves a Note's `import_id` to the new Import, but its Media
 * keeps resolving from the Import that stored the files unless the new Import
 * carries Media of its own (`notes.media_import_id`).
 *
 * Every write is an upsert keyed by Anki's own id, and the cursor advances in
 * the same batch as the rows it counts. A run that dies midway leaves its
 * cursor where it stopped, so the next run continues rather than restarts, and
 * re-importing the same archive overwrites rather than duplicates.
 *
 * History is a third stream, off unless the Import opted in. Each batch holds
 * whole Cards' histories; the replay (`history.ts`) turns one Card's history
 * into its FSRS state and its Review rows, so retrying a batch rewrites the
 * same rows. A Card is seeded only when this Import owns it and no Review was
 * graded in nook: seeding must never overwrite the Learner's own progress.
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
      const { id: userId } = yield* CurrentUser

      const read = (id: ImportId): Effect.Effect<ImportStatus | undefined, StorageUnavailable> =>
        Effect.gen(function* () {
          // Progress is counted from the rows this Import owns, in the same
          // query that reads its cursors, so the two can never disagree.
          const rows = yield* sql`SELECT id, filename, status, notes_cursor AS "notesCursor",
            cards_cursor AS "cardsCursor",
            (SELECT COUNT(*) FROM notes WHERE import_id = imports.id AND user_id = imports.user_id) AS "notesImported",
            (SELECT COUNT(*) FROM cards WHERE import_id = imports.id AND user_id = imports.user_id) AS "cardsImported",
            include_history AS "includeHistory", reviews_cursor AS "reviewsCursor",
            (SELECT COUNT(*) FROM reviews WHERE import_id = imports.id AND user_id = imports.user_id) AS "reviewsImported",
            note_count AS "noteCount", card_count AS "cardCount", review_count AS "reviewCount",
            media_count AS "mediaCount", error
            FROM imports WHERE id = ${id} AND user_id = ${userId}`
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
          // The choice sticks to the Import: a run resumed after a reload asks
          // without it, and must not drop history the first run began.
          const includeHistory = input.includeHistory === true || existing?.includeHistory === true
          const historyFlag = includeHistory ? 1 : 0
          const reviewCount = includeHistory ? (manifest.reviewCount ?? 0) : 0

          // Decks and Note Types come first: a Note or Card references them, and
          // they are identical for every run of the same archive.
          yield* runStatements([
            ...manifest.decks.map(
              (
                deck,
              ) => sql`INSERT INTO decks (user_id, id, name, description) VALUES (${userId}, ${String(deck.id)}, ${deck.name}, ${deck.description})
                ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = datetime('now')`,
            ),
            ...manifest.noteTypes.map(
              (
                noteType,
              ) => sql`INSERT INTO note_types (user_id, id, name, kind, sort_field_ord, css, fields, templates)
                VALUES (${userId}, ${String(noteType.id)}, ${noteType.name}, ${noteType.kind}, ${noteType.sortFieldOrd}, ${noteType.css}, ${JSON.stringify(noteType.fields)}, ${JSON.stringify(noteType.templates)})
                ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
                  sort_field_ord = excluded.sort_field_ord, css = excluded.css,
                  fields = excluded.fields, templates = excluded.templates, updated_at = datetime('now')`,
            ),
          ])

          if (existing === undefined) {
            yield* sql`INSERT INTO imports (user_id, id, filename, status, note_count, card_count, media_count,
              include_history, review_count)
              VALUES (${userId}, ${id}, ${filename}, 'running', ${manifest.noteCount}, ${manifest.cardCount},
              ${manifest.mediaCount}, ${historyFlag}, ${reviewCount})`
          } else if (existing.status === 'done' && includeHistory && !existing.includeHistory) {
            // The same archive, imported again to add its history. Notes and
            // Cards already landed and their cursors stay, so the run only has
            // the Reviews left to write.
            yield* sql`UPDATE imports SET filename = ${filename}, status = 'running', error = NULL,
              include_history = 1, reviews_cursor = 0, review_count = ${reviewCount},
              updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`
          } else if (
            (manifest.noteCount > 0 || manifest.cardCount > 0) &&
            existing.notesImported === 0 &&
            existing.cardsImported === 0
          ) {
            // A run that finished without owning a row: the Decks landed but
            // no Note or Card did, so the cursors describe nothing. Reopen the
            // run from the beginning instead of resuming past every row, which
            // would finish `done` with nothing written a second time.
            yield* sql`UPDATE imports SET filename = ${filename}, status = 'running', error = NULL,
              notes_cursor = 0, cards_cursor = 0, reviews_cursor = 0,
              include_history = ${historyFlag}, review_count = ${reviewCount},
              note_count = ${manifest.noteCount}, card_count = ${manifest.cardCount},
              media_count = ${manifest.mediaCount},
              updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`
          } else if (existing.status !== 'done') {
            // A run that was interrupted keeps its cursors: this is what lets
            // the same Import continue instead of starting over.
            yield* sql`UPDATE imports SET filename = ${filename}, status = 'running', error = NULL,
              include_history = ${historyFlag}, review_count = ${reviewCount},
              note_count = ${manifest.noteCount}, card_count = ${manifest.cardCount},
              media_count = ${manifest.mediaCount},
              updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`
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

      /**
       * The statements that seed one batch of Cards from their history.
       *
       * Reviews of a Card this Import did not write (Anki keeps the log of
       * deleted Cards) or that the Learner has graded in nook are dropped.
       */
      const historyStatements = (id: ImportId, reviews: ReadonlyArray<ImportReview>) =>
        Effect.gen(function* () {
          if (reviews.length === 0) {
            return { statements: [] as Array<Statement.Statement<unknown>>, lastCardId: 0 }
          }

          const byCard = new Map<number, Array<ImportReview>>()
          for (const review of reviews) {
            const bucket = byCard.get(review.cardId)
            if (bucket === undefined) byCard.set(review.cardId, [review])
            else bucket.push(review)
          }

          // `json_each` keeps the lookup at one bound parameter: D1 caps a
          // statement at 100, and a batch can name hundreds of Cards.
          const seedable = yield* decodeRows(
            SeedableRow,
            yield* sql`SELECT c.id AS id, d.lapse_minutes AS "lapseMinutes"
              FROM cards c JOIN decks d ON d.id = c.deck_id AND d.user_id = c.user_id
              WHERE c.user_id = ${userId} AND c.import_id = ${id}
                AND c.id IN (SELECT value FROM json_each(${JSON.stringify([...byCard.keys()].map(String))}))
                AND NOT EXISTS (SELECT 1 FROM reviews r
                  WHERE r.user_id = c.user_id AND r.card_id = c.id AND r.id NOT LIKE ${IMPORTED_REVIEW_PREFIX + '%'})`,
          )
          const settingsRows = yield* decodeRows(
            SchedulerRow,
            yield* sql`SELECT fsrs_weights AS weights, fsrs_desired_retention AS "desiredRetention",
              fsrs_maximum_interval AS "maximumInterval", fsrs_lapse_minutes AS "lapseMinutes"
              FROM settings WHERE user_id = ${userId}`,
          )
          const settings = settingsRows[0]
          if (settings === undefined) {
            return yield* new StorageUnavailable({
              message:
                'Could not read the scheduler settings. The settings store is missing its row.',
            })
          }
          const scheduler = {
            weights: settings.weights.split(',').map(Number),
            desiredRetention: settings.desiredRetention,
            maximumInterval: settings.maximumInterval,
          }

          const statements: Array<Statement.Statement<unknown>> = []
          for (const row of seedable) {
            const replay = replayHistory(
              byCard.get(Number(row.id)) ?? [],
              scheduler,
              row.lapseMinutes ?? settings.lapseMinutes,
            )
            if (replay === undefined) continue
            for (const step of replay.reviews) {
              statements.push(
                sql`INSERT INTO reviews (user_id, id, card_id, grade, reviewed_at, state_after, stability_after,
                  difficulty_after, due_in_days_after, due_at_after, import_id)
                  VALUES (${userId}, ${step.id}, ${step.cardId}, ${step.grade}, ${step.reviewedAt}, ${step.state},
                  ${step.stability}, ${step.difficulty}, ${step.dueInDays}, ${step.dueAt}, ${id})
                  ON CONFLICT (user_id, id) DO UPDATE SET grade = excluded.grade, reviewed_at = excluded.reviewed_at,
                    state_after = excluded.state_after, stability_after = excluded.stability_after,
                    difficulty_after = excluded.difficulty_after,
                    due_in_days_after = excluded.due_in_days_after,
                    due_at_after = excluded.due_at_after, import_id = excluded.import_id`,
              )
            }
            const card = replay.card
            statements.push(
              sql`UPDATE cards SET state = ${card.state}, stability = ${card.stability},
                difficulty = ${card.difficulty}, due_in_days = ${card.dueInDays}, due_at = ${card.dueAt},
                reps = ${card.reps}, lapses = ${card.lapses}, review_lapses = ${card.reviewLapses},
                last_reviewed_at = ${card.lastReviewedAt}, introduced_day = ${card.introducedDay},
                buried_until = NULL, buried_sibling_of = NULL, updated_at = datetime('now')
                WHERE id = ${row.id} AND user_id = ${userId}`,
            )
          }
          return { statements, lastCardId: Math.max(...byCard.keys()) }
        })

      const writeBatch = (
        id: ImportId,
        batch: ImportBatch,
      ): Effect.Effect<ImportStatus, ImportNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const current = yield* status(id)

          let notesCursor = current.notesCursor
          const noteStatements = batch.notes.map((note) => {
            if (note.id > notesCursor) notesCursor = note.id
            return sql`INSERT INTO notes (user_id, id, note_type_id, guid, fields, tags, modified, import_id)
              VALUES (${userId}, ${String(note.id)}, ${String(note.noteTypeId)}, ${note.guid}, ${JSON.stringify(note.fields)}, ${JSON.stringify(note.tags)}, ${note.modified}, ${id})
              ON CONFLICT (user_id, id) DO UPDATE SET note_type_id = excluded.note_type_id, guid = excluded.guid,
                fields = excluded.fields, tags = excluded.tags, modified = excluded.modified,
                import_id = excluded.import_id,
                media_import_id = CASE
                  WHEN (SELECT media_count FROM imports WHERE id = excluded.import_id AND user_id = excluded.user_id) > 0 THEN NULL
                  ELSE COALESCE(notes.media_import_id, notes.import_id)
                END,
                updated_at = datetime('now')`
          })

          let cardsCursor = current.cardsCursor
          const cardStatements = batch.cards.map((card) => {
            if (card.id > cardsCursor) cardsCursor = card.id
            return sql`INSERT INTO cards (user_id, id, deck_id, note_id, template_ord, suspended, flag,
              due_in_days, stability, difficulty, state, import_id)
              VALUES (${userId}, ${String(card.id)}, ${String(card.deckId)}, ${String(card.noteId)}, ${card.templateOrd},
              ${card.suspended ? 1 : 0}, ${card.flag}, 0, 0, 1, 'new', ${id})
              ON CONFLICT (user_id, id) DO UPDATE SET deck_id = excluded.deck_id, note_id = excluded.note_id,
                template_ord = excluded.template_ord, suspended = excluded.suspended, flag = excluded.flag,
                import_id = excluded.import_id, updated_at = datetime('now')`
          })

          // Reviews are ignored unless the Import opted in, so a client that
          // sends them anyway cannot seed state the Learner declined.
          const historyReviews = current.includeHistory ? (batch.reviews ?? []) : []
          const history = yield* historyStatements(id, historyReviews)
          const reviewsCursor = Math.max(current.reviewsCursor, history.lastCardId)

          // The cursor moves in the same batch as the rows it just wrote, and
          // it is the only thing that has to be durable for the run to resume.
          yield* runStatements([
            ...noteStatements,
            ...cardStatements,
            ...history.statements,
            sql`UPDATE imports SET notes_cursor = ${notesCursor}, cards_cursor = ${cardsCursor},
              reviews_cursor = ${reviewsCursor},
              updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`,
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
          yield* sql`UPDATE imports SET status = 'done', error = NULL, updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`
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
          // The message is client-supplied and may quote Card content: log the id only.
          yield* Effect.logWarning('import failed').pipe(Effect.annotateLogs({ importId: id }))
          yield* sql`UPDATE imports SET status = 'failed', error = ${error}, updated_at = datetime('now') WHERE id = ${id} AND user_id = ${userId}`
          return yield* status(id)
        }).pipe(Effect.withSpan('Imports.fail'), (self) =>
          withStorageErrorPassThrough(self, 'record the import failure'),
        )

      return Imports.of({ start, writeBatch, complete, fail, get: status })
    }),
  )
}

export const ImportsHandlers = ImportsRpc.toLayer(
  Effect.gen(function* () {
    const imports = yield* Imports
    return ImportsRpc.of({
      importsStart: (payload) => imports.start(payload),
      importsWriteBatch: ({ importId, batch }) => imports.writeBatch(importId, batch),
      importsComplete: ({ importId }) => imports.complete(importId),
      importsFail: ({ importId, error }) => imports.fail(importId, error),
      importsGet: ({ importId }) => imports.get(importId),
    })
  }),
)
