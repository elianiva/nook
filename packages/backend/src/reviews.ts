/**
 * `Reviews` — the review queue and the grade write.
 *
 * The queue reads the Cards that are due now plus the new Cards the day's
 * limit allows, joins each to its Note and Note Type, and renders both sides
 * with `@nook/anki/render`. The browser never holds the whole collection: it
 * asks for a queue and gets rendered Cards back.
 *
 * A grade is one append-only row in the Review log (ADR 0002) plus the Card's
 * derived scheduling state, written in one `db.batch` (ADR 0003). Replaying the
 * same submission id is idempotent. Distinct concurrent submissions for one
 * Card are not ordered here: both can read the same before-state and the last
 * batch can overwrite the other's schedule. The client serializes grades in
 * one tab; cross-tab ordering needs a server-side Card revision guard.
 *
 * The learner day starts at `dayRolloverHour` in the learner timezone, not at
 * UTC midnight: the per-day counts count Reviews since that boundary, while
 * due-ness compares `due_at` against now. Due instants land at the boundary,
 * never at review-minute plus N days. `Again` re-queues later this session
 * (after `lapseMinutes`); grading a Card buries its same-Note siblings until
 * the next day.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry). A Card id no Card answers to is a 404 `CardNotFound`.
 */

import { Context, Effect, Layer, Option } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import {
  CardId,
  CardNotFound,
  ReviewUndone,
  CollectionExport,
  DeckId,
  ReviewsRpc,
  StorageUnavailable,
} from '@nook/api'
import type { ReviewAccepted, ReviewQueue, ReviewSubmission, UndoAccepted } from '@nook/api'
import type { CardReviewHistory } from '@nook/api'
import { CurrentUser } from './users'
import { makeReads } from './reviews/reads'
import { makeQueue } from './reviews/queue'
import { makeGrade } from './reviews/grade'
import { makeUndo } from './reviews/undo'
import { makeHistory } from './reviews/history'
import { makeExportCollection } from './reviews/export-collection'

/**
 * Reviews read and write through the `SqlClient` the layer closes over, so the
 * service interface carries no requirements — see `Decks` for why.
 */
export class Reviews extends Context.Service<
  Reviews,
  {
    queue(input: {
      deckId: Option.Option<DeckId>
      timezone?: string | undefined
      bypassDueLimit?: boolean | undefined
    }): Effect.Effect<ReviewQueue, StorageUnavailable>
    grade(
      submission: ReviewSubmission,
    ): Effect.Effect<ReviewAccepted, CardNotFound | ReviewUndone | StorageUnavailable>
    undo(input: {
      cardId: CardId
      reviewId?: string | undefined
    }): Effect.Effect<UndoAccepted, CardNotFound | StorageUnavailable>
    history(input: {
      cardId: CardId
    }): Effect.Effect<CardReviewHistory, CardNotFound | StorageUnavailable>
    exportCollection(): Effect.Effect<CollectionExport, StorageUnavailable>
  }
>()('nook/backend/Reviews') {
  static readonly layer = Layer.effect(
    Reviews,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient
      const { id: userId } = yield* CurrentUser
      const { readFsrs, readCard } = makeReads(sql, userId)
      const deps = { sql, userId, readFsrs, readCard }

      return Reviews.of({
        queue: makeQueue(deps),
        grade: makeGrade(deps),
        undo: makeUndo(deps),
        history: makeHistory(deps),
        exportCollection: makeExportCollection(deps),
      })
    }),
  )
}

export const ReviewsHandlers = ReviewsRpc.toLayer(
  Effect.gen(function* () {
    const reviews = yield* Reviews
    return ReviewsRpc.of({
      reviewsQueue: ({ deckId, timezone, bypassDueLimit }) =>
        reviews.queue({
          deckId: Option.fromUndefinedOr(deckId),
          timezone,
          bypassDueLimit,
        }),
      reviewsGrade: (payload) => reviews.grade(payload),
      reviewsUndo: ({ cardId, reviewId }) => reviews.undo({ cardId, reviewId }),
      reviewsHistory: ({ cardId }) => reviews.history({ cardId }),
      reviewsExport: () => reviews.exportCollection(),
    })
  }),
)
