import { Context, Effect, Layer, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { HomeRpc, StorageUnavailable } from '@nook/api'
import type { Overview } from '@nook/api'
import { dayStartUtc } from './day-boundary'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'

const CountRow = Schema.Struct({ n: Schema.Number })
const DayRow = Schema.Struct({ day: Schema.String, count: Schema.Number })
const SettingsRow = Schema.Struct({ dayRolloverHour: Schema.Number })

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
          const timezone =
            input?.timezone === undefined || input?.timezone === '' ? 'UTC' : input.timezone
          const now = new Date()
          const boundary = dayStartUtc(timezone, rolloverHour, now)

          const dueValues = yield* sql`SELECT COUNT(*) AS n FROM cards WHERE state != 'new'
              AND due_at IS NOT NULL AND due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
          const dueRows = yield* decodeRows(CountRow, dueValues)
          const reviewedValues = yield* sql`SELECT COUNT(*) AS n FROM reviews
            WHERE reviewed_at >= ${boundary}`
          const reviewedRows = yield* decodeRows(CountRow, reviewedValues)
          const dayValues = yield* sql`WITH RECURSIVE days(n) AS (
              SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 13
            )
            SELECT date(${boundary}, '-' || n || ' days') AS day,
              (SELECT COUNT(*) FROM reviews
                WHERE date(reviewed_at) = date(${boundary}, '-' || n || ' days')) AS count
            FROM days ORDER BY day`
          const dayRows = yield* decodeRows(DayRow, dayValues)
          const dueNow = dueRows[0]?.n ?? 0
          const reviewedToday = reviewedRows[0]?.n ?? 0
          const activity14d = dayRows.map((row) => row.count)
          const todayProgress =
            dueNow + reviewedToday === 0
              ? 100
              : Math.min(100, Math.round((reviewedToday / (dueNow + reviewedToday)) * 100))
          let streakDays = 0
          for (let index = activity14d.length - 1; index >= 0; index -= 1) {
            if ((activity14d[index] ?? 0) > 0) streakDays += 1
            else break
          }
          return {
            dueNow,
            reviewedToday,
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
