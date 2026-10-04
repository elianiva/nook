import { Effect, Schema } from 'effect'
import { AnkiMediaEntry } from './AnkiContent'
import { AnkiCorruptArchive, AnkiUnsupportedArchive } from './AnkiErrors'
import { toHex } from './Hash'
import { ProtobufReader } from './Protobuf'

/**
 * The parts of a `.apkg` archive that are not the collection database.
 *
 * A modern archive is a zip of five kinds of entry. `meta` is a raw protobuf
 * `PackageMetadata` message, and it is what tells a reader which of the other
 * layouts the archive uses. `collection.anki21b` is a bare zstd frame around a
 * SQLite database. The Media files are numbered entries, and `media` is the
 * index that gives those numbers names.
 *
 * The legacy layouts named `collection.anki21` and `collection.anki2` keep their
 * content in the JSON blobs inside the database's `col` table, which a modern
 * Anki no longer writes to. nook does not read those.
 */

/** The entry holding Anki's `PackageMetadata` message. Absent in a legacy archive. */
export const META_ENTRY = 'meta'

/** The entry holding the collection, in the one layout nook reads. */
export const COLLECTION_ENTRY = 'collection.anki21b'

/** The entry holding Anki's `MediaEntries` message. */
export const MEDIA_ENTRY = 'media'

/** `PackageMetadata.version`: the layout Anki wrote the archive in. */
export const PACKAGE_VERSION_LATEST = 3

/**
 * `PackageMetadata.version` when the archive does not name one.
 *
 * An older Anki leaves the field out entirely, because zero is the default for a
 * protobuf enum, so an empty `meta` entry reads the same as a newer Anki's. The
 * caller tells the two apart by whether `meta` was there at all.
 */
export const PACKAGE_VERSION_UNNAMED = 0

/**
 * The format version Anki wrote the archive in.
 *
 * Throws when `meta` is not a `PackageMetadata` message, which the caller turns
 * into a corrupt-archive error.
 */
export const readPackageVersion = (meta: Uint8Array): number => {
  const reader = new ProtobufReader(meta)
  for (let tag = reader.next(); tag !== null; tag = reader.next()) {
    if (tag.number === 1 && tag.wireType === 'varint') {
      return reader.varint()
    }
    reader.skip(tag)
  }
  return PACKAGE_VERSION_UNNAMED
}

const legacy = new AnkiUnsupportedArchive({
  reason: 'legacyExport',
  message:
    'This file uses the older Anki export format. In Anki, choose File > Export, turn off "Support older Anki versions", export again, and import that file.',
})

const tooNew = new AnkiUnsupportedArchive({
  reason: 'formatTooNew',
  message:
    'This file was written by a newer version of Anki than nook knows. Update nook, or export the deck again from the version of Anki you normally use.',
})

/** `meta` is present but not a `PackageMetadata` message: truncated bytes, not a version nook could know. */
const badMeta = new AnkiCorruptArchive({
  reason: 'integrity',
  message:
    'This Anki export is damaged: its package metadata does not parse. Export it again from Anki.',
})

/**
 * Whether nook can read an archive, given its `meta` entry.
 *
 * Only the latest format is readable. A legacy archive keeps its content in the
 * `col` table's JSON blobs, which nook deliberately does not parse, so the answer
 * is to ask Anki for a fresh export rather than to support two formats.
 * A present but unparsable `meta` is damage, not a version: truncated bytes
 * fail with `badMeta` so the caller reports corruption instead of crashing.
 */
export const checkArchiveFormat = (
  meta: Uint8Array | undefined,
): Effect.Effect<number, AnkiUnsupportedArchive | AnkiCorruptArchive> => {
  if (meta === undefined) {
    return Effect.fail(legacy)
  }
  let version: number
  try {
    version = readPackageVersion(meta)
  } catch {
    return Effect.fail(badMeta)
  }
  return version === PACKAGE_VERSION_LATEST ? Effect.succeed(version) : Effect.fail(tooNew)
}

const readMediaEntry = (bytes: Uint8Array, index: number): AnkiMediaEntry => {
  let name = ''
  let size = 0
  let sha1: Uint8Array = new Uint8Array(0)
  const reader = new ProtobufReader(bytes)
  for (let tag = reader.next(); tag !== null; tag = reader.next()) {
    if (tag.number === 1 && tag.wireType === 'lengthDelimited') {
      name = reader.string()
    } else if (tag.number === 2 && tag.wireType === 'varint') {
      size = reader.varint()
    } else if (tag.number === 3 && tag.wireType === 'lengthDelimited') {
      sha1 = reader.bytes()
    } else {
      reader.skip(tag)
    }
  }
  return { name, entry: String(index), bytes: size, checksum: toHex(sha1) }
}

/**
 * Anki's Media index: what the archive carries, and where each file's bytes
 * live.
 *
 * The index is a repeated message, and Anki writes each Media file to the zip
 * entry named by that message's position, counting from zero. The order is the
 * order Anki happened to read its media folder in, which nook must not depend on
 * beyond recovering each name.
 *
 * A `media` entry that is not a `MediaEntries` message fails with a
 * corrupt-archive error carrying a fix, never a thrown decode error.
 */
export const readMediaIndex = (
  bytes: Uint8Array,
): Effect.Effect<ReadonlyArray<AnkiMediaEntry>, AnkiCorruptArchive | Schema.SchemaError> => {
  const entries: Array<AnkiMediaEntry> = []
  try {
    const reader = new ProtobufReader(bytes)
    for (let tag = reader.next(); tag !== null; tag = reader.next()) {
      if (tag.number === 1 && tag.wireType === 'lengthDelimited') {
        entries.push(readMediaEntry(reader.bytes(), entries.length))
      } else {
        reader.skip(tag)
      }
    }
  } catch {
    return Effect.fail(badMediaIndex)
  }
  return Schema.decodeUnknownEffect(Schema.Array(AnkiMediaEntry))(entries)
}

/** A `media` entry that is not a `MediaEntries` message: truncated bytes, not an index. */
const badMediaIndex = new AnkiCorruptArchive({
  reason: 'integrity',
  message:
    'This Anki export is damaged: its media index does not parse. Export it again from Anki.',
})
