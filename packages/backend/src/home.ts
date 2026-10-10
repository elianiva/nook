import { Context, Effect, Layer, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { HomeRpc, StorageUnavailable } from '@nook/api'
import type { Overview } from '@nook/api'
import { dayStartUtc, dayStartUtcForKey, resolveTimezone, reviewDayKey } from './day-boundary'
import { decodeRows, withStorageErrorPassThrough, CountRow } from './storage-error'

const NewRow = Schema.Struct({
  newCount: Schema.Number,
  introduced: Schema.Number,
  limit: Schema.Number,
})

const SettingsRow = Schema.Struct({ dayRolloverHour: Schema.Number })

const learnerDayActivity = (
  sql: Sql.SqlClient,
  timezone: string,
  rolloverHour: number,
  days: ReadonlyArray<string>,
) => {
  const earliestDay = days[0]
  if (earliestDay === undefined) return Effect.succeed([] as ReadonlyArray<number>)
  const counts = sql.csv(
    days.map((day, index) => {
      const date = new Date(`${day}T00:00:00Z`)
      date.setUTCDate(date.getUTCDate() + 1)
      const nextDay = date.toISOString().slice(0, 10)
      const start = dayStartUtcForKey(timezone, rolloverHour, day)
      const end = dayStartUtcForKey(timezone, rolloverHour, nextDay)
      return sql`COUNT(CASE WHEN julianday(reviewed_at) >= julianday(${start})
        AND julianday(reviewed_at) < julianday(${end}) THEN 1 END)
        AS ${sql(`day${index}`)}`
    }),
  )
  const earliestStart = dayStartUtcForKey(timezone, rolloverHour, earliestDay)
  const Row = Schema.Record(Schema.String, Schema.Number)
  return sql`SELECT ${counts} FROM reviews
    WHERE julianday(reviewed_at) >= julianday(${earliestStart})`.pipe(
    Effect.flatMap((values) => decodeRows(Row, values)),
    Effect.map((rows) => days.map((_, index) => rows[0]?.[`day${index}`] ?? 0)),
  )
}

/**
 * The overview reads through the `SqlClient` the layer closes over, so the
 * service interface carries no requirements — see `Decks` for why.
 *
 * "Today" starts at `dayRolloverHour` in the learner timezone, not at UTC
 * midnight: the counts count Reviews since that boundary. Due-ness stays a
 * comparison against now, so a Card due later today is due. The browser sends
 * its timezone; without one the boundary is UTC.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry), never as a defect.
 */
export class Home extends Context.Service<
  Home,
  {
    readonly overview: (input?: {
      readonly timezone?: string | undefined
    }) => Effect.Effect<Overview, StorageUnavailable>
  }
>()('nook/backend/Home') {
  static readonly layer = Layer.effect(
    Home,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const overview = (input?: { readonly timezone?: string | undefined }) =>
        Effect.gen(function* () {
          const settingsRows = yield* sql`SELECT behaviour_day_rollover_hour AS "dayRolloverHour"
            FROM settings WHERE id = 1`
          const settings = yield* decodeRows(SettingsRow, settingsRows)
          const rolloverHour = settings[0]?.dayRolloverHour ?? 4
          const timezone = resolveTimezone(input?.timezone)
          const now = new Date()
          const boundary = dayStartUtc(timezone, rolloverHour, now)
          const todayKey = reviewDayKey(timezone, rolloverHour, now)

          const dueValues = yield* sql`SELECT COUNT(*) AS n FROM cards WHERE state != 'new'
              AND suspended = 0 AND note_id IS NOT NULL
              AND due_at IS NOT NULL AND due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
          const dueRows = yield* decodeRows(CountRow, dueValues)
          // New Cards still introducible today, per Deck: its waiting new
          // Cards capped by what is left of the daily limit. Same rule as the
          // Deck summaries, summed across Decks.
          const newRows = yield* decodeRows(
            NewRow,
            yield* sql`SELECT
              (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state = 'new'
                AND suspended = 0) AS "newCount",
              (SELECT COUNT(*) FROM cards WHERE deck_id = decks.id AND state != 'new'
                AND introduced_day >= ${todayKey}) AS introduced,
              COALESCE(new_per_day, (SELECT fsrs_new_per_day FROM settings WHERE id = 1)) AS "limit"
              FROM decks`,
          )
          const newToday = newRows.reduce(
            (total, row) => total + Math.max(0, Math.min(row.newCount, row.limit - row.introduced)),
            0,
          )
          const reviewedValues = yield* sql`SELECT COUNT(DISTINCT card_id) AS n FROM reviews
            WHERE julianday(reviewed_at) >= julianday(${boundary})`
          const reviewedRows = yield* decodeRows(CountRow, reviewedValues)
          const retentionValues = yield* sql`SELECT COALESCE(ROUND(
              100.0 * SUM(CASE WHEN grade != 'Again' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)
            ), 0) AS n FROM reviews
            WHERE julianday(reviewed_at) >= julianday('now', '-7 days')`
          const retentionRows = yield* decodeRows(CountRow, retentionValues)
          const today = new Date(`${todayKey}T00:00:00Z`)
          const activityDayKeys = Array.from({ length: 14 }, (_, index) => {
            const date = new Date(today)
            date.setUTCDate(date.getUTCDate() - (13 - index))
            return date.toISOString().slice(0, 10)
          })
          const dayRows = yield* learnerDayActivity(sql, timezone, rolloverHour, activityDayKeys)
          const dueNow = dueRows[0]?.n ?? 0
          const reviewedToday = reviewedRows[0]?.n ?? 0
          const retention7d = retentionRows[0]?.n ?? 0
          const activity14d = dayRows
          const todayProgress =
            dueNow + newToday + reviewedToday === 0
              ? 100
              : Math.min(
                  100,
                  Math.round((reviewedToday / (dueNow + newToday + reviewedToday)) * 100),
                )
          let streakDays = 0
          let index = activity14d.length - 1
          let streakReachedStart = false
          // An untouched day does not break an ongoing streak until its day
          // is over; count from yesterday when no Reviews happened today.
          if ((activity14d[index] ?? 0) === 0) index -= 1
          for (; index >= 0; index -= 1) {
            if ((activity14d[index] ?? 0) === 0) break
            streakDays += 1
            streakReachedStart = index === 0
          }
          let oldestActivityDay = activityDayKeys[0]
          while (streakReachedStart && oldestActivityDay !== undefined) {
            const firstOlderDay = new Date(`${oldestActivityDay}T00:00:00Z`)
            firstOlderDay.setUTCDate(firstOlderDay.getUTCDate() - 14)
            const olderDayKeys = Array.from({ length: 14 }, (_, offset) => {
              const date = new Date(firstOlderDay)
              date.setUTCDate(date.getUTCDate() + offset)
              return date.toISOString().slice(0, 10)
            })
            const olderDays = yield* learnerDayActivity(sql, timezone, rolloverHour, olderDayKeys)
            streakReachedStart = true
            for (let olderIndex = olderDays.length - 1; olderIndex >= 0; olderIndex -= 1) {
              if ((olderDays[olderIndex] ?? 0) === 0) {
                streakReachedStart = false
                break
              }
              streakDays += 1
            }
            oldestActivityDay = olderDayKeys[0]
          }
          return {
            dueNow,
            newToday,
            reviewedToday,
            retention7d,
            streakDays,
            todayProgress,
            activity14d,
          } satisfies Overview
        }).pipe(Effect.withSpan('Home.overview'), (self) =>
          withStorageErrorPassThrough(self, 'load the overview'),
        )

      return Home.of({ overview })
    }),
  )
}

export const HomeHandlers = HomeRpc.toLayer(
  Effect.gen(function* () {
    const home = yield* Home
    return HomeRpc.of({
      homeOverview: ({ timezone }) => home.overview({ timezone }),
    })
  }),
)
