import { Effect } from 'effect'
import * as Sql from 'effect/sql/SqlClient'

/**
 * Splits a migration file into statements.
 *
 * SQLite decides where a statement ends, not a `;` that happens to sit inside
 * a string literal — and a Note Type's stylesheet is full of them. This
 * splitter tracks single quotes, quoted identifiers, and `--` comments so a
 * migration can carry CSS and JSON.
 */
export const splitStatements = (text: string): ReadonlyArray<string> => {
  const statements: Array<string> = []
  let current = ''
  let quote: string | null = null
  let index = 0

  while (index < text.length) {
    const char = text[index] ?? ''

    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
      current += '\n'
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      index += 1
      continue
    }

    if (char === ';') {
      statements.push(current)
      current = ''
      index += 1
      continue
    }

    current += char
    index += 1
  }

  if (current.trim().length > 0) statements.push(current)
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0)
}

/**
 * Applies every migration to the shared `:memory:` database.
 *
 * Children drop before parents: SQLite runs an implicit DELETE on DROP TABLE,
 * and a parent dropped while its children still hold rows fails the foreign
 * key. The layer shares one database across a file's tests, so each call
 * starts from an empty schema.
 */
export const migrate = Effect.gen(function* () {
  const { readFileSync, readdirSync } = yield* Effect.promise(() => import('node:fs'))
  const { join } = yield* Effect.promise(() => import('node:path'))
  const dir = join(import.meta.dirname, '..', 'migrations')
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const sql = yield* Sql.SqlClient

  for (const table of [
    'review_snapshots',
    'reviews',
    'notes',
    'cards',
    'imports',
    'decks',
    'note_types',
    'settings',
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`)
  }

  for (const file of files) {
    for (const statement of splitStatements(readFileSync(join(dir, file), 'utf8'))) {
      yield* sql.unsafe(statement)
    }
  }
})
