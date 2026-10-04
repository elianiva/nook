import { Context, Effect, Layer, Schema } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import * as Sql from 'effect/sql/SqlClient'
import { Api } from '@nook/api'
import type { Overview } from '@nook/api'

const CountRow = Schema.Struct({ n: Schema.Number })
const DayRow = Schema.Struct({ day: Schema.String, count: Schema.Number })

const decodeRows = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<S['Type']>> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie)

/**
 * The overview reads through the `SqlClient` the layer closes over, so the
 * service interface carries no requirements — see `Decks` for why.
 */
export class Home extends Context.Service<
  Home,
  {
    readonly overview: Effect.Effect<Overview>
  }
>()('nook/backend/Home') {
  static readonly layer = Layer.effect(
    Home,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const overview = Effect.gen(function* () {
        const dueValues =
          yield* sql`SELECT COUNT(*) AS n FROM cards WHERE state != 'new' AND due_in_days <= 0`.pipe(
            Effect.orDie,
          )
        const dueRows = yield* decodeRows(CountRow, dueValues)
        const reviewedValues =
          yield* sql`SELECT COUNT(*) AS n FROM reviews WHERE reviewed_at >= date('now')`.pipe(
            Effect.orDie,
          )
        const reviewedRows = yield* decodeRows(CountRow, reviewedValues)
        const dayValues = yield* sql`WITH RECURSIVE days(n) AS (
            SELECT 0 UNION ALL SELECT n + 1 FROM days WHERE n < 13
          )
          SELECT date('now', '-' || n || ' days') AS day,
            (SELECT COUNT(*) FROM reviews WHERE date(reviewed_at) = date('now', '-' || n || ' days')) AS count
          FROM days ORDER BY day`.pipe(Effect.orDie)
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
        return { dueNow, reviewedToday, streakDays, todayProgress, activity14d } satisfies Overview
      }).pipe(Effect.withSpan('Home.overview'))

      return Home.of({ overview })
    }),
  )
}

export const HomeHandlers = HttpApiBuilder.group(Api, 'home', (handlers) =>
  Effect.gen(function* () {
    const home = yield* Home
    return handlers.handle('overview', () => home.overview)
  }),
)
