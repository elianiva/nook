import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { SettingsRpc, StorageUnavailable } from '@nook/api'
import type { AppSettings, FsrsHealthReport } from '@nook/api'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'

/** Anki describes fewer than a few hundred reviews as low optimizer data. */
const REVIEW_DATA_FLOOR = 200

/** One row of the singleton `settings` table. Booleans ride as 0/1, weights as one CSV string. */
const SettingsRow = Schema.Struct({
  fsrsDesiredRetention: Schema.Number,
  fsrsWeights: Schema.String,
  fsrsMaximumInterval: Schema.Number,
  fsrsNewPerDay: Schema.Number,
  fsrsReviewsPerDay: Schema.Number,
  fsrsLapseMinutes: Schema.Number,
  behaviourTapToReveal: Schema.Number,
  behaviourDayRolloverHour: Schema.Number,
})

const FsrsHealthRow = Schema.Struct({
  reviewCount: Schema.Number,
  again: Schema.Number,
  hard: Schema.Number,
  good: Schema.Number,
  easy: Schema.Number,
  completeHistoryCount: Schema.Number,
})

export const toSettings = (row: typeof SettingsRow.Type): AppSettings => ({
  fsrs: {
    desiredRetention: row.fsrsDesiredRetention,
    weights: row.fsrsWeights.split(',').map(Number),
    maximumInterval: row.fsrsMaximumInterval,
    newPerDay: row.fsrsNewPerDay,
    reviewsPerDay: row.fsrsReviewsPerDay,
    lapseMinutes: row.fsrsLapseMinutes,
  },
  behaviour: {
    tapToReveal: row.behaviourTapToReveal === 1,
    dayRolloverHour: row.behaviourDayRolloverHour,
  },
})

/**
 * Settings read through the `SqlClient` the layer closes over, so the
 * service interface carries no requirements — see `Decks` for why.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry), never as a defect. A missing singleton row means a
 * corrupt database, so it surfaces the same way: the frontend keeps its copy
 * and offers a retry instead of the Worker crashing.
 */
export class Settings extends Context.Service<
  Settings,
  {
    readonly read: Effect.Effect<AppSettings, StorageUnavailable>
    readonly fsrsHealth: Effect.Effect<FsrsHealthReport, StorageUnavailable>
    save(settings: AppSettings): Effect.Effect<AppSettings, StorageUnavailable>
  }
>()('nook/backend/Settings') {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const read = Effect.gen(function* () {
        const rows = yield* sql`SELECT fsrs_desired_retention AS "fsrsDesiredRetention",
          fsrs_weights AS "fsrsWeights", fsrs_maximum_interval AS "fsrsMaximumInterval",
          fsrs_new_per_day AS "fsrsNewPerDay", fsrs_reviews_per_day AS "fsrsReviewsPerDay",
          fsrs_lapse_minutes AS "fsrsLapseMinutes",
          behaviour_tap_to_reveal AS "behaviourTapToReveal",
          behaviour_day_rollover_hour AS "behaviourDayRolloverHour"
          FROM settings WHERE id = 1`
        const decoded = yield* decodeRows(SettingsRow, rows)
        const found = Option.fromUndefinedOr(decoded[0])
        if (found._tag === 'None') {
          return yield* new StorageUnavailable({
            message: 'Could not read settings. The settings store is missing its row.',
          })
        }
        return toSettings(found.value)
      }).pipe(Effect.withSpan('Settings.read'), (self) =>
        withStorageErrorPassThrough(self, 'read settings'),
      )

      const fsrsHealth = Effect.gen(function* () {
        const rows = yield* sql`SELECT COUNT(*) AS "reviewCount",
          COALESCE(SUM(CASE WHEN r.grade = 'Again' THEN 1 ELSE 0 END), 0) AS again,
          COALESCE(SUM(CASE WHEN r.grade = 'Hard' THEN 1 ELSE 0 END), 0) AS hard,
          COALESCE(SUM(CASE WHEN r.grade = 'Good' THEN 1 ELSE 0 END), 0) AS good,
          COALESCE(SUM(CASE WHEN r.grade = 'Easy' THEN 1 ELSE 0 END), 0) AS easy,
          COALESCE(SUM(CASE WHEN s.review_id IS NOT NULL
            AND s.state IS NOT NULL AND s.stability IS NOT NULL AND s.difficulty IS NOT NULL
            AND s.due_in_days IS NOT NULL AND r.state_after IS NOT NULL
            AND r.stability_after IS NOT NULL AND r.difficulty_after IS NOT NULL
            AND r.due_in_days_after IS NOT NULL THEN 1 ELSE 0 END), 0)
            AS "completeHistoryCount"
          FROM reviews r LEFT JOIN review_snapshots s ON s.review_id = r.id`
        const decoded = yield* decodeRows(FsrsHealthRow, rows)
        const found = Option.fromUndefinedOr(decoded[0])
        if (found._tag === 'None') {
          return yield* new StorageUnavailable({
            message: 'Could not read the review history for the FSRS health check.',
          })
        }
        const row = found.value
        return {
          reviewCount: row.reviewCount,
          ratings: { again: row.again, hard: row.hard, good: row.good, easy: row.easy },
          completeHistoryCount: row.completeHistoryCount,
          incompleteHistoryCount: row.reviewCount - row.completeHistoryCount,
          // This is a conservative warning signal, not a claim that the learner
          // misused Hard. A rating histogram cannot distinguish that from easy material.
          possibleHardMisuse: row.reviewCount >= REVIEW_DATA_FLOOR && row.again === 0,
        } satisfies FsrsHealthReport
      }).pipe(Effect.withSpan('Settings.fsrsHealth'), (self) =>
        withStorageErrorPassThrough(self, 'read FSRS review history'),
      )

      const save = (settings: AppSettings): Effect.Effect<AppSettings, StorageUnavailable> =>
        Effect.gen(function* () {
          yield* sql`UPDATE settings SET
            fsrs_desired_retention = ${settings.fsrs.desiredRetention},
            fsrs_weights = ${settings.fsrs.weights.map(String).join(',')},
            fsrs_maximum_interval = ${settings.fsrs.maximumInterval},
            fsrs_new_per_day = ${settings.fsrs.newPerDay},
            fsrs_reviews_per_day = ${settings.fsrs.reviewsPerDay},
            fsrs_lapse_minutes = ${settings.fsrs.lapseMinutes},
            behaviour_tap_to_reveal = ${settings.behaviour.tapToReveal ? 1 : 0},
            behaviour_day_rollover_hour = ${settings.behaviour.dayRolloverHour},
            updated_at = datetime('now') WHERE id = 1`
          return settings
        }).pipe(Effect.withSpan('Settings.save'), (self) =>
          withStorageErrorPassThrough(self, 'save settings'),
        )

      return Settings.of({ read, fsrsHealth, save })
    }),
  )
}

export const SettingsHandlers = SettingsRpc.toLayer(
  Effect.gen(function* () {
    const settings = yield* Settings
    return SettingsRpc.of({
      settingsGet: () => settings.read,
      settingsFsrsHealth: () => settings.fsrsHealth,
      settingsUpdate: (payload) => settings.save(payload),
    })
  }),
)
