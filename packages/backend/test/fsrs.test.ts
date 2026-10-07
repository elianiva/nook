import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Schema } from 'effect'
import {
  FSRS6_DEFAULT_WEIGHTS,
  initialDifficulty,
  initialStability,
  nextInterval,
  retrievability,
  scheduleReview,
} from '../src/fsrs'
import type { SchedulerCard, SchedulerSettings } from '../src/fsrs'

const weights = FSRS6_DEFAULT_WEIGHTS
const settings: SchedulerSettings = {
  weights,
  desiredRetention: 0.9,
  maximumInterval: 365,
}

const card = (overrides: Partial<SchedulerCard> = {}): SchedulerCard => ({
  stability: 10,
  difficulty: 5,
  state: 'review',
  reps: 5,
  lapses: 0,
  lastReviewedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  ...overrides,
})

describe('FSRS-6 primitives', () => {
  it('reads the initial Stability from the first four weights', () => {
    expect(initialStability(weights, 'Again')).toBe(0.212)
    expect(initialStability(weights, 'Hard')).toBe(1.2931)
    expect(initialStability(weights, 'Good')).toBe(2.3065)
    expect(initialStability(weights, 'Easy')).toBe(8.2956)
  })

  it('reads the initial Difficulty, clamped to 1–10', () => {
    expect(initialDifficulty(weights, 'Good')).toBeCloseTo(2.118, 2)
    // The exponential term drives Easy below the floor.
    expect(initialDifficulty(weights, 'Easy')).toBe(1)
  })

  it('anchors the forgetting curve so retrievability is 0.9 at the Stability', () => {
    expect(retrievability(weights, 10, 10)).toBeCloseTo(0.9, 6)
    expect(retrievability(weights, 0, 10)).toBeCloseTo(1, 6)
    expect(retrievability(weights, 30, 10)).toBeLessThan(0.9)
  })

  it.prop(
    'inverts retrievability: a scheduled interval recalls at the desired retention',
    [Arbitrary.schema(Schema.Natural).pipe(Arbitrary.map((value) => 5 + (value % 96)))],
    ([stability]) => {
      const interval = nextInterval(weights, stability, 0.9, 365)
      expect(retrievability(weights, interval, stability)).toBeCloseTo(0.9, 2)
    },
  )

  it('caps the interval at the maximum', () => {
    expect(nextInterval(weights, 10_000, 0.9, 365)).toBe(365)
    expect(nextInterval(weights, 100_000, 0.9, 36_500)).toBe(36_500)
  })
})

describe('scheduleReview', () => {
  const now = new Date('2026-10-05T10:00:00Z')
  const natural = Arbitrary.schema(Schema.Natural)
  const schedulerCard: Arbitrary.Arbitrary<SchedulerCard> = Arbitrary.all({
    stability: natural.pipe(Arbitrary.map((value) => 0.001 + (value % 3_650_000) / 100)),
    difficulty: natural.pipe(Arbitrary.map((value) => 1 + (value % 9_001) / 1_000)),
    state: Arbitrary.schema(Schema.Literals(['new', 'learning', 'review', 'relearning'])),
    reps: natural.pipe(Arbitrary.map((value) => value % 1_000)),
    lapses: natural.pipe(Arbitrary.map((value) => value % 100)),
    lastReviewedAt: natural.pipe(
      Arbitrary.map((value) => new Date(now.getTime() - (value % 5_270_000_000)).toISOString()),
    ),
  })
  const grade = Arbitrary.schema(Schema.Literals(['Again', 'Hard', 'Good', 'Easy']))

  it('uses the short-term formula for a same-day Review', () => {
    const sameDay = card({ lastReviewedAt: now.toISOString() })
    const good = scheduleReview(sameDay, 'Good', settings, now)
    expect(good.stability).toBeCloseTo(10, 6)
    const easy = scheduleReview(sameDay, 'Easy', settings, now)
    expect(easy.stability).toBeGreaterThan(10)
  })

  it.prop(
    'keeps scheduling invariants for every Card and Grade',
    [schedulerCard, grade],
    ([card, grade]) => {
      const scheduled = scheduleReview(card, grade, settings, now)
      const isNew = card.state === 'new' || card.reps === 0
      const isAgain = grade === 'Again'

      expect(Number.isFinite(scheduled.stability)).toBe(true)
      expect(scheduled.stability).toBeGreaterThanOrEqual(0.001)
      expect(scheduled.stability).toBeLessThanOrEqual(36_500)
      expect(scheduled.difficulty).toBeGreaterThanOrEqual(1)
      expect(scheduled.difficulty).toBeLessThanOrEqual(10)
      expect(scheduled.state).toBe(
        isNew ? (isAgain ? 'learning' : 'review') : isAgain ? 'relearning' : 'review',
      )
      if (isAgain) {
        expect(scheduled.intervalDays).toBe(0)
      } else {
        expect(scheduled.intervalDays).toBe(
          nextInterval(
            weights,
            scheduled.stability,
            settings.desiredRetention,
            settings.maximumInterval,
          ),
        )
        if (!isNew) expect(scheduled.stability).toBeGreaterThanOrEqual(card.stability)
      }
      expect(scheduled.intervalDays).toBeLessThanOrEqual(settings.maximumInterval)
      expect(scheduled.reps).toBe(isNew ? 1 : card.reps + 1)
      expect(scheduled.lapses).toBe(isNew ? Number(isAgain) : card.lapses + Number(isAgain))
    },
  )
})
