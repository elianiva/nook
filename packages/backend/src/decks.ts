import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { CardId, DecksRpc, DeckId, DeckNotFound, StorageUnavailable } from '@nook/api'
import type { Card, DeckDetail, DeckRename, DeckSummary } from '@nook/api'
import { runStatements } from './batch'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'
import type { StorageError } from './storage-error'

/** One row of the `decks` table with its counts computed in SQL. */
const DeckRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  newCount: Schema.Number,
  dueCount: Schema.Number,
  totalCount: Schema.Number,
  lastStudiedAt: Schema.NullOr(Schema.String),
  retention7d: Schema.Number,
})

/** One row of the `cards` table, enough for the scheduling-state table. */
const CardRow = Schema.Struct({
  id: Schema.String,
  deckId: Schema.String,
  dueAt: Schema.NullOr(Schema.String),
  dueInDays: Schema.Number,
  stability: Schema.Number,
  difficulty: Schema.Number,
  state: Schema.Literals(['new', 'learning', 'review', 'relearning']),
})

const toSummary = (row: typeof DeckRow.Type): DeckSummary => ({
  id: DeckId.make(row.id),
  name: row.name,
  description: row.description,
  newCount: row.newCount,
  dueCount: row.dueCount,
  totalCount: row.totalCount,
  lastStudiedAt: row.lastStudiedAt === null ? Option.none() : Option.some(row.lastStudiedAt),
  retention7d: row.retention7d,
})

const toCard = (row: typeof CardRow.Type): Card => ({
  id: CardId.make(row.id),
  deckId: DeckId.make(row.deckId),
  dueAt: row.dueAt === null ? Option.none() : Option.some(row.dueAt),
  dueInDays: row.dueInDays,
  stability: row.stability,
  difficulty: row.difficulty,
  state: row.state,
})

/**
 * Decks read through the `SqlClient` the layer closes over, so the service
 * interface carries no requirements and the handlers add no `Request`
 * markers — the database is provided once, as a plain layer dependency.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry). Only an unknown deck id is a 404 `DeckNotFound`.
 */
