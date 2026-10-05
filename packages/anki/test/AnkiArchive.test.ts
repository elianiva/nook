import { createHash } from 'node:crypto'
import { assert, describe, it } from '@effect/vitest'
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { Effect, Stream } from 'effect'
import { AnkiArchive, layer } from '../src/AnkiArchive'
import { AnkiSqliteNode } from '../src/SqliteArchiveNode'
import { COLLECTION_ENTRY, META_ENTRY } from '../src/PackageFormat'
import { uint32Field } from './Protobuf'
import { removeCollection, writeCollection } from './Collection'
import type { CollectionSpec } from './Collection'
import { kaishiArchive } from './Kaishi'

const openArchive = (archive: Blob) =>
  Effect.flatMap(AnkiArchive, (service) => service.open(archive)).pipe(
    Effect.provide(layer(AnkiSqliteNode.source)),
  )

/**
 * Builds the archives the real fixture cannot provide: a damaged one, or one
 * that names a format or schema nook refuses. The collection is a real SQLite
 * file, compressed and zipped the way Anki writes one, so the only difference
 * from a real archive is the thing each test is about.
 */
const archiveOf = async (spec: CollectionSpec): Promise<Blob> => {
  const zlib = await import('node:zlib')
  const fs = await import('node:fs')
  const filename = writeCollection(spec)
  try {
    const collection = zlib.zstdCompressSync(fs.readFileSync(filename))
    const writer = new ZipWriter(new BlobWriter('application/zip'))
    await writer.add(META_ENTRY, new Uint8ArrayReader(uint32Field(1, 3)))
    await writer.add(COLLECTION_ENTRY, new Uint8ArrayReader(new Uint8Array(collection)))
    return writer.close()
  } finally {
    removeCollection(filename)
  }
}

/** A zip that holds only the named entries, with no collection behind them. */
const zipOf = async (entries: ReadonlyArray<readonly [string, Uint8Array]>): Promise<Blob> => {
  const writer = new ZipWriter(new BlobWriter('application/zip'))
  for (const [name, bytes] of entries) {
    await writer.add(name, new Uint8ArrayReader(bytes))
  }
  return writer.close()
}

describe('AnkiArchive', () => {
  it.effect(
    'reads the real Kaishi 1.5k export end to end',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const archive = yield* AnkiArchive
          const opened = yield* archive.open(yield* kaishiArchive())
          const manifest = yield* opened.manifest

          assert.strictEqual(manifest.schemaVersion, 18)
          assert.strictEqual(manifest.noteCount, 1501)
          assert.strictEqual(manifest.cardCount, 1501)
          assert.strictEqual(manifest.mediaCount, 4354)
          assert.deepStrictEqual(
            manifest.decks.map((deck) => deck.components),
            [['Default'], ['Kaishi 1.5k']],
          )

          // Anki 23.10 writes a random `int64` id into every Field and Template
          // config. A reader that cannot step over one never reaches this point.
          const noteType = manifest.noteTypes[0]
          assert.strictEqual(noteType?.name, 'Kaishi 1.5k')
          assert.strictEqual(noteType?.kind, 'normal')
          assert.strictEqual(noteType?.fields.length, 14)
          assert.strictEqual(noteType?.fields.at(0)?.name, 'Word')
          assert.strictEqual(noteType?.fields.at(0)?.fontName, 'Noto Sans JP')
          assert.strictEqual(noteType?.fields.at(0)?.fontSize, 20)
          assert.strictEqual(noteType?.fields.at(-1)?.name, 'Picture')
          assert.strictEqual(noteType?.templates.at(0)?.name, 'Card 1')

          const notes = yield* Stream.runCollect(Stream.take(opened.notes, 1))
          assert.strictEqual(notes[0]?.fields.length, 14)
          assert.match(notes[0]?.fields.at(0) ?? '', /^Welcome to Kaishi 1\.5k/)
          assert.deepStrictEqual(notes[0]?.tags, [])

          const cards = yield* Stream.runCollect(Stream.take(opened.cards, 1))
          assert.strictEqual(cards[0]?.deckId, 1_710_244_071_681)

          // Every Media file is a zstd frame around the file itself. Reading the
          // frame back is what makes its bytes hash to the declared SHA-1 and
          // match the declared size.
          const media = yield* Stream.runCollect(Stream.take(opened.media, 3))
          assert.strictEqual(media.length, 3)
          for (const file of media) {
            const declared = manifest.media.find((entry) => entry.name === file.name)
            assert.strictEqual(file.bytes.length, declared?.bytes)
            assert.strictEqual(createHash('sha1').update(file.bytes).digest('hex'), file.checksum)
          }

          assert.deepStrictEqual(yield* opened.diagnostics, [])
        }),
      ).pipe(Effect.provide(layer(AnkiSqliteNode.source))),
    // The first run downloads the 108 MiB archive, which outlives the 5 s default.
    120_000,
  )

  it.effect('rejects a legacy archive that names no format', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const zipped = yield* Effect.promise(() => zipOf([['media', new Uint8Array([1, 2, 3])]]))
        const failure = yield* openArchive(zipped).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'legacyExport')
      }),
    ),
  )

  it.effect('rejects an archive whose collection is missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const zipped = yield* Effect.promise(() => zipOf([[META_ENTRY, uint32Field(1, 3)]]))
        const failure = yield* openArchive(zipped).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiCorruptArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'missingCollection')
      }),
    ),
  )

  it.effect('rejects a file that is not a zip', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = yield* openArchive(new Blob(['not a zip'])).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiCorruptArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'notAZipArchive')
      }),
    ),
  )

  it.effect('rejects a schema nook does not know', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* Effect.promise(() => archiveOf({ schemaVersion: 10 }))
        const failure = yield* openArchive(archive).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'schemaTooOld')
      }),
    ),
  )
})
