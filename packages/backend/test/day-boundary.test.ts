import { describe, expect, it } from 'vitest'
import { dayStartUtc, dueInstantUtc, reviewDayKey } from '../src/day-boundary'

describe('dayStartUtc', () => {
  it('starts the day at the rollover hour in the learner timezone', () => {
    // 10:00 UTC is 17:00 in Jakarta: the day started at 04:00 local, 21:00 UTC yesterday.
    expect(dayStartUtc('Asia/Jakarta', 4, new Date('2026-10-05T10:00:00Z'))).toBe(
      '2026-10-04T21:00:00Z',
    )
  })

  it('keeps early-morning reviews in the previous day', () => {
    // 19:00 UTC is 02:00 Jakarta the next morning: before the 04:00 rollover,
    // so the grade belongs to the previous learner-day.
    expect(dayStartUtc('Asia/Jakarta', 4, new Date('2026-10-04T19:00:00Z'))).toBe(
      '2026-10-03T21:00:00Z',
    )
    expect(reviewDayKey('Asia/Jakarta', 4, new Date('2026-10-04T19:00:00Z'))).toBe('2026-10-04')
    expect(reviewDayKey('Asia/Jakarta', 4, new Date('2026-10-05T10:00:00Z'))).toBe('2026-10-05')
  })

  it('falls back to UTC midnight arithmetic without a timezone shift', () => {
    expect(dayStartUtc('UTC', 4, new Date('2026-10-05T10:00:00Z'))).toBe('2026-10-05T04:00:00Z')
    expect(dayStartUtc('UTC', 4, new Date('2026-10-05T02:00:00Z'))).toBe('2026-10-04T04:00:00Z')
  })
})

describe('dueInstantUtc', () => {
  it('lands due instants at the learner-day boundary, not at review-minute', () => {
    const due = dueInstantUtc('2026-10-04T21:00:00Z', 3, new Date('2026-10-05T10:00:00Z'), 10)
    expect(due).toBe('2026-10-07T21:00:00Z')
  })

  it('returns now plus lapse minutes for an in-session interval', () => {
    const due = dueInstantUtc('2026-10-04T21:00:00Z', 0, new Date('2026-10-05T10:00:00Z'), 10)
    expect(due).toBe('2026-10-05T10:10:00Z')
  })
})
