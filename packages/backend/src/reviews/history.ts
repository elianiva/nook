/**
 * A Card's review history.
 */

import { Effect, Schema } from 'effect'
import { CardId, CardNotFound, StorageUnavailable } from '@nook/api'
import type { CardReviewHistory, ReviewScheduleSnapshot } from '@nook/api'
import { CountRow, decodeRows, withStorageErrorPassThrough } from '../storage-error'
import type { ReviewsDeps } from './reads'
import { HISTORY_LIMIT, CardStateRow } from './rows'

export const makeHistory = ({ sql, userId, readCard }: ReviewsDeps) => {
  /**
   * The newest grade events for one Card. Before-state comes from the
   * atomic undo snapshot; after-state is saved with the grade. Older
   * history without either record remains visible with an unknown state.
   */
  const history = (input: {
    cardId: CardId
  }): Effect.Effect<CardReviewHistory, CardNotFound | StorageUnavailable> =>
    Effect.gen(function* () {
      const card = yield* readCard(input.cardId)
      if (card === undefined) return yield* new CardNotFound({ cardId: input.cardId })

      const countRows =
        yield* sql`SELECT COUNT(*) AS n FROM reviews WHERE user_id = ${userId} AND card_id = ${input.cardId}`
      const total = (yield* decodeRows(CountRow, countRows))[0]?.n ?? 0
      const eventRows = yield* sql`SELECT r.id, r.grade, r.reviewed_at AS "reviewedAt",
            s.state AS "beforeState", s.stability AS "beforeStability",
            s.difficulty AS "beforeDifficulty", s.due_in_days AS "beforeDueInDays",
            s.due_at AS "beforeDueAt", r.state_after AS "afterState",
            r.stability_after AS "afterStability", r.difficulty_after AS "afterDifficulty",
            r.due_in_days_after AS "afterDueInDays", r.due_at_after AS "afterDueAt",
            r.leech_suspended AS "leechSuspended"
            FROM reviews r LEFT JOIN review_snapshots s ON s.review_id = r.id AND s.user_id = r.user_id
            WHERE r.user_id = ${userId} AND r.card_id = ${input.cardId}
            ORDER BY r.reviewed_at DESC, r.rowid DESC LIMIT ${HISTORY_LIMIT}`
      const rows = yield* decodeRows(
        Schema.Struct({
          id: Schema.String,
          grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
          reviewedAt: Schema.String,
          beforeState: Schema.NullOr(CardStateRow),
          beforeStability: Schema.NullOr(Schema.Number),
          beforeDifficulty: Schema.NullOr(Schema.Number),
          beforeDueInDays: Schema.NullOr(Schema.Number),
          beforeDueAt: Schema.NullOr(Schema.String),
          afterState: Schema.NullOr(CardStateRow),
          afterStability: Schema.NullOr(Schema.Number),
          afterDifficulty: Schema.NullOr(Schema.Number),
          afterDueInDays: Schema.NullOr(Schema.Number),
          afterDueAt: Schema.NullOr(Schema.String),
          leechSuspended: Schema.Number,
        }),
        eventRows,
      )
      const schedule = (
        state: typeof CardStateRow.Type | null,
        stability: number | null,
        difficulty: number | null,
        dueInDays: number | null,
        dueAt: string | null,
      ): ReviewScheduleSnapshot | null =>
        state === null || stability === null || difficulty === null || dueInDays === null
          ? null
          : { state, stability, difficulty, dueInDays, dueAt }
      return {
        total,
        events: rows.map((row) => ({
          id: row.id,
          grade: row.grade,
          reviewedAt: row.reviewedAt,
          before: schedule(
            row.beforeState,
            row.beforeStability,
            row.beforeDifficulty,
            row.beforeDueInDays,
            row.beforeDueAt,
          ),
          after: schedule(
            row.afterState,
            row.afterStability,
            row.afterDifficulty,
            row.afterDueInDays,
            row.afterDueAt,
          ),
          leechSuspended: row.leechSuspended === 1,
        })),
      } satisfies CardReviewHistory
    }).pipe(Effect.withSpan('Reviews.history'), (self) =>
      withStorageErrorPassThrough(self, 'load Card review history'),
    )

  return history
}
