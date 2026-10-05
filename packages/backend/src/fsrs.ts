/**
 * FSRS-6: the scheduler that decides when a Card comes back.
 *
 * The algorithm is deterministic, so the same Card, Grade, and settings always
 * produce the same next state. nook runs it on the server today; the ADRs keep
 * the door open for the device to run the same code offline.
 *
 * The formulas follow the FSRS-6 reference (`fsrs-rs` `src/model_v6.rs` and
 * `ts-fsrs` `packages/fsrs/src/algorithm.ts`). Two constants are load-bearing:
 * the decay `DECAY = -w20`, and `FACTOR = 0.9^{1/DECAY} - 1`, which anchors the
 * forgetting curve so that retrievability equals `0.9` when elapsed time equals
 * Stability.
 *
 * nook schedules in whole days, because the schema stores a day interval. A
 * Card graded `Again` comes back the next day at the earliest.
 */

/** The Grade a Learner gives a Review. The integer order is FSRS's rating. */
export type Grade = 'Again' | 'Hard' | 'Good' | 'Easy'

/** Where a Card is in its life. */
export type CardState = 'new' | 'learning' | 'review' | 'relearning'

/** FSRS-6's default weight vector, used for any weight the settings omit. */
export const FSRS6_DEFAULT_WEIGHTS: ReadonlyArray<number> = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]

/** The smallest Stability FSRS allows. */
const S_MIN = 0.001

/** The largest Stability FSRS allows. */
const S_MAX = 36_500

/** Difficulty runs 1–10. */
const D_MIN = 1
const D_MAX = 10

/** The rating integers, by Grade. */
const RATING: Record<Grade, number> = { Again: 1, Hard: 2, Good: 3, Easy: 4 }

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

/** A Card's scheduling state, as the scheduler reads it. */
export interface SchedulerCard {
  readonly stability: number
  readonly difficulty: number
  readonly state: CardState
  /** How many Reviews this Card has had. */
  readonly reps: number
  /** How many of those Reviews were `Again`. */
  readonly lapses: number
  /** When the Card was last reviewed, ISO 8601. `null` for a new Card. */
  readonly lastReviewedAt: string | null
}

/** The scheduling knobs the Settings page owns. */
export interface SchedulerSettings {
  readonly weights: ReadonlyArray<number>
  readonly desiredRetention: number
  readonly maximumInterval: number
}

/** A Card's scheduling state after a Review. */
export interface ScheduledCard {
  readonly stability: number
  readonly difficulty: number
  readonly state: CardState
  readonly intervalDays: number
  readonly reps: number
  readonly lapses: number
}

/** The weight at `index`, falling back to the FSRS-6 default when the settings vector is short. */
const weightAt = (weights: ReadonlyArray<number>, index: number): number =>
  weights[index] ?? FSRS6_DEFAULT_WEIGHTS[index] ?? 0

/** `DECAY` and `FACTOR`, derived from the decay weight `w20`. */
const decayFactor = (weights: ReadonlyArray<number>): { decay: number; factor: number } => {
  const decay = -weightAt(weights, 20)
  const factor = Math.exp(Math.log(0.9) / decay) - 1
  return { decay, factor }
}

/** Initial Stability for a first Review: `S0(G) = max(w[G-1], 0.1)`. */
export const initialStability = (weights: ReadonlyArray<number>, grade: Grade): number =>
  Math.max(weightAt(weights, RATING[grade] - 1), 0.1)

/** Initial Difficulty: `D0(G) = w4 - e^{(G-1)w5} + 1`, clamped to 1–10. */
export const initialDifficulty = (weights: ReadonlyArray<number>, grade: Grade): number => {
  const rating = RATING[grade]
  const value = weightAt(weights, 4) - Math.exp((rating - 1) * weightAt(weights, 5)) + 1
  return clamp(value, D_MIN, D_MAX)
}

/** Difficulty after a Review, with linear damping and mean reversion toward `D0(Easy)`. */
export const nextDifficulty = (
  weights: ReadonlyArray<number>,
  difficulty: number,
  grade: Grade,
): number => {
  const delta = -weightAt(weights, 6) * (RATING[grade] - 3)
  const damped = difficulty + ((10 - difficulty) / 9) * delta
  const target = initialDifficulty(weights, 'Easy')
  const reverted = weightAt(weights, 7) * target + (1 - weightAt(weights, 7)) * damped
  return clamp(reverted, D_MIN, D_MAX)
}

/** The probability the Learner recalls a Card after `elapsedDays`, given `stability`. */
export const retrievability = (
  weights: ReadonlyArray<number>,
  elapsedDays: number,
  stability: number,
): number => {
  const { decay, factor } = decayFactor(weights)
  return Math.pow(1 + (factor * elapsedDays) / Math.max(stability, S_MIN), decay)
}

