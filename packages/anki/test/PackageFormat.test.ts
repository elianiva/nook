import { assert, describe, it } from '@effect/vitest'
import { Arbitrary, Effect, Schema } from 'effect'
import { toHex } from '../src/Hash'
import {
  PACKAGE_VERSION_LATEST,
  PACKAGE_VERSION_UNNAMED,
  checkArchiveFormat,
  readMediaIndex,
  readPackageVersion,
} from '../src/PackageFormat'
import { boolField, bytesField, concat, stringField, uint32Field } from './Protobuf'
import { bytes, nonEmptyText, uint32 } from './Generators'

/** `PackageMetadata { Version version = 1 }` */
const meta = (version: number): Uint8Array => uint32Field(1, version)

/** One `MediaEntry`, with the legacy zip filename that the reader must skip. */
const mediaEntry = (entry: {
  readonly name: string
  readonly size: number
  readonly sha1: Uint8Array
}): Uint8Array =>
  bytesField(
    1,
    concat(
      stringField(1, entry.name),
      uint32Field(2, entry.size),
      bytesField(3, entry.sha1),
      uint32Field(255, 4),
    ),
  )

const mediaIndex = (entries: ReadonlyArray<Parameters<typeof mediaEntry>[0]>): Uint8Array =>
  concat(...entries.map(mediaEntry))

const mediaValue = Arbitrary.all({ name: nonEmptyText, size: uint32, sha1: bytes(20) })

describe('readPackageVersion', () => {
  it.prop('reads the version Anki wrote', [uint32], ([version]) => {
    assert.strictEqual(readPackageVersion(meta(version)), version)
  })

  it.prop('skips fields it does not know', [uint32], ([version]) => {
    assert.strictEqual(
      readPackageVersion(concat(stringField(9, 'from a newer Anki'), meta(version))),
      version,
    )
  })

  it('reads an empty meta as no version, which is what an older Anki writes', () => {
    assert.strictEqual(readPackageVersion(new Uint8Array(0)), PACKAGE_VERSION_UNNAMED)
  })
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

  it.effect.prop(
    'rejects every other named version as too new',
    [uint32.pipe(Arbitrary.filter((version) => version !== PACKAGE_VERSION_LATEST))],
    ([version]) =>
      Effect.gen(function* () {
        const failure = yield* checkArchiveFormat(meta(version)).pipe(Effect.flip)
        assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
        assert.strictEqual((failure as { readonly reason: string }).reason, 'formatTooNew')
      }),
  )

  it.effect('rejects a legacy archive and says which Anki setting to turn off', () =>
    Effect.gen(function* () {
      const failure = yield* checkArchiveFormat(undefined).pipe(Effect.flip)
      assert.strictEqual(failure._tag, 'AnkiUnsupportedArchive')
      assert.strictEqual((failure as { readonly reason: string }).reason, 'legacyExport')
      assert.match((failure as { readonly message: string }).message, /Support older Anki versions/)
    }),
  )

  it.effect('rejects a meta that names no version, which a newer Anki writes', () =>
    Effect.gen(function* () {
      const failure = yield* checkArchiveFormat(new Uint8Array(0)).pipe(Effect.flip)
      assert.strictEqual((failure as { readonly reason: string }).reason, 'formatTooNew')
    }),
  )
})

describe('readMediaIndex', () => {
  it.effect.prop(
    'names each Media file by its position in the index',
    [Arbitrary.array(mediaValue)],
    ([entries]) =>
      Effect.gen(function* () {
        const index = yield* readMediaIndex(mediaIndex(entries))
        assert.deepStrictEqual(
          index,
          entries.map((entry, position) => ({
            name: entry.name,
            entry: String(position),
            bytes: entry.size,
            checksum: toHex(entry.sha1),
          })),
        )
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
      const index = yield* readMediaIndex(
        bytesField(1, concat(boolField(7, true), stringField(1, 'cat.png'))),
      )
      assert.strictEqual(index[0]?.name, 'cat.png')
    }),
  )
})

describe('toHex', () => {
  it.prop(
    'writes the bytes the same way every other tool does',
    [Arbitrary.schema(Schema.Uint8Array)],
    ([value]) => {
      assert.strictEqual(toHex(value), Buffer.from(value).toString('hex'))
    },
  )
})
