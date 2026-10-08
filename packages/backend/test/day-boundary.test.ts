import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Schema } from 'effect'
import {
  dayKeyInTimezone,
  dayStartUtc,
  dayStartUtcForKey,
  dueInstantUtc,
  reviewDayKey,
} from '../src/day-boundary'

const DAY_MS = 86_400_000
const natural = Arbitrary.schema(Schema.Natural)
const timezone = Arbitrary.schema(
  Schema.Literals(['UTC', 'Asia/Jakarta', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney']),
)
const rolloverHour = natural.pipe(Arbitrary.map((value) => value % 24))
const instant = natural.pipe(
  Arbitrary.map((value) => new Date(Date.UTC(2000, 0, 1) + (value % (30 * 365 * DAY_MS)))),
)

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

  it('uses each historical day’s timezone offset across daylight-saving changes', () => {
    expect(dayStartUtcForKey('America/New_York', 4, '2026-10-31')).toBe('2026-10-31T08:00:00Z')
    expect(dayStartUtcForKey('America/New_York', 4, '2026-11-01')).toBe('2026-11-01T09:00:00Z')
  })

  it.prop(
    'returns the current learner-day boundary and key for any valid zone and rollover',
    [timezone, rolloverHour, instant],
    ([zone, hour, now]) => {
      const boundary = Date.parse(dayStartUtc(zone, hour, now))
      const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now)
      const part = (type: Intl.DateTimeFormatPartTypes): number =>
        Number(localParts.find((value) => value.type === type)?.value)
      const localMidnight = Date.UTC(part('year'), part('month') - 1, part('day'))
      const expectedDay = new Date(localMidnight - (part('hour') < hour ? DAY_MS : 0))

      expect(boundary).toBeLessThanOrEqual(now.getTime())
      expect(now.getTime() - boundary).toBeLessThan(DAY_MS + 60_000)
      expect(reviewDayKey(zone, hour, now)).toBe(dayKeyInTimezone('UTC', expectedDay))
    },
  )
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
