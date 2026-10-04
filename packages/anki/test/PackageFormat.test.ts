import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { AnkiUnsupportedArchive } from '../src/AnkiErrors'
import { toHex } from '../src/Hash'
import {
  PACKAGE_VERSION_LATEST,
  PACKAGE_VERSION_UNNAMED,
  checkArchiveFormat,
  readMediaIndex,
  readPackageVersion,
} from '../src/PackageFormat'
import { boolField, bytesField, concat, stringField, uint32Field } from './Protobuf'

/** `PackageMetadata { Version version = 1 }` */
const meta = (version: number): Uint8Array => uint32Field(1, version)

/** `MediaEntries { repeated MediaEntry entries = 1 }`, one `MediaEntry` per file. */
const mediaIndex = (
  ...entries: ReadonlyArray<{
    readonly name: string
    readonly size: number
    readonly sha1: Uint8Array
  }>
): Uint8Array =>
  concat(
    ...entries.map((entry) =>
      bytesField(
        1,
        concat(stringField(1, entry.name), uint32Field(2, entry.size), bytesField(3, entry.sha1)),
      ),
    ),
  )

const digestOf = (byte: number): Uint8Array => new Uint8Array(20).fill(byte)

describe('readPackageVersion', () => {
  it('reads the version Anki wrote', () => {
    assert.strictEqual(readPackageVersion(meta(PACKAGE_VERSION_LATEST)), PACKAGE_VERSION_LATEST)
  })

  it("reads an older layout's version", () => {
    assert.strictEqual(readPackageVersion(meta(2)), 2)
  })

  it('reads an empty meta as no version, which is what an older Anki writes', () => {
    assert.strictEqual(readPackageVersion(new Uint8Array(0)), PACKAGE_VERSION_UNNAMED)
  })

  it('skips fields it does not know', () => {
    assert.strictEqual(readPackageVersion(concat(stringField(9, 'from a newer Anki'), meta(3))), 3)
  })
})

/** The error an archive is refused with, after asserting that it is refused. */
const rejection = (meta: Uint8Array | undefined) =>
  Effect.gen(function* () {
    const failure = yield* checkArchiveFormat(meta).pipe(Effect.flip)
    assert.instanceOf(failure, AnkiUnsupportedArchive)
    return failure
  })

describe('checkArchiveFormat', () => {
  it.effect('accepts the format nook reads', () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* checkArchiveFormat(meta(PACKAGE_VERSION_LATEST)),
        PACKAGE_VERSION_LATEST,
      )
    }),
  )

  it.effect('rejects a legacy archive and says which Anki setting to turn off', () =>
    Effect.gen(function* () {
      const error = yield* rejection(undefined)
      assert.strictEqual(error.reason, 'legacyExport')
      assert.match(error.message, /Support older Anki versions/)
    }),
  )

  it.effect('rejects the legacy layout that carries an older collection', () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* rejection(meta(2))).reason, 'formatTooNew')
    }),
  )

  it.effect('rejects a meta that names no version, which a newer Anki writes', () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* rejection(new Uint8Array(0))).reason, 'formatTooNew')
    }),
  )
})

describe('readMediaIndex', () => {
  it.effect('names each Media file by its position in the index', () =>
    Effect.gen(function* () {
      const index = yield* readMediaIndex(
        mediaIndex(
          { name: 'cat.png', size: 12, sha1: digestOf(0xaa) },
          { name: 'woof.mp3', size: 3456, sha1: digestOf(0xbb) },
        ),
      )

      assert.deepStrictEqual(index, [
        { name: 'cat.png', entry: '0', bytes: 12, checksum: 'aa'.repeat(20) },
        { name: 'woof.mp3', entry: '1', bytes: 3456, checksum: 'bb'.repeat(20) },
      ])
    }),
  )

  it.effect('reads an archive that carries no Media', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readMediaIndex(new Uint8Array(0)), [])
    }),
  )

  it.effect('defaults the fields a Media entry leaves out', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* readMediaIndex(mediaIndex({ name: 'cat.png', size: 0, sha1: new Uint8Array(0) })),
        [{ name: 'cat.png', entry: '0', bytes: 0, checksum: '' }],
      )
    }),
  )

  it.effect('skips the legacy zip filename Anki reserves and never sets', () =>
    Effect.gen(function* () {
      const entry = concat(
        stringField(1, 'cat.png'),
        uint32Field(2, 12),
        bytesField(3, digestOf(0xaa)),
        uint32Field(255, 4),
      )
      assert.deepStrictEqual(yield* readMediaIndex(bytesField(1, entry)), [
        { name: 'cat.png', entry: '0', bytes: 12, checksum: 'aa'.repeat(20) },
      ])
    }),
  )

  it.effect('refuses an index that is not a MediaEntries message', () =>
    Effect.gen(function* () {
      const failure = yield* readMediaIndex(new Uint8Array([0x0a, 0x40])).pipe(Effect.flip)
      assert.strictEqual(failure._tag, 'AnkiCorruptArchive')
    }),
  )

  it.effect('skips an unknown field of a Media entry', () =>
    Effect.gen(function* () {
      const entry = concat(boolField(7, true), stringField(1, 'cat.png'))
      const index = yield* readMediaIndex(bytesField(1, entry))
      assert.strictEqual(index[0]?.name, 'cat.png')
    }),
  )
})

describe('toHex', () => {
  it('writes a byte string the way Anki writes a checksum', () => {
    assert.strictEqual(toHex(new Uint8Array([0x00, 0x0f, 0xa5, 0xff])), '000fa5ff')
  })
})
