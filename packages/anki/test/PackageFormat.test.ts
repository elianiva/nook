import { describe, expect, it } from '@effect/vitest'
import { Option, Result } from 'effect'
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
    expect(readPackageVersion(meta(PACKAGE_VERSION_LATEST))).toBe(PACKAGE_VERSION_LATEST)
  })

  it("reads an older layout's version", () => {
    expect(readPackageVersion(meta(2))).toBe(2)
  })

  it('reads an empty meta as no version, which is what an older Anki writes', () => {
    expect(readPackageVersion(new Uint8Array(0))).toBe(PACKAGE_VERSION_UNNAMED)
  })

  it('skips fields it does not know', () => {
    expect(readPackageVersion(concat(stringField(9, 'from a newer Anki'), meta(3)))).toBe(3)
  })
})

/** The error an archive is refused with, after asserting that it is refused. */
const rejection = (meta: Uint8Array | undefined): AnkiUnsupportedArchive => {
  const verdict = checkArchiveFormat(meta)
  expect(Result.isFailure(verdict)).toBe(true)
  return Option.getOrThrow(Result.getFailure(verdict))
}

describe('checkArchiveFormat', () => {
  it('accepts the format nook reads', () => {
    const verdict = checkArchiveFormat(meta(PACKAGE_VERSION_LATEST))
    expect(Result.isSuccess(verdict)).toBe(true)
    expect(Option.getOrThrow(Result.getSuccess(verdict))).toBe(PACKAGE_VERSION_LATEST)
  })

  it('rejects a legacy archive and says which Anki setting to turn off', () => {
    const error = rejection(undefined)
    expect(error).toBeInstanceOf(AnkiUnsupportedArchive)
    expect(error.reason).toBe('legacyExport')
    expect(error.message).toContain('Support older Anki versions')
  })

  it('rejects the legacy layout that carries an older collection', () => {
    expect(rejection(meta(2)).reason).toBe('formatTooNew')
  })

  it('rejects a meta that names no version, which a newer Anki writes', () => {
    expect(rejection(new Uint8Array(0)).reason).toBe('formatTooNew')
  })
})

describe('readMediaIndex', () => {
  it('names each Media file by its position in the index', () => {
    const index = readMediaIndex(
      mediaIndex(
        { name: 'cat.png', size: 12, sha1: digestOf(0xaa) },
        { name: 'woof.mp3', size: 3456, sha1: digestOf(0xbb) },
      ),
    )

    expect(index).toEqual([
      { name: 'cat.png', entry: '0', bytes: 12, checksum: 'aa'.repeat(20) },
      { name: 'woof.mp3', entry: '1', bytes: 3456, checksum: 'bb'.repeat(20) },
    ])
  })

  it('reads an archive that carries no Media', () => {
    expect(readMediaIndex(new Uint8Array(0))).toEqual([])
  })

  it('defaults the fields a Media entry leaves out', () => {
    expect(
      readMediaIndex(mediaIndex({ name: 'cat.png', size: 0, sha1: new Uint8Array(0) })),
    ).toEqual([{ name: 'cat.png', entry: '0', bytes: 0, checksum: '' }])
  })

  it('skips the legacy zip filename Anki reserves and never sets', () => {
    const entry = concat(
      stringField(1, 'cat.png'),
      uint32Field(2, 12),
      bytesField(3, digestOf(0xaa)),
      uint32Field(255, 4),
    )
    expect(readMediaIndex(bytesField(1, entry))).toEqual([
      { name: 'cat.png', entry: '0', bytes: 12, checksum: 'aa'.repeat(20) },
    ])
  })

  it('refuses an index that is not a MediaEntries message', () => {
    expect(() => readMediaIndex(new Uint8Array([0x0a, 0x40]))).toThrow()
  })

  it('skips an unknown field of a Media entry', () => {
    const entry = concat(boolField(7, true), stringField(1, 'cat.png'))
    expect(readMediaIndex(bytesField(1, entry)).at(0)?.name).toBe('cat.png')
  })
})

describe('toHex', () => {
  it('writes a byte string the way Anki writes a checksum', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xa5, 0xff]))).toBe('000fa5ff')
  })
})
