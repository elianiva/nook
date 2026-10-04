import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  NOTETYPE_KIND_CLOZE,
  decodeDeckKind,
  decodeFieldConfig,
  decodeNotetypeConfig,
  decodeTemplateConfig,
} from '../src/AnkiModel'
import { boolField, bytesField, concat, stringField, uint32Field } from './Protobuf'

describe('decodeNotetypeConfig', () => {
  it.effect('reads the kind, the sort Field, and the stylesheet', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(
        concat(uint32Field(1, 0), uint32Field(2, 0), stringField(3, '.card { color: black }')),
      )
      expect(config).toEqual({ kind: 0, sortFieldIdx: 0, css: '.card { color: black }' })
    }),
  )

  it.effect('reads a cloze Note Type', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(uint32Field(1, NOTETYPE_KIND_CLOZE))
      expect(config.kind).toBe(NOTETYPE_KIND_CLOZE)
    }),
  )

  it.effect('reads a sort Field that is not the first one', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(uint32Field(2, 2))
      expect(config.sortFieldIdx).toBe(2)
    }),
  )

  it.effect('defaults an empty config, which a Note Type created by a very old Anki can have', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(new Uint8Array(0))
      expect(config).toEqual({ kind: 0, sortFieldIdx: 0, css: '' })
    }),
  )

  it.effect('skips the LaTeX settings and anything a newer Anki adds', () =>
    Effect.gen(function* () {
      const config = yield* decodeNotetypeConfig(
        concat(
          uint32Field(1, 1),
          stringField(5, '\\\\documentclass'),
          stringField(6, '\\\\end{document}'),
          boolField(7, true),
        ),
      )
      expect(config.kind).toBe(NOTETYPE_KIND_CLOZE)
    }),
  )
})

describe('decodeFieldConfig', () => {
  it.effect('reads a Field with no settings of its own', () =>
    Effect.gen(function* () {
      expect(yield* decodeFieldConfig(new Uint8Array(0))).toEqual({
        sticky: false,
        rightToLeft: false,
        fontName: null,
        fontSize: null,
        description: '',
        plainText: false,
      })
    }),
  )

  it.effect('reads a sticky, right-to-left Field in its own font', () =>
    Effect.gen(function* () {
      const config = yield* decodeFieldConfig(
        concat(
          boolField(1, true),
          boolField(2, true),
          stringField(3, 'Noto Naskh Arabic'),
          uint32Field(4, 28),
        ),
      )
      expect(config).toEqual({
        sticky: true,
        rightToLeft: true,
        fontName: 'Noto Naskh Arabic',
        fontSize: 28,
        description: '',
        plainText: false,
      })
    }),
  )

  it.effect('reads a Field described as plain text', () =>
    Effect.gen(function* () {
      expect(
        yield* decodeFieldConfig(concat(stringField(5, 'the reading'), boolField(6, true))),
      ).toEqual({
        sticky: false,
        rightToLeft: false,
        fontName: null,
        fontSize: null,
        description: 'the reading',
        plainText: true,
      })
    }),
  )
})

describe('decodeTemplateConfig', () => {
  it.effect('reads both sides of a Template and no target Deck', () =>
    Effect.gen(function* () {
      const config = yield* decodeTemplateConfig(
        concat(stringField(1, '{{Front}}'), stringField(2, '{{FrontSide}}<hr id=answer>{{Back}}')),
      )
      expect(config).toEqual({
        questionFormat: '{{Front}}',
        answerFormat: '{{FrontSide}}<hr id=answer>{{Back}}',
        deckId: 0,
      })
    }),
  )

  it.effect('reads a Template that sends its Cards to one Deck', () =>
    Effect.gen(function* () {
      const config = yield* decodeTemplateConfig(uint32Field(5, 1_706_642_737_485))
      expect(config.deckId).toBe(1_706_642_737_485)
    }),
  )

  it.effect('skips the browser formats', () =>
    Effect.gen(function* () {
      const config = yield* decodeTemplateConfig(
        concat(
          stringField(1, '{{Front}}'),
          stringField(3, '<b>{{Front}}</b>'),
          stringField(4, '{{Front}}'),
        ),
      )
      expect(config.questionFormat).toBe('{{Front}}')
      expect(config.answerFormat).toBe('')
    }),
  )
})

describe('decodeDeckKind', () => {
  it.effect('reads a normal Deck and its description', () =>
    Effect.gen(function* () {
      const kind = yield* decodeDeckKind(bytesField(1, stringField(4, 'from the textbook')))
      expect(kind).toEqual({ filtered: false, description: 'from the textbook' })
    }),
  )

  it.effect('marks a filtered Deck so the reader can skip it', () =>
    Effect.gen(function* () {
      const kind = yield* decodeDeckKind(bytesField(2, bytesField(1, uint32Field(1, 1))))
      expect(kind.filtered).toBe(true)
    }),
  )

  it.effect('defaults a Deck with no kind of its own', () =>
    Effect.gen(function* () {
      expect(yield* decodeDeckKind(new Uint8Array(0))).toEqual({ filtered: false, description: '' })
    }),
  )

  it.effect('reads a Deck whose description is empty', () =>
    Effect.gen(function* () {
      const kind = yield* decodeDeckKind(bytesField(1, stringField(4, '')))
      expect(kind.description).toBe('')
    }),
  )

  it.effect('skips the deck options Anki stores beside the description', () =>
    Effect.gen(function* () {
      const normal = concat(
        uint32Field(1, 1_700_000_000_002),
        stringField(4, 'kept'),
        uint32Field(7, 20),
      )
      const kind = yield* decodeDeckKind(bytesField(1, normal))
      expect(kind.description).toBe('kept')
    }),
  )
})
