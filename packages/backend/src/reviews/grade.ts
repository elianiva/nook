/**
 * The grade write: one Review row plus the Card's derived schedule.
 */

import { Effect, Schema } from 'effect'
import { CardNotFound, ReviewUndone, StorageUnavailable } from '@nook/api'
import type { ReviewAccepted, ReviewSubmission } from '@nook/api'
import { runStatements } from '../batch'
import { dayStartUtc, dueInstantUtc, resolveTimezone, reviewDayKey } from '../day-boundary'
import { scheduleReview } from '../fsrs'
import { decodeRows, withStorageErrorPassThrough } from '../storage-error'
import type { StorageError } from '../storage-error'
import type { ReviewsDeps } from './reads'
import { DeckLimitsRow, isLeechWarning } from './rows'

/**
 * How many times a grade re-reads its Card after another grade or undo landed
 * first. Each loss means a competing write won, so a few rounds is plenty.
 */
const MAX_ATTEMPTS = 4

export const makeGrade = ({ sql, userId, readFsrs, readCard }: ReviewsDeps) => {
  const attempt = (
    submission: ReviewSubmission,
    remaining: number,
  ): Effect.Effect<
    ReviewAccepted,
    CardNotFound | ReviewUndone | StorageUnavailable | StorageError
  > =>
    Effect.gen(function* () {
      const card = yield* readCard(submission.cardId)
      if (card === undefined) {
        yield* Effect.logWarning('grade for unknown card').pipe(
          Effect.annotateLogs({
            cardId: submission.cardId,
            reviewId: submission.id,
          }),
        )
        return yield* new CardNotFound({ cardId: submission.cardId })
      }

      const undoneRows = yield* sql`SELECT review_id FROM undone_reviews
            WHERE user_id = ${userId} AND review_id = ${submission.id}`
      if (undoneRows.length > 0) {
        // The grade landed and was then undone. Applying it now would
        // resurrect a grade the Learner took back.
        return yield* new ReviewUndone({ reviewId: submission.id })
      }

      const replayRows = yield* sql`SELECT leech_suspended AS "leechSuspended"
            FROM reviews WHERE user_id = ${userId} AND id = ${submission.id}`
      const replay = yield* decodeRows(Schema.Struct({ leechSuspended: Schema.Number }), replayRows)
      const replayed = replay[0]
      if (replayed !== undefined) {
        // The grade already landed; report the Card as it stands.
        return {
          cardId: submission.cardId,
          grade: submission.grade,
          state: card.state,
          dueInDays: card.dueInDays,
          stability: card.stability,
          difficulty: card.difficulty,
          reviewLapses: card.reviewLapses,
          intervalDays: card.dueInDays,
          dueAt: card.dueAt ?? new Date().toISOString(),
          requeueInSession: false,
          leechSuspended: replayed.leechSuspended === 1,
        } satisfies ReviewAccepted
      }

      const fsrs = yield* readFsrs
      const now = new Date()
      const timezone = resolveTimezone(submission.timezone)
      const deckLimitsRows = yield* sql`SELECT new_per_day AS "newPerDay",
            reviews_per_day AS "reviewsPerDay", lapse_minutes AS "lapseMinutes"
            FROM decks WHERE user_id = ${userId} AND id = ${card.deckId}`
      const deckLimitsDecoded = yield* decodeRows(DeckLimitsRow, deckLimitsRows)
      const deckOverride = deckLimitsDecoded[0]
      // The graded Card's own Deck sets its lapse: a deck page's override
      // follows the Card there, without a new wire field.
      const lapseMinutes = deckOverride?.lapseMinutes ?? fsrs.lapseMinutes
      const boundary = dayStartUtc(timezone, fsrs.dayRolloverHour, now)
      const todayKey = reviewDayKey(timezone, fsrs.dayRolloverHour, now)
      const scheduled = scheduleReview(
        {
          stability: card.stability,
          difficulty: card.difficulty,
          state: card.state,
          reps: card.reps,
          lapses: card.lapses,
          lastReviewedAt: card.lastReviewedAt,
        },
        submission.grade,
        {
          weights: fsrs.weights.split(',').map(Number),
          desiredRetention: fsrs.desiredRetention,
          maximumInterval: fsrs.maximumInterval,
        },
        now,
      )
      const interval = scheduled.intervalDays
      const requeueInSession = submission.grade === 'Again'
      const reviewLapses =
        card.reviewLapses + (card.state === 'review' && submission.grade === 'Again' ? 1 : 0)
      const leechSuspended =
        card.state === 'review' && submission.grade === 'Again' && isLeechWarning(reviewLapses)
      // `Again` re-queues later this session, after `lapseMinutes`: the
      // Card buries until then so the queue skips it until it is due.
      // Passing grades bury until the next boundary at the earliest — a
      // sub-day FSRS interval still waits for tomorrow.
      const requeueAt = new Date(now.getTime() + lapseMinutes * 60_000).toISOString()
      const dueAt = requeueInSession
        ? requeueAt
        : dueInstantUtc(boundary, Math.max(1, interval), now, lapseMinutes)
      const buriedUntil = requeueInSession ? requeueAt : null

      // The Review row, its before-grade snapshot, and the Card's new state
      // land together; the deck's last-studied stamp rides along. D1 runs
      // the batch atomically. Siblings — other Cards from the same Note —
      // bury until the next day, so one Note never shows two Cards in a
      // session.
      const nextDay = dueInstantUtc(boundary, 1, now, lapseMinutes)
      // Every statement is guarded on the Card still being at the version
      // this grade read (`grade_seq`), so a grade or undo that landed after
      // the reads above makes the whole batch a no-op instead of being
      // overwritten by a schedule computed from stale state. The Card's own
      // update goes last: it bumps the version, which is the commit point.
      const versionHeld = sql`(SELECT grade_seq FROM cards WHERE user_id = ${userId} AND id = ${submission.cardId}) = ${card.gradeSeq}`
      const written = sql`EXISTS (SELECT 1 FROM review_snapshots WHERE user_id = ${userId} AND review_id = ${submission.id})`
      const statements = [
        sql`INSERT INTO reviews (user_id, id, card_id, grade, reviewed_at, leech_suspended,
              state_after, stability_after, difficulty_after, due_in_days_after, due_at_after)
              SELECT ${userId}, ${submission.id}, ${submission.cardId}, ${submission.grade},
              strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ${leechSuspended ? 1 : 0},
              ${scheduled.state}, ${scheduled.stability}, ${scheduled.difficulty}, ${interval}, ${dueAt}
              WHERE ${versionHeld}
              AND NOT EXISTS (SELECT 1 FROM undone_reviews WHERE user_id = ${userId} AND review_id = ${submission.id})
              AND NOT EXISTS (SELECT 1 FROM reviews WHERE user_id = ${userId} AND id = ${submission.id})`,
        sql`INSERT INTO review_snapshots (user_id, review_id, card_id, state, stability, difficulty,
              due_in_days, due_at, reps, lapses, introduced_day, last_reviewed_at, buried_until,
              review_lapses, suspended)
              SELECT ${userId}, ${submission.id}, ${submission.cardId}, ${card.state}, ${card.stability},
              ${card.difficulty}, ${card.dueInDays}, ${card.dueAt}, ${card.reps}, ${card.lapses},
              ${card.introducedDay}, ${card.lastReviewedAt}, ${card.buriedUntil},
              ${card.reviewLapses}, ${card.suspended}
              WHERE ${versionHeld}
              AND EXISTS (SELECT 1 FROM reviews WHERE user_id = ${userId} AND id = ${submission.id})
              AND NOT ${written}`,
        ...(card.noteId === null
          ? []
          : [
              sql`UPDATE cards SET buried_until = ${nextDay},
                    buried_sibling_of = ${submission.cardId},
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                    WHERE user_id = ${userId} AND note_id = ${card.noteId} AND id != ${submission.cardId}
                    AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                    AND ${versionHeld} AND ${written}`,
            ]),
        sql`UPDATE decks SET last_studied_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE user_id = ${userId} AND id = ${card.deckId} AND ${versionHeld} AND ${written}`,
        sql`UPDATE cards SET state = ${scheduled.state}, stability = ${scheduled.stability},
              difficulty = ${scheduled.difficulty}, due_in_days = ${requeueInSession ? 0 : interval},
              due_at = ${dueAt},
              review_lapses = ${reviewLapses},
              suspended = CASE WHEN ${leechSuspended ? 1 : 0} = 1 THEN 1 ELSE suspended END,
              buried_until = ${buriedUntil}, buried_sibling_of = NULL,
              introduced_day = CASE WHEN state = 'new' THEN ${todayKey} ELSE introduced_day END,
              reps = ${scheduled.reps}, lapses = ${scheduled.lapses},
              last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              grade_seq = grade_seq + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE user_id = ${userId} AND id = ${submission.cardId} AND ${versionHeld} AND ${written}`,
      ]
      yield* runStatements(statements)

      const landed =
        yield* sql`SELECT id FROM reviews WHERE user_id = ${userId} AND id = ${submission.id}`
      if (landed.length === 0) {
        // The guard held the batch back: an undo took this id, or another
        // grade moved the Card first. Re-read and schedule on top of it.
        const undone = yield* sql`SELECT review_id FROM undone_reviews
              WHERE user_id = ${userId} AND review_id = ${submission.id}`
        if (undone.length > 0) return yield* new ReviewUndone({ reviewId: submission.id })
        if (remaining <= 1) {
          return yield* new StorageUnavailable({
            message: 'Could not save the review: the Card kept changing. Try again.',
          })
        }
        return yield* attempt(submission, remaining - 1)
      }

      return {
        cardId: submission.cardId,
        grade: submission.grade,
        state: scheduled.state,
        dueInDays: interval,
        stability: scheduled.stability,
        difficulty: scheduled.difficulty,
        reviewLapses,
        intervalDays: interval,
        dueAt,
        requeueInSession,
        leechSuspended,
      } satisfies ReviewAccepted
    })

  const grade = (
    submission: ReviewSubmission,
  ): Effect.Effect<ReviewAccepted, CardNotFound | ReviewUndone | StorageUnavailable> =>
    attempt(submission, MAX_ATTEMPTS).pipe(
      Effect.annotateLogs({
        cardId: submission.cardId,
        reviewId: submission.id,
      }),
      Effect.withSpan('Reviews.grade'),
      (self) => withStorageErrorPassThrough(self, 'save the review'),
    )

  return grade
}
