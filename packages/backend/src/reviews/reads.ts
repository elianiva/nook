/**
 * Reads shared by the review operations.
 */

import { Effect } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { CardId, StorageUnavailable } from '@nook/api'
import { decodeRows } from '../storage-error'
import type { StorageError } from '../storage-error'
import { CardRow, FsrsRow } from './rows'

/** What every review operation closes over. */
export type ReviewsDeps = {
  readonly sql: Sql.SqlClient
  readonly readFsrs: ReturnType<typeof makeReads>['readFsrs']
  readonly readCard: ReturnType<typeof makeReads>['readCard']
}

/** The shared reads: the FSRS settings row and one Card row. */
export const makeReads = (sql: Sql.SqlClient) => {
  const readFsrs = Effect.gen(function* () {
    const rows = yield* sql`SELECT fsrs_weights AS weights,
          fsrs_desired_retention AS "desiredRetention",
          fsrs_maximum_interval AS "maximumInterval",
          fsrs_new_per_day AS "newPerDay",
          fsrs_reviews_per_day AS "reviewsPerDay",
          fsrs_lapse_minutes AS "lapseMinutes",
          behaviour_day_rollover_hour AS "dayRolloverHour"
          FROM settings WHERE id = 1`
    const decoded = yield* decodeRows(FsrsRow, rows)
    const row = decoded[0]
    if (row === undefined) {
      return yield* new StorageUnavailable({
        message: 'Could not read the scheduler settings. The settings store is missing its row.',
      })
    }
    return row
  })

  const readCard = (cardId: CardId): Effect.Effect<typeof CardRow.Type | undefined, StorageError> =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT id AS "cardId", deck_id AS "deckId", state, stability,
            difficulty, COALESCE(reps, 0) AS reps, COALESCE(lapses, 0) AS lapses,
            COALESCE(review_lapses, 0) AS "reviewLapses", suspended,
            COALESCE(CAST(julianday(due_at) - julianday('now') AS INTEGER), 0) AS "dueInDays",
            due_at AS "dueAt", note_id AS "noteId", introduced_day AS "introducedDay",
            buried_until AS "buriedUntil",
            last_reviewed_at AS "lastReviewedAt"
            FROM cards WHERE id = ${cardId}`
      const decoded = yield* decodeRows(CardRow, rows)
      return decoded[0]
    })

  return { readFsrs, readCard }
}
