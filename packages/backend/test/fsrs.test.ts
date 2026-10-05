import { describe, expect, it } from '@effect/vitest'
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

  it('inverts retrievability: a scheduled interval recalls at the desired retention', () => {
    for (const stability of [5, 10, 100]) {
      const interval = nextInterval(weights, stability, 0.9, 365)
      expect(retrievability(weights, interval, stability)).toBeCloseTo(0.9, 3)
    }
  })

  it('caps the interval at the maximum', () => {
    expect(nextInterval(weights, 10_000, 0.9, 365)).toBe(365)
    expect(nextInterval(weights, 100_000, 0.9, 36_500)).toBe(36_500)
  })
})

describe('scheduleReview', () => {
  const now = new Date('2026-10-05T10:00:00Z')

  it('schedules a new Card from its initial state', () => {
    const fresh: SchedulerCard = {
      stability: 0,
      difficulty: 1,
      state: 'new',
      reps: 0,
      lapses: 0,
      lastReviewedAt: null,
    }
    const good = scheduleReview(fresh, 'Good', settings, now)
    expect(good.state).toBe('review')
    expect(good.stability).toBe(2.3065)
    expect(good.reps).toBe(1)
    expect(good.lapses).toBe(0)
    expect(good.intervalDays).toBe(2)

    // `Again` re-queues later this session, after `lapseMinutes`: interval 0.
    expect(scheduleReview(fresh, 'Again', settings, now).intervalDays).toBe(0)
    expect(scheduleReview(fresh, 'Again', settings, now).state).toBe('learning')
    expect(scheduleReview(fresh, 'Again', settings, now).lapses).toBe(1)
    expect(scheduleReview(fresh, 'Easy', settings, now).intervalDays).toBe(8)
  })

  it('grows Stability and the interval on a successful Review', () => {
    const scheduled = scheduleReview(card(), 'Good', settings, now)
    expect(scheduled.state).toBe('review')
    expect(scheduled.stability).toBeGreaterThan(10)
    expect(scheduled.intervalDays).toBe(Math.round(scheduled.stability))
    expect(scheduled.intervalDays).toBeGreaterThan(10)
    expect(scheduled.reps).toBe(6)
    expect(scheduled.lapses).toBe(0)
  })

  it('counts a lapse and moves the Card to relearning', () => {
    const scheduled = scheduleReview(card(), 'Again', settings, now)
    expect(scheduled.state).toBe('relearning')
    expect(scheduled.lapses).toBe(1)
    expect(scheduled.reps).toBe(6)
    expect(scheduled.stability).toBeLessThan(10)
    // Interval 0: the Card returns later this session, not tomorrow.
    expect(scheduled.intervalDays).toBe(0)
  })

  it('uses the short-term formula for a same-day Review', () => {
    const sameDay = card({ lastReviewedAt: now.toISOString() })
    const good = scheduleReview(sameDay, 'Good', settings, now)
    expect(good.stability).toBeCloseTo(10, 6)
    const easy = scheduleReview(sameDay, 'Easy', settings, now)
    expect(easy.stability).toBeGreaterThan(10)
  })

  it('is deterministic', () => {
    const first = scheduleReview(card(), 'Hard', settings, now)
    const second = scheduleReview(card(), 'Hard', settings, now)
    expect(first).toEqual(second)
  })
})
