/**
 * Undo of the latest grade on a Card.
 */

import { Effect, Schema } from 'effect'
import { CardId, CardNotFound, StorageUnavailable } from '@nook/api'
import type { UndoAccepted } from '@nook/api'
import { runStatements } from '../batch'
import { decodeRows, withStorageErrorPassThrough } from '../storage-error'
import type { ReviewsDeps } from './reads'
import { CardStateRow, LastReviewRow } from './rows'

export const makeUndo = ({ sql, readCard }: ReviewsDeps) => {
  /**
   * Undoes the latest grade on `cardId`.
   *
   * The Review log row is deleted and the Card's scheduling state restored
   * from the snapshot the grade wrote; siblings this grade buried are
   * unburied. Only the latest Review on the Card is undoable, and only
   * when it still has its snapshot — grades from before the snapshot
   * migration cannot be undone.
   */
  const undo = (input: {
    cardId: CardId
    reviewId?: string | undefined
  }): Effect.Effect<UndoAccepted, CardNotFound | StorageUnavailable> =>
    Effect.gen(function* () {
      const card = yield* readCard(input.cardId)
      if (card === undefined) return yield* new CardNotFound({ cardId: input.cardId })

      const lastRows = yield* sql`SELECT id, card_id AS "cardId", grade,
            leech_suspended AS "leechSuspended" FROM reviews
            WHERE card_id = ${input.cardId} ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`
      const last = yield* decodeRows(LastReviewRow, lastRows)
      const latest = last[0]
      if (input.reviewId !== undefined && latest?.id !== input.reviewId) {
        // A retry names the grade it meant to undo. If that grade is gone
        // the first attempt landed: report the Card as it stands rather
        // than undoing an earlier grade. If it still exists but is not the
        // latest, a later grade owns the Card and this undo is stale.
        const named = yield* sql`SELECT id FROM reviews WHERE id = ${input.reviewId}`
        if (named.length > 0) return yield* new CardNotFound({ cardId: input.cardId })
        return {
          cardId: input.cardId,
          state: card.state,
          dueInDays: card.dueInDays,
          stability: card.stability,
          difficulty: card.difficulty,
        } satisfies UndoAccepted
      }
      if (latest === undefined) return yield* new CardNotFound({ cardId: input.cardId })

      const snapshotRows = yield* sql`SELECT state, stability, difficulty,
            due_in_days AS "dueInDays", due_at AS "dueAt", reps, lapses,
            introduced_day AS "introducedDay", last_reviewed_at AS "lastReviewedAt",
            buried_until AS "buriedUntil", review_lapses AS "reviewLapses", suspended
            FROM review_snapshots WHERE review_id = ${latest.id}`
      const snapshots = yield* decodeRows(
        Schema.Struct({
          state: CardStateRow,
          stability: Schema.Number,
          difficulty: Schema.Number,
          dueInDays: Schema.Number,
          dueAt: Schema.NullOr(Schema.String),
          reps: Schema.Number,
          lapses: Schema.Number,
          introducedDay: Schema.NullOr(Schema.String),
          lastReviewedAt: Schema.NullOr(Schema.String),
          buriedUntil: Schema.NullOr(Schema.String),
          reviewLapses: Schema.Number,
          suspended: Schema.NullOr(Schema.Number),
        }),
        snapshotRows,
      )
      const snapshot = snapshots[0]
      if (snapshot === undefined) return yield* new CardNotFound({ cardId: input.cardId })

      // Every statement is guarded on the review still being the Card's
      // latest, so a grade that lands after the reads above leaves the Card
      // alone instead of being overwritten by an older snapshot. The cards
      // go first and the review row last, so the guard holds throughout.
      const stillLatest = sql`(SELECT id FROM reviews WHERE card_id = ${input.cardId}
            ORDER BY reviewed_at DESC, rowid DESC LIMIT 1) = ${latest.id}`
      yield* runStatements([
        sql`UPDATE cards SET state = ${snapshot.state}, stability = ${snapshot.stability},
              difficulty = ${snapshot.difficulty}, due_in_days = ${snapshot.dueInDays},
              due_at = ${snapshot.dueAt},
              buried_until = ${snapshot.buriedUntil}, buried_sibling_of = NULL,
              introduced_day = ${snapshot.introducedDay},
              review_lapses = ${snapshot.reviewLapses},
              suspended = CASE WHEN ${latest.leechSuspended} = 1
                THEN COALESCE(${snapshot.suspended}, suspended) ELSE suspended END,
              reps = ${snapshot.reps}, lapses = ${snapshot.lapses},
              last_reviewed_at = ${snapshot.lastReviewedAt},
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ${input.cardId} AND ${stillLatest}`,
        sql`UPDATE cards SET buried_until = NULL, buried_sibling_of = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE buried_sibling_of = ${input.cardId} AND ${stillLatest}`,
        sql`DELETE FROM review_snapshots WHERE review_id = ${latest.id} AND ${stillLatest}`,
        sql`DELETE FROM reviews WHERE id = ${latest.id} AND ${stillLatest}`,
      ])

      return {
        cardId: input.cardId,
        state: snapshot.state,
        dueInDays: snapshot.dueInDays,
        stability: snapshot.stability,
        difficulty: snapshot.difficulty,
      } satisfies UndoAccepted
    }).pipe(Effect.withSpan('Reviews.undo'), (self) =>
      withStorageErrorPassThrough(self, 'undo the review'),
    )

  return undo
}
