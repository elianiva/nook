/**
 * `Restore` — merge a JSON export back into the collection.
 *
 * The export is the only backup nook has, so restore is its other half. It is
 * a merge, never a replace: it adds what the collection lacks and leaves what
 * it has.
 *
 * - Every row is keyed by the id the export carries. A Deck, Note Type, Note,
 *   or Card whose id is already here is kept as it is, so restoring twice, or
 *   restoring into a collection that still holds most of the data, changes
 *   nothing the second time.
 * - Reviews are unioned by id (ADR 0002: the log is append-only and a replayed
 *   id is ignored).
 * - A Card that exists in both takes the backup's Schedule only when the backup
 *   reviewed it more recently (`lastReviewedAt`); ties and older backups keep
 *   the live Schedule. Review history is unioned either way, so the log can
 *   hold Reviews the Card's Schedule does not reflect after a merge.
 * - Undo snapshots are not part of the export. Restored Reviews keep their
 *   resulting Schedule, but their before-state reads as unknown and they
 *   cannot be undone, exactly like Reviews that predate snapshots.
 *
 * The file is validated in full before anything is written: format version,
 * shape, value ranges, duplicate ids, and references (a Card's Deck and Note,
 * a Note's Note Type, a Review's Card must be in the file or already here).
 * A failure is a `RestoreRejected` that lists what is wrong and writes nothing.
 *
 * Writes follow ADR 0003. Rows go through `db.batch` in dependency order,
 * bulk-loaded from `json_each` so a statement carries one bound parameter
 * however many rows it holds. A restore that fits one batch is atomic; a larger
 * one commits in several, and every statement is idempotent under the merge
 * rules above, so retrying a failed restore finishes it.
 */

import { Context, Effect, Layer, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import type * as Statement from 'effect/sql/Statement'
import { EXPORT_VERSION, RestoreRejected, RestoreRpc, StorageUnavailable } from '@nook/api'
import type { RestoreCounts, RestoreResult } from '@nook/api'
import { runStatements } from './batch'
import { StoredField, StoredTemplate } from './note-type-rows'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'
import { CurrentUser } from './users'

/** How many specific problems a rejection lists. */
const MAX_ISSUES = 20

/** Rows per `json_each` statement, and the JSON size past which a chunk closes early. */
const CHUNK_ROWS = 200
const CHUNK_CHARS = 400_000

/** Statements per `db.batch`. */
const BATCH_STATEMENTS = 100

const nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

const FileDeck = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  newPerDay: nullable(Schema.Number),
  reviewsPerDay: nullable(Schema.Number),
  lapseMinutes: nullable(Schema.Number),
})

const FileNoteType = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['normal', 'cloze']),
  sortFieldOrd: Schema.Number,
  css: Schema.String,
  fields: Schema.Array(Schema.Unknown),
  templates: Schema.Array(Schema.Unknown),
})

const FileNote = Schema.Struct({
  id: Schema.String,
  noteTypeId: Schema.String,
  guid: Schema.String,
  fields: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  modified: Schema.Number,
})

const FileCard = Schema.Struct({
  id: Schema.String,
  deckId: Schema.String,
  noteId: Schema.NullOr(Schema.String),
  templateOrd: Schema.Number,
  suspended: Schema.Boolean,
  state: Schema.Literals(['new', 'learning', 'review', 'relearning']),
  stability: Schema.Number,
  difficulty: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  dueInDays: Schema.optional(Schema.Number),
  reps: Schema.Number,
  lapses: Schema.Number,
  reviewLapses: Schema.Number,
  lastReviewedAt: Schema.NullOr(Schema.String),
  introducedDay: nullable(Schema.String),
})

const FileReview = Schema.Struct({
  id: Schema.String,
  cardId: Schema.String,
  grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
  reviewedAt: Schema.String,
  stateAfter: nullable(Schema.Literals(['new', 'learning', 'review', 'relearning'])),
  stabilityAfter: nullable(Schema.Number),
  difficultyAfter: nullable(Schema.Number),
  dueInDaysAfter: nullable(Schema.Number),
  dueAtAfter: nullable(Schema.String),
  leechSuspended: Schema.optional(Schema.Boolean),
})

