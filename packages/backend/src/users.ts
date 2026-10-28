import { Context, Effect, Layer } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { DEFAULT_SETTINGS } from '@nook/api'
import { runStatements } from './batch'
import { withStorageErrorPassThrough } from './storage-error'

/**
 * Who a request is for.
 *
 * The Worker builds the service layers once per request, so it provides this
 * as a plain layer and every service closes over the id. A service reads
 * `user.id` into each statement's `user_id` filter; no service method takes a
 * user argument, so a handler cannot forget to pass one.
 */
export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  'nook/backend/CurrentUser',
) {
  static readonly layer = (id: string): Layer.Layer<CurrentUser> =>
    Layer.succeed(CurrentUser, CurrentUser.of({ id }))
}

/**
 * Owner of every row that predates multiple users (migration 0012). The first
 * admin sign-in adopts them; until then nobody can read them.
 */
export const LEGACY_OWNER = 'legacy'

/** Every table that carries `user_id`, parents first. */
const OWNED_TABLES = [
  'imports',
  'decks',
  'note_types',
  'notes',
  'cards',
  'reviews',
  'review_snapshots',
  'undone_reviews',
  'settings',
] as const

/**
 * Gives a new user the rows every service expects to find: the settings row.
 * Safe to run twice.
 */
export const provisionUser = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    const { fsrs, behaviour } = DEFAULT_SETTINGS
    yield* sql`INSERT OR IGNORE INTO settings (user_id, fsrs_desired_retention, fsrs_weights,
      fsrs_maximum_interval, fsrs_new_per_day, fsrs_reviews_per_day, fsrs_lapse_minutes,
      behaviour_review_sounds, behaviour_tap_to_reveal, behaviour_day_rollover_hour,
      behaviour_keep_awake)
      VALUES (${userId}, ${fsrs.desiredRetention}, ${fsrs.weights.map(String).join(',')},
      ${fsrs.maximumInterval}, ${fsrs.newPerDay}, ${fsrs.reviewsPerDay}, ${fsrs.lapseMinutes},
      1, ${behaviour.tapToReveal ? 1 : 0}, ${behaviour.dayRolloverHour}, 0)`
  }).pipe(Effect.withSpan('provisionUser'), (self) =>
    withStorageErrorPassThrough(self, 'set up the account'),
  )

/**
 * Hands the pre-multi-user collection to `userId`.
 *
 * The user's own settings row, written by `provisionUser`, is dropped first: the
 * adopted row is the one the collection was tuned with. Every other table is
 * rewritten in one batch, with foreign-key checks deferred to its end. The
 * references carry ON UPDATE CASCADE, so the first update already moves the
 * children and the later ones find nothing. Run twice, the second call finds
 * nothing to move.
 */
export const adoptLegacyCollection = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    const legacySettings =
      yield* sql`SELECT 1 AS found FROM settings WHERE user_id = ${LEGACY_OWNER}`
    yield* runStatements([
      // Every row references two parents, so no order of updates keeps every
      // reference whole at each step; the check waits for the end of the batch.
      sql`PRAGMA defer_foreign_keys = ON`,
      ...(legacySettings.length > 0 ? [sql`DELETE FROM settings WHERE user_id = ${userId}`] : []),
      ...OWNED_TABLES.map(
        (table) =>
          sql`UPDATE ${sql(table)} SET user_id = ${userId} WHERE user_id = ${LEGACY_OWNER}`,
      ),
    ])
  }).pipe(Effect.withSpan('adoptLegacyCollection'), (self) =>
    withStorageErrorPassThrough(self, 'adopt the existing collection'),
  )

/** One account, as the admin page lists it. */
export type Account = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly role: 'user' | 'admin'
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly createdAt: string
}

/** Every account, newest first, pending ones before the rest. */
export const listAccounts = Effect.gen(function* () {
  const sql = yield* Sql.SqlClient
  const rows = yield* sql<Account>`SELECT "id", "name", "email", "role", "status",
    "createdAt" AS "createdAt" FROM "user"
    ORDER BY ("status" = 'pending') DESC, "createdAt" DESC`
  return rows.map((row) => ({ ...row, createdAt: String(row.createdAt) }))
}).pipe(Effect.withSpan('listAccounts'), (self) =>
  withStorageErrorPassThrough(self, 'list the accounts'),
)

/** Approves or rejects an account. A rejected account keeps its sign-in but reaches nothing. */
export const setAccountStatus = (userId: string, status: 'approved' | 'rejected') =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    yield* sql`UPDATE "user" SET "status" = ${status}, "updatedAt" = ${new Date().toISOString()}
      WHERE "id" = ${userId} AND "role" != 'admin'`
  }).pipe(Effect.withSpan('setAccountStatus'), (self) =>
    withStorageErrorPassThrough(self, 'change the account'),
  )

/**
 * Removes an account and everything it owns: the collection, settings, story
 * allowance, sessions, and sign-in links. Children go before parents, in one
 * batch with foreign keys checked at its end, so a failure removes nothing.
 * Media in R2 is the caller's to remove.
 */
export const deleteAccount = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    yield* runStatements([
      sql`PRAGMA defer_foreign_keys = ON`,
      ...[...OWNED_TABLES]
        .reverse()
        .map((table) => sql`DELETE FROM ${sql(table)} WHERE user_id = ${userId}`),
      sql`DELETE FROM story_usage WHERE user_id = ${userId}`,
      sql`DELETE FROM "session" WHERE "userId" = ${userId}`,
      sql`DELETE FROM "account" WHERE "userId" = ${userId}`,
      sql`DELETE FROM "user" WHERE "id" = ${userId} AND "role" != 'admin'`,
    ])
  }).pipe(Effect.withSpan('deleteAccount'), (self) =>
    withStorageErrorPassThrough(self, 'delete the account'),
  )
