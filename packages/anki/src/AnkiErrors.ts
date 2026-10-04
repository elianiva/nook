import { Schema } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

/**
 * Everything `@nook/anki` can refuse to do, and why.
 *
 * These live apart from the service so that the format readers can raise them
 * without importing the service, and so that a caller can match on them without
 * pulling in the reader.
 */

/**
 * The archive is readable, but nook does not import this version of it.
 *
 * `message` is a sentence for the Learner, not for a log. Anki calls this
 * problem "the collection is too new", and the fix for the common case is one
 * click away in Anki's own export dialog, so the message says which click.
 */
export class AnkiUnsupportedArchive extends Schema.TaggedError<AnkiUnsupportedArchive>()(
  'AnkiUnsupportedArchive',
  {
    reason: Schema.Literals([
      /** No `meta` entry, or a format version below the one nook reads. */
      'legacyExport',
      /** `col.ver` is below the oldest schema nook reads. */
      'schemaTooOld',
      /** `col.ver` is above the newest schema nook knows, or a 12 or 13 migration snapshot. */
      'schemaTooNew',
      /** The `meta` entry names no version, which means a newer Anki wrote this. */
      'formatTooNew',
    ]),
    message: Schema.String,
  },
) {}

/**
 * The archive is truncated, corrupt, or not an archive at all.
 *
 * `reason` says which stage gave up, which is the difference between "that file
 * is not an Anki export" and "the Anki export is damaged".
 */
export class AnkiCorruptArchive extends Schema.TaggedError<AnkiCorruptArchive>()(
  'AnkiCorruptArchive',
  {
    reason: Schema.Literals([
      'notAZipArchive',
      'missingCollection',
      'zstd',
      'notADatabase',
      'integrity',
    ]),
    message: Schema.String,
  },
) {}

/** The archive is larger than nook accepts. */
export class AnkiArchiveTooLarge extends Schema.TaggedError<AnkiArchiveTooLarge>()(
  'AnkiArchiveTooLarge',
  {
    bytes: Schema.Number,
    limit: Schema.Number,
  },
) {}

/**
 * What a streaming read can fail with, once the archive is open.
 *
 * A driver can fail on any statement, a row can fail to decode if the archive
 * is damaged in a way that survives opening, and a Media entry can fail to
 * read after the archive already opened. There is nothing else, because
 * everything an Import can get wrong about a Note or a Card is a diagnostic
 * rather than an error.
 */
export type AnkiReadError = SqlError | Schema.SchemaError | AnkiCorruptArchive

/** What opening an archive can fail with. */
export type AnkiOpenError =
  | AnkiUnsupportedArchive
  | AnkiCorruptArchive
  | AnkiArchiveTooLarge
  | AnkiReadError