/** Both formats: v1 files have no `version` or `noteTypes`, and fewer columns. */
const BackupFile = Schema.Struct({
  exportedAt: Schema.String,
  decks: Schema.Array(FileDeck),
  noteTypes: Schema.optional(Schema.Array(FileNoteType)),
  notes: Schema.Array(FileNote),
  cards: Schema.Array(FileCard),
  reviews: Schema.Array(FileReview),
})
type BackupFile = typeof BackupFile.Type

const rejected = (message: string, issues: ReadonlyArray<string> = []) =>
  new RestoreRejected({ message, issues: issues.slice(0, MAX_ISSUES) })

/** `Date.parse` that reads SQLite's zoneless `YYYY-MM-DD HH:MM:SS` as UTC. */
const toMs = (text: string): number =>
  Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)

const isNonNegativeInt = (value: number): boolean => Number.isInteger(value) && value >= 0

/** Parse and decode the file. Fails with a `RestoreRejected` naming what is wrong. */
export const parseBackup = (
  text: string,
): Effect.Effect<BackupFile & { version: number }, RestoreRejected> =>
  Effect.gen(function* () {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return yield* rejected(
        'That file is not valid JSON. Pick a nook export (nook-export-….json).',
      )
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return yield* rejected('That file is not a nook export: expected a JSON object at the top.')
    }
    const version = (raw as { version?: unknown }).version ?? 1
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return yield* rejected(
        `That file has an invalid format version (${JSON.stringify(version)}).`,
      )
    }
    if (version > EXPORT_VERSION) {
      return yield* rejected(
        `That export is format version ${version}, but this nook restores up to version ${EXPORT_VERSION}. Update nook and try again.`,
      )
    }
    const decoded = yield* Schema.decodeUnknownEffect(BackupFile)(raw).pipe(
      Effect.mapError((error) =>
        rejected('That file is not a complete nook export.', [error.message]),
      ),
    )
    if (version >= 2 && decoded.noteTypes === undefined) {
      return yield* rejected('That version 2 export has no "noteTypes", so it is incomplete.')
    }
    return { ...decoded, version }
  })

/** Value-range and duplicate-id problems that need no database. */
const shapeIssues = (file: BackupFile): Array<string> => {
  const issues: Array<string> = []
  const duplicates = (kind: string, ids: ReadonlyArray<string>) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) issues.push(`Two ${kind} share the id "${id}".`)
      seen.add(id)
    }
  }
  duplicates(
    'Decks',
    file.decks.map((row) => row.id),
  )
  duplicates(
    'Note Types',
    (file.noteTypes ?? []).map((row) => row.id),
  )
  duplicates(
    'Notes',
    file.notes.map((row) => row.id),
  )
  duplicates(
    'Cards',
    file.cards.map((row) => row.id),
  )
  duplicates(
    'Reviews',
    file.reviews.map((row) => row.id),
  )

  const badTime = (label: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && Number.isNaN(toMs(value))) {
      issues.push(`${label} has an unreadable time: "${value}".`)
    }
  }
  const badNumber = (
    label: string,
    value: number | null | undefined,
    ok: (n: number) => boolean,
  ) => {
    if (value !== null && value !== undefined && !(Number.isFinite(value) && ok(value))) {
      issues.push(`${label} has an out-of-range value: ${value}.`)
    }
  }
  const nonNegative = (n: number) => n >= 0

  for (const deck of file.decks) {
    for (const [name, value] of [
      ['newPerDay', deck.newPerDay],
      ['reviewsPerDay', deck.reviewsPerDay],
      ['lapseMinutes', deck.lapseMinutes],
    ] as const) {
      badNumber(`Deck "${deck.id}" ${name}`, value, isNonNegativeInt)
    }
  }
  for (const noteType of file.noteTypes ?? []) {
    const fields = Schema.decodeUnknownOption(Schema.Array(StoredField))(noteType.fields)
    const templates = Schema.decodeUnknownOption(Schema.Array(StoredTemplate))(noteType.templates)
    if (fields._tag === 'None') issues.push(`Note Type "${noteType.id}" has malformed fields.`)
    if (templates._tag === 'None')
      issues.push(`Note Type "${noteType.id}" has malformed templates.`)
    badNumber(`Note Type "${noteType.id}" sortFieldOrd`, noteType.sortFieldOrd, isNonNegativeInt)
  }
  for (const card of file.cards) {
    const at = `Card "${card.id}"`
    badNumber(`${at} templateOrd`, card.templateOrd, isNonNegativeInt)
    badNumber(`${at} stability`, card.stability, nonNegative)
    badNumber(`${at} difficulty`, card.difficulty, (n) => n >= 0 && n <= 10)
    badNumber(`${at} dueInDays`, card.dueInDays, Number.isInteger)
    badNumber(`${at} reps`, card.reps, isNonNegativeInt)
    badNumber(`${at} lapses`, card.lapses, isNonNegativeInt)
    badNumber(`${at} reviewLapses`, card.reviewLapses, isNonNegativeInt)
    badTime(`${at} dueAt`, card.dueAt)
    badTime(`${at} lastReviewedAt`, card.lastReviewedAt)
    if (card.introducedDay != null && !/^\d{4}-\d{2}-\d{2}$/.test(card.introducedDay)) {
      issues.push(`${at} has an unreadable introducedDay: "${card.introducedDay}".`)
    }
  }
  for (const review of file.reviews) {
    const at = `Review "${review.id}"`
    badTime(`${at} reviewedAt`, review.reviewedAt)
    badTime(`${at} dueAtAfter`, review.dueAtAfter)
    badNumber(`${at} stabilityAfter`, review.stabilityAfter, nonNegative)
    badNumber(`${at} difficultyAfter`, review.difficultyAfter, (n) => n >= 0 && n <= 10)
    badNumber(`${at} dueInDaysAfter`, review.dueInDaysAfter, Number.isInteger)
  }
  return issues
}

