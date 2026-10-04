import { Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import type * as Sql from 'effect/sql/SqlClient'
import * as NodeSqlite from '@effect/sql-sqlite-node/SqliteClient'
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

/** Opens a wasm database and imports `bytes` into it. The Worker path. */
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

/** Writes `bytes` to a temp file and opens it read-only. The node test and tool path. */
export const sourceNode = (
  bytes: Uint8Array,
): Effect.Effect<Sql.SqlClient, AnkiOpenError, Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import('node:fs'))
    const os = yield* Effect.promise(() => import('node:os'))
    const path = yield* Effect.promise(() => import('node:path'))
    const directory = yield* Effect.try({
      try: () => fs.mkdtempSync(path.join(os.tmpdir(), 'nook-anki-')),
      catch: () => notADatabase,
    })
    const filename = path.join(directory, 'collection.anki21b.db')
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(directory, { force: true, recursive: true })),
    )
    yield* Effect.try({
      try: () => fs.writeFileSync(filename, bytes),
      catch: () => notADatabase,
    })
    const client = yield* NodeSqlite.make({ filename, readonly: true, disableWAL: true }).pipe(
      Effect.provide(Reactivity.layer),
    )
    return client as unknown as Sql.SqlClient
  }).pipe(Effect.mapError((): AnkiOpenError => notADatabase))

/** A SQLite source that lives in memory, for the Worker. */
export const AnkiSqliteMemory = { source: sourceMemory }

/** A SQLite source that lives in a file, for node tests and tools. */
export const AnkiSqliteNode = { source: sourceNode }
