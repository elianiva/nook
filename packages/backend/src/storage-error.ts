import { Effect, Schema } from 'effect'
import { isSqlError, type SqlError } from 'effect/sql/SqlError'
import { StorageUnavailable } from '@nook/api'

export type StorageError = SqlError | Schema.SchemaError

/** A request the database cannot answer, as a sentence. */
const toMessage = (error: StorageError): string =>
  error._tag === 'SqlError'
    ? error.message
    : `The database returned a row nook does not understand: ${error.message}`

/** Whether `error` is a storage failure: SQL or row-decode, both retryable from the frontend. */
const isStorageError = (error: unknown): error is StorageError =>
  isSqlError(error) || Schema.isSchemaError(error)

/** Log `error` and fail with a 503 `StorageUnavailable` carrying a sentence for the Learner. */
const toUnavailable = (
  operation: string,
  error: StorageError,
): Effect.Effect<never, StorageUnavailable> =>
  Effect.andThen(
    Effect.logError(`${operation} failed`, error),
    Effect.fail(
      new StorageUnavailable({
        message: `Could not ${operation}. ${toMessage(error)}`,
      }),
    ),
  )

/**
 * Run `self`, and map SQL and row-decode failures to a 503
 * `StorageUnavailable` while other failures (such as `DeckNotFound` or a
 * missing settings row) pass through untouched, so callers keep their own
 * error channels. Defects still crash the Worker isolate: a defect means
 * code ran that cannot run (an interrupted fiber, a missing layer), not a
 * database that misbehaved.
 */
export const withStorageErrorPassThrough = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  operation: string,
): Effect.Effect<A, Exclude<E, StorageError> | StorageUnavailable, R> =>
  Effect.catch(
    self,
    (error: E): Effect.Effect<never, Exclude<E, StorageError> | StorageUnavailable> =>
      isStorageError(error)
        ? toUnavailable(operation, error)
        : Effect.fail(error as Exclude<E, StorageError>),
  )

/** Decode `rows` against `schema`, failing with the decode error. */
export const decodeRows = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<S['Type']>, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows)

/** One `COUNT(*)` row, as every count query aliases it. */
export const CountRow = Schema.Struct({ n: Schema.Number })