/** Ids the collection already holds, and each Card's last Review time. */
interface Existing {
  readonly decks: ReadonlySet<string>
  readonly noteTypes: ReadonlySet<string>
  readonly notes: ReadonlySet<string>
  readonly cards: ReadonlyMap<string, string | null>
  readonly reviews: ReadonlySet<string>
}

const IdRow = Schema.Struct({ id: Schema.String })
const CardIdRow = Schema.Struct({ id: Schema.String, lastReviewedAt: Schema.NullOr(Schema.String) })

/** A reference is fine when its target is in the file or already in the collection. */
const referenceIssues = (file: BackupFile, existing: Existing): Array<string> => {
  const issues: Array<string> = []
  const decks = new Set([...existing.decks, ...file.decks.map((row) => row.id)])
  const noteTypes = new Set([...existing.noteTypes, ...(file.noteTypes ?? []).map((row) => row.id)])
  const notes = new Set([...existing.notes, ...file.notes.map((row) => row.id)])
  const cards = new Set([...existing.cards.keys(), ...file.cards.map((row) => row.id)])
  for (const note of file.notes) {
    if (!noteTypes.has(note.noteTypeId)) {
      issues.push(
        `Note "${note.id}" uses Note Type "${note.noteTypeId}", which is not in the file or this collection.`,
      )
    }
  }
  for (const card of file.cards) {
    if (!decks.has(card.deckId)) {
      issues.push(
        `Card "${card.id}" is in Deck "${card.deckId}", which is not in the file or this collection.`,
      )
    }
    if (card.noteId !== null && !notes.has(card.noteId)) {
      issues.push(
        `Card "${card.id}" belongs to Note "${card.noteId}", which is not in the file or this collection.`,
      )
    }
  }
  for (const review of file.reviews) {
    if (!cards.has(review.cardId)) {
      issues.push(
        `Review "${review.id}" is for Card "${review.cardId}", which is not in the file or this collection.`,
      )
    }
  }
  return issues
}

