import { Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import type * as Sql from 'effect/sql/SqlClient'
import * as MemorySqlite from '@effect/sql-sqlite-wasm/SqliteClient'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { AnkiOpenError } from './AnkiErrors'
import { AnkiCorruptArchive } from './AnkiErrors'

/**
 * Where the collection database comes from.
 *
 * There is exactly one database per archive, so the source takes the collection
 * bytes and hands back an open client. The reader never knows which driver it
 * reads from.
 */
export type AnkiSqliteSource = (
  bytes: Uint8Array,
) => Effect.Effect<Sql.SqlClient, AnkiOpenError, Scope.Scope>

const notADatabase = new AnkiCorruptArchive({
  reason: 'notADatabase',
  message:
    'This Anki export is damaged: its collection database does not open. Export it again from Anki.',
})

/** Opens a wasm database and imports `bytes` into it. The browser and Worker path. */
export const sourceMemory = (
  bytes: Uint8Array,
): Effect.Effect<Sql.SqlClient, AnkiOpenError, Scope.Scope> =>
  MemorySqlite.makeMemory({}).pipe(
    Effect.flatMap((client) =>
      client.import(bytes).pipe(Effect.as(client as unknown as Sql.SqlClient)),
    ),
    Effect.provide(Reactivity.layer),
    Effect.mapError((): AnkiOpenError => notADatabase),
  )

/** A SQLite source that lives in memory, for the browser and the Worker. */
export const AnkiSqliteMemory = { source: sourceMemory }
