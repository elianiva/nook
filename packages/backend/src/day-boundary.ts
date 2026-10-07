/**
 * The learner-day boundary: when "today" starts for scheduling.
 *
 * UTC alone cuts the day at midnight for everyone. A learner in Jakarta who
 * reviews at 1am has not started a new day — the day rolls over at
 * `dayRolloverHour` in their timezone instead. These helpers compute that
 * boundary without new dependencies: the offset comes from `Intl`, and the
 * Worker stores the boundary as an ISO UTC instant every query compares
 * against.
 *
 * `packages/api` stays free of runtime behaviour, so this lives in
 * `@nook/backend` beside the services that use it.
 */

/** Whole minutes east of UTC for `timezone` at `instant`. West is negative. */
export const offsetMinutesAt = (timezone: string, instant: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return Math.round((asUtc - instant.getTime()) / 60_000)
}

/** `YYYY-MM-DD` of `instant` in `timezone`. */
export const dayKeyInTimezone = (timezone: string, instant: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

const toIsoUtc = (date: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  )
}

/**
 * The UTC instant the learner's day starts at, for `instant`.
 *
 * The boundary is `dayRolloverHour` in the learner timezone: a review before
 * that hour belongs to the previous day. Day-boundary arithmetic runs on
 * minute precision — DST shifts inside the hour are not modelled, and a day
 * with a DST transition keeps 24-hour spacing.
 */
export const dayStartUtc = (timezone: string, rolloverHour: number, instant: Date): string => {
  const offset = offsetMinutesAt(timezone, instant)
  const localMs = instant.getTime() + offset * 60_000
  const local = new Date(localMs)
  const day = local.getUTCDate()
  const rolled = local.getUTCHours() < rolloverHour ? day - 1 : day
  const startLocalMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    rolled,
    rolloverHour,
    0,
    0,
    0,
  )
  return toIsoUtc(new Date(startLocalMs - offset * 60_000))
}

/**
 * The day key a grade belongs to: the learner-day it was reviewed in.
 * Reviews before rollover count toward the previous day.
 */
export const reviewDayKey = (timezone: string, rolloverHour: number, instant: Date): string => {
  const offset = offsetMinutesAt(timezone, instant)
  const localMs = instant.getTime() + offset * 60_000 - rolloverHour * 3_600_000
  return dayKeyInTimezone('UTC', new Date(localMs))
}

/** The learner timezone, or UTC when the browser sends none. */
export const resolveTimezone = (timezone?: string): string =>
  timezone === undefined || timezone === '' ? 'UTC' : timezone

/**
 * The UTC instant a due Card comes back at: `intervalDays` learner-days after
 * the day that starts at `dayStart`, at the rollover hour.
 *
 * Due instants land at the start of a learner day, never at review-minute
 * plus N days, so a Card graded at 23:47 does not come back at 23:47.
 * Interval 0 means later today: `now + lapseMinutes`, for Again re-queue.
 */
export const dueInstantUtc = (
  dayStart: string,
  intervalDays: number,
  now: Date,
  lapseMinutes: number,
): string => {
  if (intervalDays <= 0) return toIsoUtc(new Date(now.getTime() + lapseMinutes * 60_000))
  const parsed = new Date(dayStart.endsWith('Z') ? dayStart : `${dayStart}Z`)
  const base = Number.isNaN(parsed.getTime()) ? now : parsed
  return toIsoUtc(new Date(base.getTime() + intervalDays * 86_400_000))
}