/** Split rows into JSON text chunks, closing a chunk at `CHUNK_ROWS` rows or `CHUNK_CHARS` characters. */
const jsonChunks = (rows: ReadonlyArray<unknown>): Array<string> => {
  const chunks: Array<string> = []
  let current: Array<string> = []
  let size = 0
  const flush = () => {
    if (current.length > 0) chunks.push(`[${current.join(',')}]`)
    current = []
    size = 0
  }
  for (const row of rows) {
    const text = JSON.stringify(row)
    if (current.length > 0 && (current.length >= CHUNK_ROWS || size + text.length > CHUNK_CHARS)) {
      flush()
    }
    current.push(text)
    size += text.length + 1
  }
  flush()
  return chunks
}

const countsOf = (counts: {
  decks: number
  noteTypes: number
  notes: number
  cards: number
  reviews: number
}): RestoreCounts => counts

export class Restore extends Context.Service<
  Restore,
  {
    restore(input: {
      json: string
      dryRun: boolean
    }): Effect.Effect<RestoreResult, RestoreRejected | StorageUnavailable>
  }
>()('nook/backend/Restore') {
  static readonly layer = Layer.effect(
    Restore,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient
      const { id: userId } = yield* CurrentUser

      const readExisting = Effect.gen(function* () {
        const ids = (table: string) =>
          sql.unsafe(`SELECT id FROM ${table} WHERE user_id = ?`, [userId]).pipe(
            Effect.flatMap((rows) => decodeRows(IdRow, rows)),
            Effect.map((rows) => new Set(rows.map((row) => row.id))),
          )
        const cardRows = yield* sql`SELECT id, last_reviewed_at AS "lastReviewedAt" FROM cards
          WHERE user_id = ${userId}`
        const cards = yield* decodeRows(CardIdRow, cardRows)
        return {
          decks: yield* ids('decks'),
          noteTypes: yield* ids('note_types'),
          notes: yield* ids('notes'),
          cards: new Map(cards.map((card) => [card.id, card.lastReviewedAt] as const)),
          reviews: yield* ids('reviews'),
        } satisfies Existing
      })

      const restore = (input: {
        json: string
        dryRun: boolean
      }): Effect.Effect<RestoreResult, RestoreRejected | StorageUnavailable> =>
        Effect.gen(function* () {
          const file = yield* parseBackup(input.json)
          const shape = shapeIssues(file)
          if (shape.length > 0) {
            return yield* rejected(
              `That export has ${shape.length} invalid ${shape.length === 1 ? 'value' : 'values'}. Nothing was restored.`,
              shape,
            )
          }
          const existing = yield* readExisting
          const references = referenceIssues(file, existing)
          if (references.length > 0) {
            return yield* rejected(
              `That export refers to ${references.length} ${references.length === 1 ? 'row' : 'rows'} that exist nowhere. Nothing was restored.`,
              references,
            )
          }

          const noteTypes = file.noteTypes ?? []
          const newDecks = file.decks.filter((row) => !existing.decks.has(row.id))
          const newNoteTypes = noteTypes.filter((row) => !existing.noteTypes.has(row.id))
          const newNotes = file.notes.filter((row) => !existing.notes.has(row.id))
          const newCards = file.cards.filter((row) => !existing.cards.has(row.id))
          const newReviews = file.reviews.filter((row) => !existing.reviews.has(row.id))
          const newerCards = file.cards.filter((card) => {
            if (!existing.cards.has(card.id) || card.lastReviewedAt === null) return false
            const live = existing.cards.get(card.id)
            return live === null || live === undefined || toMs(card.lastReviewedAt) > toMs(live)
          })

          const result: RestoreResult = {
            dryRun: input.dryRun,
            version: file.version,
            exportedAt: file.exportedAt,
            added: countsOf({
              decks: newDecks.length,
              noteTypes: newNoteTypes.length,
              notes: newNotes.length,
              cards: newCards.length,
              reviews: newReviews.length,
            }),
            existing: countsOf({
              decks: file.decks.length - newDecks.length,
              noteTypes: noteTypes.length - newNoteTypes.length,
              notes: file.notes.length - newNotes.length,
              cards: file.cards.length - newCards.length,
              reviews: file.reviews.length - newReviews.length,
            }),
            schedulesUpdated: newerCards.length,
          }
          if (input.dryRun) return result

          const exportedMs = toMs(file.exportedAt)
          const dueInDays = (card: BackupFile['cards'][number]): number => {
            if (card.dueInDays !== undefined) return card.dueInDays
            if (card.dueAt === null || Number.isNaN(exportedMs)) return 0
            return Math.round((toMs(card.dueAt) - exportedMs) / 86_400_000)
          }

          const restoreImportId = `restore:${file.exportedAt}`
          const statements: Array<Statement.Statement<unknown>> = []

          for (const chunk of jsonChunks(
            newNoteTypes.map((row) => ({
              id: row.id,
              name: row.name,
              kind: row.kind,
              sortFieldOrd: row.sortFieldOrd,
              css: row.css,
              fields: JSON.stringify(row.fields),
              templates: JSON.stringify(row.templates),
            })),
          )) {
            statements.push(sql`INSERT OR IGNORE INTO note_types
              (user_id, id, name, kind, sort_field_ord, css, fields, templates)
              SELECT ${userId}, json_extract(value, '$.id'), json_extract(value, '$.name'),
                json_extract(value, '$.kind'), json_extract(value, '$.sortFieldOrd'),
                json_extract(value, '$.css'), json_extract(value, '$.fields'),
                json_extract(value, '$.templates')
              FROM json_each(${chunk})`)
          }
          for (const chunk of jsonChunks(
            newDecks.map((row) => ({
              id: row.id,
              name: row.name,
              description: row.description ?? '',
              newPerDay: row.newPerDay ?? null,
              reviewsPerDay: row.reviewsPerDay ?? null,
              lapseMinutes: row.lapseMinutes ?? null,
            })),
          )) {
            statements.push(sql`INSERT OR IGNORE INTO decks
              (user_id, id, name, description, new_per_day, reviews_per_day, lapse_minutes)
              SELECT ${userId}, json_extract(value, '$.id'), json_extract(value, '$.name'),
                json_extract(value, '$.description'), json_extract(value, '$.newPerDay'),
                json_extract(value, '$.reviewsPerDay'), json_extract(value, '$.lapseMinutes')
              FROM json_each(${chunk})`)
          }
          if (newNotes.length > 0) {
            // Notes carry a NOT NULL import id, so restored Notes name one Import row.
            statements.push(sql`INSERT OR IGNORE INTO imports (user_id, id, filename, status)
              VALUES (${userId}, ${restoreImportId}, 'Restored from JSON export', 'done')`)
          }
          for (const chunk of jsonChunks(
            newNotes.map((row) => ({
              id: row.id,
              noteTypeId: row.noteTypeId,
              guid: row.guid,
              fields: JSON.stringify(row.fields),
              tags: JSON.stringify(row.tags),
              modified: row.modified,
            })),
          )) {
            statements.push(sql`INSERT OR IGNORE INTO notes
              (user_id, id, note_type_id, guid, fields, tags, modified, import_id)
              SELECT ${userId}, json_extract(value, '$.id'), json_extract(value, '$.noteTypeId'),
                json_extract(value, '$.guid'), json_extract(value, '$.fields'),
                json_extract(value, '$.tags'), json_extract(value, '$.modified'),
                ${restoreImportId}
              FROM json_each(${chunk})`)
          }
          const cardJson = (card: BackupFile['cards'][number]) => ({
            id: card.id,
            deckId: card.deckId,
            noteId: card.noteId,
            templateOrd: card.templateOrd,
            suspended: card.suspended ? 1 : 0,
            state: card.state,
            stability: card.stability,
            difficulty: card.difficulty,
            dueAt: card.dueAt,
            dueInDays: dueInDays(card),
            reps: card.reps,
            lapses: card.lapses,
            reviewLapses: card.reviewLapses,
            lastReviewedAt: card.lastReviewedAt,
            introducedDay: card.introducedDay ?? null,
          })
          for (const chunk of jsonChunks(newCards.map(cardJson))) {
            statements.push(sql`INSERT OR IGNORE INTO cards
              (user_id, id, deck_id, note_id, template_ord, suspended, state, stability, difficulty,
               due_at, due_in_days, reps, lapses, review_lapses, last_reviewed_at, introduced_day)
              SELECT ${userId}, json_extract(value, '$.id'), json_extract(value, '$.deckId'),
                json_extract(value, '$.noteId'), json_extract(value, '$.templateOrd'),
                json_extract(value, '$.suspended'), json_extract(value, '$.state'),
                json_extract(value, '$.stability'), json_extract(value, '$.difficulty'),
                json_extract(value, '$.dueAt'), json_extract(value, '$.dueInDays'),
                json_extract(value, '$.reps'), json_extract(value, '$.lapses'),
                json_extract(value, '$.reviewLapses'), json_extract(value, '$.lastReviewedAt'),
                json_extract(value, '$.introducedDay')
              FROM json_each(${chunk})`)
          }
          for (const chunk of jsonChunks(newerCards.map(cardJson))) {
            // The julianday guard repeats the merge rule in SQL, so a grade that
            // lands between the read above and this batch is never overwritten.
            statements.push(sql`UPDATE cards SET
              suspended = json_extract(j.value, '$.suspended'),
              state = json_extract(j.value, '$.state'),
              stability = json_extract(j.value, '$.stability'),
              difficulty = json_extract(j.value, '$.difficulty'),
              due_at = json_extract(j.value, '$.dueAt'),
              due_in_days = json_extract(j.value, '$.dueInDays'),
              reps = json_extract(j.value, '$.reps'),
              lapses = json_extract(j.value, '$.lapses'),
              review_lapses = json_extract(j.value, '$.reviewLapses'),
              last_reviewed_at = json_extract(j.value, '$.lastReviewedAt'),
              introduced_day = json_extract(j.value, '$.introducedDay'),
              buried_until = NULL,
              buried_sibling_of = NULL,
              updated_at = datetime('now')
              FROM json_each(${chunk}) AS j
              WHERE cards.user_id = ${userId}
                AND cards.id = json_extract(j.value, '$.id')
                AND julianday(json_extract(j.value, '$.lastReviewedAt'))
                  > COALESCE(julianday(cards.last_reviewed_at), 0)`)
          }
          for (const chunk of jsonChunks(
            newReviews.map((row) => ({
              id: row.id,
              cardId: row.cardId,
              grade: row.grade,
              reviewedAt: row.reviewedAt,
              stateAfter: row.stateAfter ?? null,
              stabilityAfter: row.stabilityAfter ?? null,
              difficultyAfter: row.difficultyAfter ?? null,
              dueInDaysAfter: row.dueInDaysAfter ?? null,
              dueAtAfter: row.dueAtAfter ?? null,
              leechSuspended: row.leechSuspended === true ? 1 : 0,
            })),
          )) {
            statements.push(sql`INSERT OR IGNORE INTO reviews
              (user_id, id, card_id, grade, reviewed_at, state_after, stability_after, difficulty_after,
               due_in_days_after, due_at_after, leech_suspended)
              SELECT ${userId}, json_extract(value, '$.id'), json_extract(value, '$.cardId'),
                json_extract(value, '$.grade'), json_extract(value, '$.reviewedAt'),
                json_extract(value, '$.stateAfter'), json_extract(value, '$.stabilityAfter'),
                json_extract(value, '$.difficultyAfter'), json_extract(value, '$.dueInDaysAfter'),
                json_extract(value, '$.dueAtAfter'), json_extract(value, '$.leechSuspended')
              FROM json_each(${chunk})`)
          }

          for (let start = 0; start < statements.length; start += BATCH_STATEMENTS) {
            yield* runStatements(statements.slice(start, start + BATCH_STATEMENTS))
          }
          return result
        }).pipe(Effect.withSpan('Restore.restore'), (self) =>
          withStorageErrorPassThrough(self, 'restore the collection'),
        )

      return Restore.of({ restore })
    }),
  )
}

export const RestoreHandlers = RestoreRpc.toLayer(
  Effect.gen(function* () {
    const restore = yield* Restore
    return RestoreRpc.of({
      collectionRestore: ({ json, dryRun }) => restore.restore({ json, dryRun }),
    })
  }),
)
