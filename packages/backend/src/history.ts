import type { ImportReview } from '@nook/api'
import { scheduleReview } from './fsrs'
import type { CardState, SchedulerSettings } from './fsrs'

/**
 * Replays a Card's Anki review history through FSRS-6.
 *
 * Anki's own scheduler state (SM-2 ease and interval, or Anki's FSRS memory
 * state) is not read. What carries across is the one thing both schedulers
 * share: which button was pressed, and when. Feeding those, in order, through
 * the same `scheduleReview` that grades a live Review makes the seeded Stability
 * and Difficulty exactly what nook would hold had the Learner pressed the same
 * buttons here. The Learner's own FSRS weights apply, so a collection scheduled
 * under other weights is re-derived under nook's.
 *
 * The replay is a pure function of the history and the settings, which is what
 * lets an Import batch retry without drifting.
 */

/** One replayed Review: the Review row nook stores, with its after-state. */
export interface ReplayedReview {
  readonly id: string
  readonly cardId: string
  readonly grade: ImportReview['grade']
  readonly reviewedAt: string
  readonly state: CardState
  readonly stability: number
  readonly difficulty: number
  readonly dueInDays: number
  readonly dueAt: string
}

/** The Card's scheduling state after its last replayed Review. */
export interface ReplayedCard {
  readonly state: CardState
  readonly stability: number
  readonly difficulty: number
  readonly dueInDays: number
  readonly dueAt: string
  readonly reps: number
  readonly lapses: number
  /** Failed Reviews of a Card that was in review mode: the leech counter's input. */
  readonly reviewLapses: number
  readonly lastReviewedAt: string
  /** The learner-day of the first Review, as `YYYY-MM-DD` in UTC, so an old Card is never "introduced today". */
  readonly introducedDay: string
}

export interface Replay {
  readonly reviews: ReadonlyArray<ReplayedReview>
  readonly card: ReplayedCard
}

const DAY_MS = 86_400_000

/** ISO 8601 UTC at second precision, the format the `strftime` columns use. */
const instant = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The id of the `reviews` row an Anki Review becomes. Keyed by Card as well, so two archives cannot collide. */
export const importedReviewId = (cardId: number, reviewId: number): string =>
  `anki-${cardId}-${reviewId}`

/** Prefix shared by every imported Review id. A Review without it was graded in nook. */
export const IMPORTED_REVIEW_PREFIX = 'anki-'

/**
 * Replays one Card's history, or answers `undefined` when it has none.
 *
 * `reviews` need not be sorted, but must all belong to one Card. `lapseMinutes`
 * sets when an `Again` returns, matching the live grade path.
 */
export const replayHistory = (
  reviews: ReadonlyArray<ImportReview>,
  settings: SchedulerSettings,
  lapseMinutes: number,
): Replay | undefined => {
  const ordered = [...reviews].sort((a, b) => a.id - b.id)
  const first = ordered[0]
  if (first === undefined) return undefined

  let card = {
    stability: 0,
    difficulty: 1,
    state: 'new' as CardState,
    reps: 0,
    lapses: 0,
    lastReviewedAt: null as string | null,
  }
  let reviewLapses = 0
  let last: ReplayedCard | undefined
  const replayed: Array<ReplayedReview> = []

  for (const review of ordered) {
    const reviewedAt = instant(review.id)
    const scheduled = scheduleReview(card, review.grade, settings, new Date(review.id))
    const again = review.grade === 'Again'
    if (card.state === 'review' && again) reviewLapses += 1
    const dueInDays = again ? 0 : scheduled.intervalDays
    const dueAt = instant(
      review.id + (again ? lapseMinutes * 60_000 : Math.max(1, scheduled.intervalDays) * DAY_MS),
    )

    replayed.push({
      id: importedReviewId(review.cardId, review.id),
      cardId: String(review.cardId),
      grade: review.grade,
      reviewedAt,
      state: scheduled.state,
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      dueInDays,
      dueAt,
    })
    card = {
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      state: scheduled.state,
      reps: scheduled.reps,
      lapses: scheduled.lapses,
      lastReviewedAt: reviewedAt,
    }
    last = {
      state: scheduled.state,
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      dueInDays,
      dueAt,
      reps: scheduled.reps,
      lapses: scheduled.lapses,
      reviewLapses,
      lastReviewedAt: reviewedAt,
      introducedDay: instant(first.id).slice(0, 10),
    }
  }

  return last === undefined ? undefined : { reviews: replayed, card: last }
}
