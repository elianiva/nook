import { assert, describe, it } from '@effect/vitest'
import { BlobReader, BlobWriter, Uint8ArrayReader, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { Effect, Stream } from 'effect'
import { AnkiArchive, layer } from '../src/AnkiArchive'
import { AnkiSqliteNode } from '../src/SqliteArchiveNode'
import { COLLECTION_ENTRY, MEDIA_ENTRY, META_ENTRY } from '../src/PackageFormat'
import { concat, stringField, uint32Field, bytesField } from './Protobuf'
import { removeCollection, writeCollection } from './Collection'
import type { CollectionSpec } from './Collection'

/**
 * An `.apkg` archive, shaped the way Anki shapes one.
 *
 * Each entry arrives compressed by zip; the collection and media-index entries
 * carry a second layer, a bare zstd frame around the SQLite file and around the
 * Media index. `node:zlib` writes that layer here the way Anki does, and fzstd
 * reads it back in production, so the round trip crosses two implementations.
 */
const buildArchive = async (
  spec: CollectionSpec,
  mediaFiles: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Promise<Blob> => {
  const zlib = await import('node:zlib')
  const fs = await import('node:fs')
  const filename = writeCollection(spec)
  try {
    const collectionBytes = fs.readFileSync(filename)
    const compressed = zlib.zstdCompressSync(collectionBytes)

    const indexPayload = concat(
      ...mediaFiles.map((file) =>
        bytesField(
          1,
          concat(
            stringField(1, file.name),
            uint32Field(2, file.bytes.length),
            bytesField(3, new Uint8Array(0)),
          ),
        ),
      ),
    )
    const writer = new ZipWriter(new BlobWriter('application/zip'))
    await writer.add(META_ENTRY, new Uint8ArrayReader(uint32Field(1, 3)))
    await writer.add(COLLECTION_ENTRY, new Uint8ArrayReader(new Uint8Array(compressed)))
    await writer.add(
      MEDIA_ENTRY,
      new Uint8ArrayReader(new Uint8Array(zlib.zstdCompressSync(indexPayload))),
    )
    for (const [position, file] of mediaFiles.entries()) {
      await writer.add(String(position), new Uint8ArrayReader(file.bytes))
    }
    return writer.close()
  } finally {
    removeCollection(filename)
  }
}

const openArchive = (archive: Blob) =>
  Effect.flatMap(AnkiArchive, (service) => service.open(archive)).pipe(
    Effect.provide(layer(AnkiSqliteNode.source)),
  )

describe('AnkiArchive', () => {
  it.effect('reads a real archive end to end', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* Effect.promise(() =>
          buildArchive(
            {
              decks: [{ id: 1, name: 'Japanese' }],
              noteTypes: [
                {
                  id: 100,
                  name: 'Basic',
                  fields: [{ name: 'Front' }, { ord: 1, name: 'Back' }],
                  templates: [{ name: 'Card 1' }],
                },
              ],
              notes: [{ id: 10, noteTypeId: 100, fields: ['水', 'water'], tags: ['noun'] }],
              cards: [{ id: 20, noteId: 10, deckId: 1 }],
            },
            [{ name: 'clip.mp3', bytes: new TextEncoder().encode('audio') }],
          ),
        )

        const opened = yield* openArchive(archive)
        const manifest = yield* opened.manifest
        assert.strictEqual(manifest.schemaVersion, 18)
        assert.strictEqual(manifest.noteCount, 1)
        assert.strictEqual(manifest.cardCount, 1)
        assert.deepStrictEqual(
          manifest.decks.map((deck) => deck.id),
          [1],
        )
        assert.strictEqual(manifest.noteTypes[0]?.name, 'Basic')

        const notes = yield* Stream.runCollect(opened.notes)
        assert.deepStrictEqual(notes[0]?.fields, ['水', 'water'])

        const cards = yield* Stream.runCollect(opened.cards)
        assert.strictEqual(cards[0]?.deckId, 1)

        const media = yield* Stream.runCollect(opened.media)
        assert.strictEqual(media[0]?.name, 'clip.mp3')
        assert.deepStrictEqual([...(media[0]?.bytes ?? [])], [...new TextEncoder().encode('audio')])

        const diagnostics = yield* opened.diagnostics
        assert.deepStrictEqual(diagnostics, [])
      }),
    ),
  )

  it.effect('rejects a legacy archive that names no format', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const zipped = yield* Effect.promise(async () => {
          const inner = new ZipWriter(new BlobWriter('application/zip'))
          await inner.add('media', new Uint8ArrayReader(new Uint8Array([1, 2, 3])))
          return inner.close()
        })
        const failure = yield* openArchive(zipped).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'legacyExport')
      }),
    ),
  )

  it.effect('rejects an archive whose collection is missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const zipped = yield* Effect.promise(async () => {
          const inner = new ZipWriter(new BlobWriter('application/zip'))
          await inner.add(META_ENTRY, new Uint8ArrayReader(uint32Field(1, 3)))
          return inner.close()
        })
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
        const archive = yield* Effect.promise(() => buildArchive({ schemaVersion: 10 }, []))
        const failure = yield* openArchive(archive).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'schemaTooOld')
      }),
    ),
  )
})

describe('zip entry listing', () => {
  it('reads back what the writer wrote', async () => {
    const archive = await buildArchive({ decks: [{ id: 1, name: 'D' }] }, [])
    const reader = new ZipReader(new BlobReader(archive))
    try {
      const names = (await reader.getEntries()).map((entry) => entry.filename)
      assert.ok(names.includes(META_ENTRY))
      assert.ok(names.includes(COLLECTION_ENTRY))
      assert.ok(names.includes(MEDIA_ENTRY))
    } finally {
      await reader.close()
    }
  })
})
