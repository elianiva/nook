import { Context, Effect, Layer, Option, Schema } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import * as Sql from 'effect/sql/SqlClient'
import { Api, CardId, DeckId, DeckNotFound, StorageUnavailable } from '@nook/api'
import type { Card, DeckDetail, DeckSummary } from '@nook/api'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'

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

      const getById = (id: DeckId): Effect.Effect<DeckDetail, DeckNotFound | StorageUnavailable> =>
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
        }).pipe(Effect.withSpan('Decks.getById'), (self) =>
          withStorageErrorPassThrough(self, 'read deck'),
        )

      return Decks.of({ list, getById })
    }),
  )
}

export const DecksHandlers = HttpApiBuilder.group(Api, 'decks', (handlers) =>
  Effect.gen(function* () {
    const decks = yield* Decks
    return handlers.handleAll({
      list: () => decks.list,
      getById: ({ params }) => decks.getById(params.deckId),
    })
  }),
)