/** Stability after a successful Review. */
const stabilityAfterSuccess = (
  weights: ReadonlyArray<number>,
  stability: number,
  retrievabilityValue: number,
  difficulty: number,
  grade: Grade,
): number => {
  const hardPenalty = grade === 'Hard' ? weightAt(weights, 15) : 1
  const easyBonus = grade === 'Easy' ? weightAt(weights, 16) : 1
  const growth =
    Math.exp(weightAt(weights, 8)) *
      (11 - difficulty) *
      Math.pow(stability, -weightAt(weights, 9)) *
      (Math.exp((1 - retrievabilityValue) * weightAt(weights, 10)) - 1) *
      hardPenalty *
      easyBonus +
    1
  return clamp(stability * growth, S_MIN, S_MAX)
}

/** Stability after a lapse (an `Again` on a Card that was not new). */
const stabilityAfterFailure = (
  weights: ReadonlyArray<number>,
  stability: number,
  retrievabilityValue: number,
  difficulty: number,
): number => {
  const value =
    weightAt(weights, 11) *
    Math.pow(difficulty, -weightAt(weights, 12)) *
    (Math.pow(stability + 1, weightAt(weights, 13)) - 1) *
    Math.exp((1 - retrievabilityValue) * weightAt(weights, 14))
  return clamp(value, S_MIN, S_MAX)
}

/** Stability for a Review that happens the same day, before any real forgetting. */
const shortTermStability = (
  weights: ReadonlyArray<number>,
  stability: number,
  grade: Grade,
): number => {
  const rating = RATING[grade]
  const sinc =
    Math.exp(weightAt(weights, 17) * (rating - 3 + weightAt(weights, 18))) *
    Math.pow(stability, -weightAt(weights, 19))
  const masked = rating >= 2 ? Math.max(sinc, 1) : sinc
  return clamp(stability * masked, S_MIN, S_MAX)
}

/** The whole-day interval for a Stability, at the desired retention. */
export const nextInterval = (
  weights: ReadonlyArray<number>,
  stability: number,
  desiredRetention: number,
  maximumInterval: number,
): number => {
  const { decay, factor } = decayFactor(weights)
  const retention = clamp(desiredRetention, 0.0001, 0.9999)
  const raw = (Math.max(stability, S_MIN) / factor) * (Math.pow(retention, 1 / decay) - 1)
  return clamp(Math.round(raw), 1, Math.max(1, maximumInterval))
}

/** Whole days between two instants, floored at 0. */
const elapsedDays = (lastReviewedAt: string | null, now: Date): number => {
  if (lastReviewedAt === null) return 0
  const last = new Date(lastReviewedAt)
  if (Number.isNaN(last.getTime())) return 0
  return Math.max(0, Math.floor((now.getTime() - last.getTime()) / 86_400_000))
}

/**
 * Schedules the next Review of `card` after `grade`.
 *
 * A Card that has never been reviewed takes its initial Stability and
 * Difficulty. Every other Card is scored against how much it has been
 * forgotten: `Again` is a lapse, and the rest grow Stability. A Review on the
 * same day uses the short-term formula, which grows Stability without the
 * forgetting curve.
 */
export const scheduleReview = (
  card: SchedulerCard,
  grade: Grade,
  settings: SchedulerSettings,
  now: Date,
): ScheduledCard => {
  const weights = settings.weights
  const intervalFor = (stability: number): number =>
    nextInterval(weights, stability, settings.desiredRetention, settings.maximumInterval)

  if (card.state === 'new' || card.reps === 0) {
    const stability = initialStability(weights, grade)
    return {
      stability,
      difficulty: initialDifficulty(weights, grade),
      state: grade === 'Again' ? 'learning' : 'review',
      intervalDays: intervalFor(stability),
      reps: 1,
      lapses: grade === 'Again' ? 1 : 0,
    }
  }

  const elapsed = elapsedDays(card.lastReviewedAt, now)
  const difficulty = nextDifficulty(weights, card.difficulty, grade)

  if (grade === 'Again') {
    const stability =
      elapsed === 0
        ? shortTermStability(weights, card.stability, grade)
        : stabilityAfterFailure(
            weights,
            card.stability,
            retrievability(weights, elapsed, card.stability),
            card.difficulty,
          )
    return {
      stability,
      difficulty,
      state: 'relearning',
      intervalDays: intervalFor(stability),
      reps: card.reps + 1,
      lapses: card.lapses + 1,
    }
  }

  const stability =
    elapsed === 0
      ? shortTermStability(weights, card.stability, grade)
      : stabilityAfterSuccess(
          weights,
          card.stability,
          retrievability(weights, elapsed, card.stability),
          card.difficulty,
          grade,
        )
  return {
    stability,
    difficulty,
    state: 'review',
    intervalDays: intervalFor(stability),
    reps: card.reps + 1,
    lapses: card.lapses,
  }
}
