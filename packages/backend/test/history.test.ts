import { describe, expect, it } from '@effect/vitest'
import type { ImportReview } from '@nook/api'
import { FSRS6_DEFAULT_WEIGHTS, scheduleReview } from '../src/fsrs'
import type { SchedulerSettings } from '../src/fsrs'
import { importedReviewId, replayHistory } from '../src/history'

const settings: SchedulerSettings = {
  weights: FSRS6_DEFAULT_WEIGHTS,
  desiredRetention: 0.9,
  maximumInterval: 36_500,
}

const DAY = 86_400_000
const T0 = Date.UTC(2024, 0, 10, 12, 0, 0)

const review = (id: number, grade: ImportReview['grade'], cardId = 5): ImportReview => ({
  id,
  cardId,
  grade,
})

describe('replayHistory', () => {
  it('answers nothing for a Card with no history', () => {
    expect(replayHistory([], settings, 10)).toBeUndefined()
  })

  it('seeds a first Good from the initial weights, then grows Stability after a gap', () => {
    const replay = replayHistory([review(T0, 'Good'), review(T0 + 3 * DAY, 'Good')], settings, 10)
    expect(replay?.reviews).toHaveLength(2)

    // First Review: S0(Good) = w2, D0(Good) = w4 - e^(2 w5) + 1.
    const first = replay?.reviews[0]
    expect(first?.stability).toBeCloseTo(2.3065, 4)
    expect(first?.difficulty).toBeCloseTo(2.118, 2)
    expect(first?.state).toBe('review')
    expect(first?.dueInDays).toBe(2)
    expect(first?.dueAt).toBe('2024-01-12T12:00:00Z')

    // Second Review, 3 days on, R is about 0.881 and Stability grows to about 13.8.
    const card = replay?.card
    expect(card?.stability).toBeCloseTo(13.8, 0)
    expect(card?.reps).toBe(2)
    expect(card?.lapses).toBe(0)
    expect(card?.lastReviewedAt).toBe('2024-01-13T12:00:00Z')
    expect(card?.introducedDay).toBe('2024-01-10')
    // A due date 14 days after the last Review, not relative to today.
    expect(card?.dueInDays).toBe(14)
    expect(card?.dueAt).toBe('2024-01-27T12:00:00Z')
  })

  it('matches grading the same buttons live, one Review at a time', () => {
    const grades = ['Hard', 'Good', 'Again', 'Good', 'Easy'] as const
    const gaps = [0, 2, 9, 1, 6]
    let at = T0
    const history = grades.map((grade, index) => {
      at += (gaps[index] ?? 0) * DAY + 3_600_000
      return review(at, grade)
    })

    let live = {
      stability: 0,
      difficulty: 1,
      state: 'new' as 'new' | 'learning' | 'review' | 'relearning',
      reps: 0,
      lapses: 0,
      lastReviewedAt: null as string | null,
    }
    for (const step of history) {
      const next = scheduleReview(live, step.grade, settings, new Date(step.id))
      live = {
        stability: next.stability,
        difficulty: next.difficulty,
        state: next.state,
        reps: next.reps,
        lapses: next.lapses,
        lastReviewedAt: new Date(step.id).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }
    }

    const replay = replayHistory(history, settings, 10)
    expect(replay?.card).toMatchObject({
      stability: live.stability,
      difficulty: live.difficulty,
      state: live.state,
      reps: live.reps,
      lapses: live.lapses,
    })
  })

  it('counts a leech lapse only for Again on a Card already in review', () => {
    // Again on a new Card is a learning step. Again after Good is a lapse.
    const replay = replayHistory(
      [review(T0, 'Again'), review(T0 + DAY, 'Good'), review(T0 + 5 * DAY, 'Again')],
      settings,
      10,
    )
    expect(replay?.reviews.map((step) => step.state)).toEqual(['learning', 'review', 'relearning'])
    expect(replay?.card.reviewLapses).toBe(1)
    expect(replay?.card.state).toBe('relearning')
    // An Again re-queues after the lapse delay rather than a day.
    expect(replay?.card.dueInDays).toBe(0)
    expect(replay?.card.dueAt).toBe('2024-01-15T12:10:00Z')
  })

  it('sorts by time, so a shuffled history seeds the same state', () => {
    const history = [review(T0, 'Good'), review(T0 + 2 * DAY, 'Hard'), review(T0 + 9 * DAY, 'Good')]
    const shuffled = [history[2], history[0], history[1]] as ReadonlyArray<ImportReview>
    expect(replayHistory(shuffled, settings, 10)).toEqual(replayHistory(history, settings, 10))
  })

  it('names each Review by Card and Anki id, so two Cards never collide', () => {
    expect(importedReviewId(5, 1_700_000_000_000)).toBe('anki-5-1700000000000')
    const replay = replayHistory([review(T0, 'Good', 5)], settings, 10)
    expect(replay?.reviews[0]?.id).toBe(`anki-5-${T0}`)
    expect(replay?.reviews[0]?.cardId).toBe('5')
  })

  it('handles two Reviews in the same minute without a gap', () => {
    const replay = replayHistory([review(T0, 'Again'), review(T0 + 60_000, 'Good')], settings, 10)
    expect(replay?.card.reps).toBe(2)
    expect(Number.isFinite(replay?.card.stability)).toBe(true)
    expect(replay?.card.state).toBe('review')
  })
})
