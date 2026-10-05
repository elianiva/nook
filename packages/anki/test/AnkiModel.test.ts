import { assert, describe, it } from '@effect/vitest'
import { Arbitrary, Effect, Schema } from 'effect'
import {
  NOTETYPE_KIND_CLOZE,
  decodeDeckKind,
  decodeFieldConfig,
  decodeNotetypeConfig,
  decodeTemplateConfig,
} from '../src/AnkiModel'
import { boolField, bytesField, concat, stringField, uint32Field } from './Protobuf'
import { natural, optional, text, uint32 } from './Generators'

/** A message built from hex, for the bytes Anki actually wrote. */
const hex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16))

/**
 * Fields each decoder does not know, mixed into every encoded message so the
 * property also proves the reader steps over them.
 */
const unknownNotetype = concat(
  stringField(5, '\\documentclass'),
  stringField(6, '\\end{document}'),
  boolField(7, true),
  bytesField(8, uint32Field(1, 1)),
)
const unknownField = concat(
  boolField(7, true),
  boolField(8, true),
  // A random `int64` id above `Number.MAX_SAFE_INTEGER`, which a `number` cannot carry.
  new Uint8Array([0x48]),
  hex('98c4c4ffec8d89e534'),
  boolField(11, true),
)
const unknownTemplate = concat(
  stringField(3, '<b>{{Front}}</b>'),
  stringField(4, '{{Front}}'),
  stringField(6, 'Arial'),
  uint32Field(7, 24),
  new Uint8Array([0x40]),
  hex('c8dbeabec5f4b7a19101'),
)

interface FieldConfigValue {
  readonly sticky: boolean
  readonly rightToLeft: boolean
  readonly fontName: string | null
  readonly fontSize: number | null
  readonly description: string
  readonly plainText: boolean
}

const notetypeConfigValues = Arbitrary.all({ kind: uint32, sortFieldIdx: uint32, css: text })
const fieldConfigValues: Arbitrary.Arbitrary<FieldConfigValue> = Arbitrary.all({
  sticky: Arbitrary.schema(Schema.Boolean),
  rightToLeft: Arbitrary.schema(Schema.Boolean),
  fontName: optional(text),
  fontSize: optional(uint32),
  description: text,
  plainText: Arbitrary.schema(Schema.Boolean),
})
const templateConfigValues = Arbitrary.all({
  questionFormat: text,
  answerFormat: text,
  deckId: natural,
})

const encodeNotetypeConfig = (config: { kind: number; sortFieldIdx: number; css: string }) =>
  concat(
    uint32Field(1, config.kind),
    uint32Field(2, config.sortFieldIdx),
    stringField(3, config.css),
    unknownNotetype,
  )

const encodeFieldConfig = (config: FieldConfigValue) =>
  concat(
    boolField(1, config.sticky),
    boolField(2, config.rightToLeft),
    config.fontName === null ? new Uint8Array(0) : stringField(3, config.fontName),
    config.fontSize === null ? new Uint8Array(0) : uint32Field(4, config.fontSize),
    stringField(5, config.description),
    boolField(6, config.plainText),
    unknownField,
  )

const encodeTemplateConfig = (config: {
  questionFormat: string
  answerFormat: string
  deckId: number
}) =>
  concat(
    stringField(1, config.questionFormat),
    stringField(2, config.answerFormat),
    uint32Field(5, config.deckId),
    unknownTemplate,
  )

describe('decodeNotetypeConfig', () => {
  it.effect.prop(
    'reads the kind, the sort Field, and the stylesheet it was given',
    [notetypeConfigValues],
    ([config]) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* decodeNotetypeConfig(encodeNotetypeConfig(config)), config)
      }),
  )

  it.effect('defaults a Note Type created by a very old Anki, which has no config', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeNotetypeConfig(new Uint8Array(0)), {
        kind: 0,
        sortFieldIdx: 0,
        css: '',
      })
    }),
  )

  it.effect('reads a cloze Note Type', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(uint32Field(1, NOTETYPE_KIND_CLOZE))
      assert.strictEqual(config.kind, NOTETYPE_KIND_CLOZE)
    }),
  )
})

describe('decodeFieldConfig', () => {
  it.effect.prop(
    'reads every Field setting and steps over the int64 id Anki 23.10 adds',
    [fieldConfigValues],
    ([config]) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* decodeFieldConfig(encodeFieldConfig(config)), config)
      }),
  )

  it.effect('reads the id Anki writes beside the settings, from a real export', () =>
    Effect.gen(function* () {
      // The `Word` Field of Kaishi 1.5k, whose field 9 is a ten-byte `int64`.
      const config = yield* decodeFieldConfig(
        hex('1a0c4e6f746f2053616e73204a5020144898c4c4ffec8d89e534'),
      )
      assert.deepStrictEqual(config, {
        sticky: false,
        rightToLeft: false,
        fontName: 'Noto Sans JP',
        fontSize: 20,
        description: '',
        plainText: false,
      })
    }),
  )

  it.effect('defaults a Field with no settings of its own', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeFieldConfig(new Uint8Array(0)), {
        sticky: false,
        rightToLeft: false,
        fontName: null,
        fontSize: null,
        description: '',
        plainText: false,
      })
    }),
  )
})

describe('decodeTemplateConfig', () => {
  it.effect.prop(
    'reads both sides of a Template and its target Deck',
    [templateConfigValues],
    ([config]) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* decodeTemplateConfig(encodeTemplateConfig(config)), config)
      }),
  )

  it.effect('reads the id Anki writes beside the formats, from a real export', () =>
    Effect.gen(function* () {
      // The `Card 1` Template of Kaishi 1.5k, whose field 8 is a ten-byte `int64`.
      const config = yield* decodeTemplateConfig(
        hex(
          '0a097b7b46726f6e747d7d12277b7b46726f6e74536964657d7d0a0a3c68722069643d616e737765723e0a0a7b7b4261636b7d7d40c8dbeabec5f4b7a19101',
        ),
      )
      assert.strictEqual(config.questionFormat, '{{Front}}')
      assert.strictEqual(config.answerFormat, '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}')
      assert.strictEqual(config.deckId, 0)
    }),
  )
})

describe('decodeDeckKind', () => {
  it.effect.prop('reads a normal Deck and its description', [text], ([description]) =>
    Effect.gen(function* () {
      const kind = yield* decodeDeckKind(
        bytesField(
          1,
          concat(
            uint32Field(1, 1_700_000_000_002),
            stringField(4, description),
            uint32Field(7, 20),
          ),
        ),
      )
      assert.deepStrictEqual(kind, { filtered: false, description })
    }),
  )

  it.effect('marks a filtered Deck so the reader can skip it', () =>
    Effect.gen(function* () {
      const kind = yield* decodeDeckKind(bytesField(2, bytesField(1, uint32Field(1, 1))))
      assert.strictEqual(kind.filtered, true)
    }),
  )

  it.effect('defaults a Deck with no kind of its own, which a very old Anki writes', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeDeckKind(new Uint8Array(0)), {
        filtered: false,
        description: '',
      })
    }),
  )
})
