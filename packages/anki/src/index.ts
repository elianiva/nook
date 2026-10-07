/**
 * `@nook/anki` — the `.apkg` archive reader.
 *
 * One service, `AnkiArchive`, opens an `.apkg` archive and hands back a handle
 * that reads it. The handle returns the archive's Note Types, Decks, Notes,
 * Cards, and Media, and nothing else: it never writes to D1 or R2 and never
 * imports scheduling state, so `@nook/backend` stays the only owner of storage.
 *
 * A `.apkg` archive is a zip. Its `meta` entry is a raw protobuf
 * `PackageMetadata` message that names the package format. `collection.anki21b`
 * is a bare zstd frame that decompresses to a SQLite database, which is where
 * the normalized `notetypes`, `fields`, `templates`, `decks`, `notes`, and
 * `cards` tables live. Media files are numbered zip entries, each a bare zstd
 * frame around the file itself, and the `media` entry maps them. The legacy
 * `collection.anki21` and `collection.anki2` layouts
 * keep their content in the dead JSON blobs inside `col`, and nook rejects them.
 *
 * Two facts about the archive drive the SQL this package writes. Anki registers
 * a `unicase` collation at runtime that neither wa-sqlite nor `node:sqlite`
 * has, so no query may touch the `tags` table or order by a collated column.
 * And `notes.flds` joins Fields with a unit separator, which no SQL function
 * here is allowed to split.
 *
 * The barrel exports the browser-safe surface only. `sourceNode`, which needs
 * `node:sqlite`, lives in `SqliteArchiveNode` so that a bundle reading an
 * archive in a browser never pulls a node-only driver into its graph.
 */

export { AnkiArchive, layer } from './AnkiArchive'
export type { ArchiveReadStage, OpenedArchive, OpenedMedia } from './AnkiArchive'
export { AnkiSqliteMemory, sourceMemory } from './SqliteArchive'
export type { AnkiSqliteSource } from './SqliteArchive'
export { AnkiArchiveTooLarge, AnkiCorruptArchive, AnkiUnsupportedArchive } from './AnkiErrors'
export type { AnkiOpenError, AnkiReadError } from './AnkiErrors'
export type { AnkiCard, AnkiMediaEntry, AnkiNote } from './AnkiContent'
export type { AnkiDeck, AnkiField, AnkiManifest, AnkiNoteType, AnkiTemplate } from './AnkiManifest'
export { toHex } from './Hash'
