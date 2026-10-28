import { D1Client } from '@effect/sql-d1'
import { Effect, Option } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import type * as Statement from 'effect/sql/Statement'

/**
 * Runs statements in order, atomically on D1 and sequentially elsewhere.
 *
 * D1 rejects `BEGIN TRANSACTION` (ADR 0003), so a multi-statement write goes
 * through `db.batch()`, which D1 runs atomically. The node driver the tests use
 * has no batch, so the statements run in order inside one transaction there
 * instead, which gives the same atomicity: a `defer_foreign_keys` pragma in the
 * first statement holds to the end, as on D1. Either way the caller orders the
 * statements so the last one is the commit point.
 */
export const runStatements = (
  statements: ReadonlyArray<Statement.Statement<unknown>>,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const maybeD1 = yield* Effect.serviceOption(D1Client.D1Client)
    const maybeSql = yield* Effect.serviceOption(Sql.SqlClient)
    return yield* Option.match(maybeD1, {
      onNone: () => {
        const inOrder = Effect.forEach(statements, (statement) => statement, {
          concurrency: 1,
          discard: true,
        })
        return Option.isSome(maybeSql) ? maybeSql.value.withTransaction(inOrder) : inOrder
      },
      onSome: (d1) => Effect.asVoid(d1.batch(statements)),
    })
  })