export class Decks extends Context.Service<
  Decks,
  {
    readonly list: Effect.Effect<ReadonlyArray<DeckSummary>, StorageUnavailable>
    getById(id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable>
    rename(
      id: DeckId,
      rename: DeckRename,
    ): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable>
    reset(id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable>
    remove(id: DeckId): Effect.Effect<void, DeckNotFound | StorageUnavailable>
  }
>()('nook/backend/Decks') {
  static readonly layer = Layer.effect(
    Decks,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const list = Effect.gen(function* () {
        const rows = yield* sql`SELECT id, name, description,
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state = 'new') AS "newCount",
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state != 'new'
              AND due_at IS NOT NULL AND due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))) AS "dueCount",
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id) AS "totalCount",
            last_studied_at AS "lastStudiedAt",
            (SELECT COALESCE(ROUND(100.0 * SUM(CASE WHEN r.grade != 'Again' THEN 1 ELSE 0 END) / COUNT(*)), 0)
              FROM reviews r JOIN cards c ON c.id = r.card_id
              WHERE c.deck_id = decks.id
                AND r.reviewed_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')) AS "retention7d"
            FROM decks ORDER BY name`
        const decoded = yield* decodeRows(DeckRow, rows)
        return decoded.map(toSummary)
      }).pipe(Effect.withSpan('Decks.list'), (self) =>
        withStorageErrorPassThrough(self, 'list decks'),
      )

      // The one-deck read, shared by get, rename, and reset: unknown ids are
      // a 404 `DeckNotFound`, never a storage problem. The caller wraps it in
      // `withStorageErrorPassThrough` with its own operation name, so SQL and
      // row-decode failures surface as a 503 `StorageUnavailable`.
      const readDetail = (id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageError> =>
        Effect.gen(function* () {
          const summaryRows = yield* sql`SELECT id, name, description,
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state = 'new') AS "newCount",
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state != 'new'
              AND due_at IS NOT NULL AND due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))) AS "dueCount",
            (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id) AS "totalCount",
            last_studied_at AS "lastStudiedAt",
            (SELECT COALESCE(ROUND(100.0 * SUM(CASE WHEN r.grade != 'Again' THEN 1 ELSE 0 END) / COUNT(*)), 0)
              FROM reviews r JOIN cards c ON c.id = r.card_id
              WHERE c.deck_id = decks.id
                AND r.reviewed_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')) AS "retention7d"
            FROM decks WHERE id = ${id}`
          const summaries = yield* decodeRows(DeckRow, summaryRows)
          const summary = summaries[0]
          if (summary === undefined) return yield* new DeckNotFound({ deckId: id })
          const cardRows = yield* sql`SELECT id, deck_id AS "deckId", due_at AS "dueAt",
            COALESCE(CAST(julianday(due_at) - julianday('now') AS INTEGER), 0) AS "dueInDays",
            stability, difficulty, state FROM cards WHERE deck_id = ${id} ORDER BY rowid LIMIT 200`
          const cards = yield* decodeRows(CardRow, cardRows)
          return { summary: toSummary(summary), cards: cards.map(toCard) } satisfies DeckDetail
        })

      const getById = (id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable> =>
        readDetail(id).pipe(Effect.withSpan('Decks.getById'), (self) =>
          withStorageErrorPassThrough(self, 'read deck'),
        )

      const rename = (
        id: DeckId,
        rename: DeckRename,
      ): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          // An empty name would render as a blank row everywhere; reject it
          // before it reaches SQL.
          const name = rename.name.trim()
          if (name === '') {
            return yield* new StorageUnavailable({
              message: 'Could not rename the deck. The name cannot be empty.',
            })
          }
          const existing = yield* sql`SELECT id FROM decks WHERE id = ${id}`
          if (existing.length === 0) return yield* new DeckNotFound({ deckId: id })
          yield* sql`UPDATE decks SET name = ${name}, description = ${rename.description.trim()},
            updated_at = datetime('now') WHERE id = ${id}`
          return yield* readDetail(id)
        }).pipe(Effect.withSpan('Decks.rename'), (self) =>
          withStorageErrorPassThrough(self, 'rename deck'),
        )

      /**
       * Clear a Deck's Schedule: every Card returns to `new` with zeroed FSRS
       * state, and the Review log (plus its undo snapshots) for those Cards
       * is removed. Notes, Note Types, and the Deck itself stay — only the
       * Schedule goes, so re-studying starts clean.
       */
      const reset = (id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const existing = yield* sql`SELECT id FROM decks WHERE id = ${id}`
          if (existing.length === 0) return yield* new DeckNotFound({ deckId: id })
          yield* runStatements([
            sql`DELETE FROM review_snapshots WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ${id})`,
            sql`DELETE FROM reviews WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ${id})`,
            sql`UPDATE cards SET state = 'new', stability = 0, difficulty = 1,
              due_in_days = 0, due_at = NULL, reps = 0, lapses = 0,
              introduced_day = NULL, buried_until = NULL, buried_sibling_of = NULL,
              last_reviewed_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE deck_id = ${id}`,
            sql`UPDATE decks SET last_studied_at = NULL, updated_at = datetime('now')
              WHERE id = ${id}`,
          ])
          return yield* readDetail(id)
        }).pipe(Effect.withSpan('Decks.reset'), (self) =>
          withStorageErrorPassThrough(self, 'reset deck'),
        )

      /**
       * Remove a Deck and everything that belongs to it alone. Cards go first
       * (with their Reviews and snapshots), then Notes no other Deck's Cards
       * reference, then the Deck row. Reviews reference Cards, not Decks, so
       * deleting the Cards removes their history with them.
       */
      const remove = (id: DeckId): Effect.Effect<void, DeckNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const existing = yield* sql`SELECT id FROM decks WHERE id = ${id}`
          if (existing.length === 0) return yield* new DeckNotFound({ deckId: id })
          yield* runStatements([
            sql`DELETE FROM review_snapshots WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ${id})`,
            sql`DELETE FROM reviews WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ${id})`,
            sql`DELETE FROM cards WHERE deck_id = ${id}`,
            sql`DELETE FROM notes WHERE id NOT IN (SELECT DISTINCT note_id FROM cards WHERE note_id IS NOT NULL)`,
            sql`DELETE FROM decks WHERE id = ${id}`,
          ])
        }).pipe(Effect.withSpan('Decks.remove'), (self) =>
          withStorageErrorPassThrough(self, 'remove deck'),
        )

      return Decks.of({ list, getById, rename, reset, remove })
    }),
  )
}

export const DecksHandlers = DecksRpc.toLayer(
  Effect.gen(function* () {
    const decks = yield* Decks
    return DecksRpc.of({
      decksList: () => decks.list,
      decksGetById: ({ deckId }) => decks.getById(deckId),
      decksRename: ({ deckId, rename }) => decks.rename(deckId, rename),
      decksReset: ({ deckId }) => decks.reset(deckId),
      decksRemove: ({ deckId }) => decks.remove(deckId),
    })
  }),
)
