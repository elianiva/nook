import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { Effect, Stream } from 'effect'
import { AnkiArchive, layer } from '../src/AnkiArchive'
import type { ArchiveReadStage } from '../src/AnkiArchive'
import { AnkiSqliteMemory } from '../src/SqliteArchive'
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

const openArchiveMemory = (archive: Blob, onStage?: (stage: ArchiveReadStage) => void) =>
  Effect.flatMap(AnkiArchive, (service) => service.open(archive, onStage)).pipe(
    Effect.provide(layer(AnkiSqliteMemory.source)),
  )

/**
 * wa-sqlite loads its engine with `fetch`, which cannot read the `.wasm` file
 * under node. The shim serves it from disk, so the browser's memory source
 * runs in these tests. Production bundles are unaffected: they serve the file
 * over HTTP, where `fetch` works.
 */
const withWasmFetch = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  // The package exposes no export for the `.wasm` file, so resolve it beside
  // the module the memory source imports.
  const require = createRequire(import.meta.url)
  const wasm = join(
    dirname(require.resolve('@effect/wa-sqlite/dist/wa-sqlite.mjs')),
    'wa-sqlite.wasm',
  )
  const bytes = readFileSync(wasm)
  const realFetch = globalThis.fetch
  const shim = (input: unknown, init?: RequestInit): Promise<Response> =>
    typeof input === 'string' && input.endsWith('.wasm')
      ? Promise.resolve(
          new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-type': 'application/wasm' },
          }),
        )
      : realFetch(input as URL, init)
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      globalThis.fetch = shim as typeof fetch
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        globalThis.fetch = realFetch
      }),
  )
}

/**
 * Builds the archives the real fixture cannot provide: a damaged one, or one
 * that names a format or schema nook refuses. The collection is a real SQLite
 * file, compressed and zipped the way Anki writes one, so the only difference
 * from a real archive is the thing each test is about.
 */
const archiveOf = async (spec: CollectionSpec, wal = false): Promise<Blob> => {
  const zlib = await import('node:zlib')
  const fs = await import('node:fs')
  const filename = writeCollection(spec)
  try {
    if (wal) {
      // Anki writes its collection in WAL mode: the header names WAL, and the
      // frames live in a `-wal` file Anki never ships inside the archive. The
      // checkpoint folds every frame back into the image, so the file the
      // archive carries is self-consistent under a WAL header, as Anki writes.
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(filename)
      try {
        db.exec('PRAGMA journal_mode=WAL')
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        db.close()
      }
    }
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
  // The Kaishi archive is a 103.7 MiB real export that takes minutes to read,
  // so this test runs only when `NOOK_TEST_KAISHI` is set (`pnpm test:kaishi`).
  // The default `pnpm test` skips it.
  it.effect.runIf(process.env['NOOK_TEST_KAISHI'] !== undefined)(
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

  it.effect('opens a WAL-mode collection through the browser source', () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Anki writes its collection in WAL mode, which the browser's
        // in-memory SQLite cannot open without its `-wal` file. The reader
        // downgrades the header to rollback, which is safe because the archive
        // never carries the `-wal` file.
        const archive = yield* Effect.promise(() =>
          archiveOf(
            {
              decks: [{ id: 1, name: 'Default' }],
              noteTypes: [
                {
                  id: 1,
                  name: 'Basic',
                  fields: [{ name: 'Front' }, { name: 'Back', ord: 1 }],
                  templates: [{ name: 'Card 1' }],
                },
              ],
              notes: [{ id: 1, noteTypeId: 1, fields: ['front', 'back'] }],
              cards: [{ id: 1, noteId: 1, deckId: 1 }],
            },
            true,
          ),
        )
        const opened = yield* withWasmFetch(openArchiveMemory(archive))
        const manifest = yield* opened.manifest
        assert.strictEqual(manifest.noteCount, 1)
        assert.strictEqual(manifest.cardCount, 1)
      }),
    ),
  )

  it.effect('reports each step of opening an archive', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archive = yield* Effect.promise(() => archiveOf({}))
        const stages: Array<ArchiveReadStage> = []
        const opened = yield* withWasmFetch(
          openArchiveMemory(archive, (stage) => {
            stages.push(stage)
          }),
        )
        assert.deepStrictEqual(stages, [
          'opening',
          'listing',
          'collection',
          'mediaIndex',
          'database',
        ])
        yield* opened.manifest
        assert.deepStrictEqual(stages, [
          'opening',
          'listing',
          'collection',
          'mediaIndex',
          'database',
          'manifest',
        ])
      }),
    ),
  )
})
