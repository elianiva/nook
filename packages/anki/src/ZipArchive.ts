import { Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import type { Entry } from '@zip.js/zip.js'
import { decompress } from 'fzstd'
import { AnkiCorruptArchive } from './AnkiErrors'

/**
 * The `unicase` collation, blanked out.
 *
 * Anki declares its name columns `COLLATE unicase`, a collation it registers at
 * runtime that neither wa-sqlite nor `node:sqlite` has. SQLite's parser accepts
 * the `COLLATE` clause without knowing the collation, so a database that names
 * it opens everywhere, but the first query that needs the collation fails with
 * `no such collation sequence: unicase`. The planner reaches for a collation
 * eagerly: an index on a collated column poisons even `count(*)` on that
 * table, and a `WITHOUT ROWID` table with a collated column fails on any scan,
 * because the table itself is the index.
 *
 * Blanking `COLLATE unicase` to spaces keeps every byte offset, and with it
 * every page boundary, intact. Deleting the clause instead would shift the
 * schema text and corrupt the page layout a SQLite file shares with its
 * schema. Spaces parse as nothing, so the columns read back under SQLite's
 * default binary collation. The substitution is faithful because the reader
 * never depends on collation order: it orders by `id` or by `(ntid, ord)` and
 * never touches the `tags` table. Fixtures declare `COLLATE nocase`, the
 * closest of SQLite's built-in collations, so fixtures and production read
 * under a collation Anki did not choose either way.
 */
const UNICASE_CLAUSE = 'COLLATE unicase'

const blankUnicase = (bytes: Uint8Array): void => {
  const needle = new TextEncoder().encode(UNICASE_CLAUSE)
  const space = 0x20
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        continue outer
      }
    }
    bytes.fill(space, i, i + needle.length)
  }
}

/** A zip read that failed after the archive already opened: the file is damaged. */
const damaged = (filename: string): AnkiCorruptArchive =>
  new AnkiCorruptArchive({
    reason: 'integrity',
    message: `This Anki export is damaged: the ${filename} entry does not read. Export it again from Anki.`,
  })

/** A file that is not a zip at all. */
const notAnArchive = new AnkiCorruptArchive({
  reason: 'notAZipArchive',
  message:
    'This file is not an Anki export. In Anki, choose File > Export and import the file that produces.',
})

/**
 * The SQLite journal mode the collection database asks for.
 *
 * Byte 18 of a SQLite header names the file format's journal mode: `1` means
 * rollback, `2` means WAL. Anki writes WAL, which is fine on disk next to its
 * `-wal` file and fine under `node:sqlite`, which opens a copy of the file.
 * But the browser path imports the bytes into wa-sqlite's `MemoryVFS`, where
 * there is no `-wal` file, so SQLite opens the database and then fails every
 * query with `unable to open database file`. Downgrading a WAL-mode header to
 * rollback is safe exactly because there is no `-wal` file: the image is
 * already self-consistent, and the byte only says where SQLite should look
 * for frames that do not exist.
 */
const rollbackJournalMode = (bytes: Uint8Array): void => {
  if (bytes.length > 19 && bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1
    bytes[19] = 1
  }
}

/**
 * The collection database inside an archive, ready to hand to SQLite.
 *
 * The entry is a bare zstd frame around a SQLite file. Decompression throws on
 * truncated input, which the caller turns into a corrupt-archive error.
 */
export const readCollectionBytes = (
  entry: Uint8Array,
): Effect.Effect<Uint8Array, AnkiCorruptArchive> =>
  Effect.try({
    try: () => {
      const bytes = decompress(entry)
      blankUnicase(bytes)
      rollbackJournalMode(bytes)
      return bytes
    },
    catch: () =>
      new AnkiCorruptArchive({
        reason: 'zstd',
        message:
          'This Anki export is damaged: its collection database does not decompress. Export it again from Anki.',
      }),
  })

/** The Media index inside an archive, decompressed but not yet parsed. */
export const readMediaBytes = (entry: Uint8Array): Effect.Effect<Uint8Array, AnkiCorruptArchive> =>
  Effect.try({
    try: () => decompress(entry),
    catch: () =>
      new AnkiCorruptArchive({
        reason: 'zstd',
        message:
          'This Anki export is damaged: its media index does not decompress. Export it again from Anki.',
      }),
  })

/**
 * One Media file inside an archive, decompressed.
 *
 * In the format nook reads, Anki wraps every Media file in its own bare zstd
 * frame, exactly as it wraps the collection and the Media index. The bytes this
 * returns are the file a Learner expects; the frame around them is not part of
 * it, and uploading the frame would store a file nothing can open.
 */
export const readMediaFileBytes = (
  entry: Uint8Array,
): Effect.Effect<Uint8Array, AnkiCorruptArchive> =>
  Effect.try({
    try: () => decompress(entry),
    catch: () =>
      new AnkiCorruptArchive({
        reason: 'zstd',
        message:
          'This Anki export is damaged: one of its Media files does not decompress. Export it again from Anki.',
      }),
  })

/**
 * An `.apkg` archive, opened for entry reads, with its entries listed once.
 *
 * Listing the central directory parses every entry, so doing it once per read
 * stalls a large archive: each of Kaishi's 4354 Media files would otherwise
 * re-list all 4358 entries before its own bytes can stream. The entries list
 * reads eagerly, so a file that is not a zip fails here, before the caller
 * asks for anything by name.
 */
export interface OpenedZip {
  readonly reader: ZipReader<Blob>
  readonly entries: ReadonlyArray<Entry>
}

/**
 * One named entry of an `.apkg` archive, as bytes.
 *
 * A missing name is not an error here: `meta` is absent in a legacy archive,
 * and that absence is what names the legacy format.
 */
export const readZipEntry = (
  zip: OpenedZip,
  filename: string,
): Effect.Effect<Uint8Array | undefined, AnkiCorruptArchive> =>
  Effect.tryPromise({
    try: async () => {
      const entry = zip.entries.find((candidate) => candidate.filename === filename)
      if (entry === undefined || entry.directory) {
        return undefined
      }
      const data = await entry.getData(new Uint8ArrayWriter())
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    },
    catch: () => damaged(filename),
  })

/**
 * An `.apkg` archive, opened for entry reads. Closes when the scope closes.
 *
 * The entries list reads eagerly, so a file that is not a zip fails here,
 * before the caller asks for anything by name.
 */
export const openZip = (archive: Blob): Effect.Effect<OpenedZip, AnkiCorruptArchive, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const reader = new ZipReader(new BlobReader(archive))
        const entries = await reader.getEntries()
        return { reader, entries }
      },
      catch: () => notAnArchive,
    }),
    (zip) => Effect.promise(() => zip.reader.close()),
  )
