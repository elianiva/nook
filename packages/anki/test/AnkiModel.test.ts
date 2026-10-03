import { describe, expect, it } from '@effect/vitest'
import {
  NOTETYPE_KIND_CLOZE,
  decodeDeckKind,
  decodeFieldConfig,
  decodeNotetypeConfig,
  decodeTemplateConfig,
} from '../src/AnkiModel'
import { boolField, bytesField, concat, stringField, uint32Field } from './Protobuf'

describe('decodeNotetypeConfig', () => {
  it('reads the kind, the sort Field, and the stylesheet', () => {
    const config = decodeNotetypeConfig(
      concat(uint32Field(1, 0), uint32Field(2, 0), stringField(3, '.card { color: black }')),
    )
    expect(config).toEqual({ kind: 0, sortFieldIdx: 0, css: '.card { color: black }' })
  })

  it('reads a cloze Note Type', () => {
    expect(decodeNotetypeConfig(uint32Field(1, NOTETYPE_KIND_CLOZE)).kind).toBe(NOTETYPE_KIND_CLOZE)
  })

  it('reads a sort Field that is not the first one', () => {
    expect(decodeNotetypeConfig(uint32Field(2, 2)).sortFieldIdx).toBe(2)
  })

  it('defaults an empty config, which a Note Type created by a very old Anki can have', () => {
    expect(decodeNotetypeConfig(new Uint8Array(0))).toEqual({ kind: 0, sortFieldIdx: 0, css: '' })
  })

  it('skips the LaTeX settings and anything a newer Anki adds', () => {
    const config = decodeNotetypeConfig(
      concat(
        uint32Field(1, 1),
        stringField(5, '\\documentclass'),
        stringField(6, '\\end{document}'),
        boolField(7, true),
      ),
    )
    expect(config.kind).toBe(NOTETYPE_KIND_CLOZE)
  })
})

describe('decodeFieldConfig', () => {
  it('reads a Field with no settings of its own', () => {
    expect(decodeFieldConfig(new Uint8Array(0))).toEqual({
      sticky: false,
      rightToLeft: false,
      fontName: null,
      fontSize: null,
      description: '',
      plainText: false,
    })
  })

  it('reads a sticky, right-to-left Field in its own font', () => {
    const config = decodeFieldConfig(
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
  })

  it('reads a Field described as plain text', () => {
    expect(decodeFieldConfig(concat(stringField(5, 'the reading'), boolField(6, true)))).toEqual({
      sticky: false,
      rightToLeft: false,
      fontName: null,
      fontSize: null,
      description: 'the reading',
      plainText: true,
    })
  })
})

describe('decodeTemplateConfig', () => {
  it('reads both sides of a Template and no target Deck', () => {
    const config = decodeTemplateConfig(
      concat(stringField(1, '{{Front}}'), stringField(2, '{{FrontSide}}<hr id=answer>{{Back}}')),
    )
    expect(config).toEqual({
      questionFormat: '{{Front}}',
      answerFormat: '{{FrontSide}}<hr id=answer>{{Back}}',
      deckId: 0,
    })
  })

  it('reads a Template that sends its Cards to one Deck', () => {
    expect(decodeTemplateConfig(uint32Field(5, 1_706_642_737_485)).deckId).toBe(1_706_642_737_485)
  })

  it('skips the browser formats', () => {
    const config = decodeTemplateConfig(
      concat(
        stringField(1, '{{Front}}'),
        stringField(3, '<b>{{Front}}</b>'),
        stringField(4, '{{Front}}'),
      ),
    )
    expect(config.questionFormat).toBe('{{Front}}')
    expect(config.answerFormat).toBe('')
  })
})

describe('decodeDeckKind', () => {
  it('reads a normal Deck and its description', () => {
    const kind = decodeDeckKind(bytesField(1, stringField(4, 'from the textbook')))
    expect(kind).toEqual({ filtered: false, description: 'from the textbook' })
  })

  it('marks a filtered Deck so the reader can skip it', () => {
    expect(decodeDeckKind(bytesField(2, bytesField(1, uint32Field(1, 1)))).filtered).toBe(true)
  })

  it('defaults a Deck with no kind of its own', () => {
    expect(decodeDeckKind(new Uint8Array(0))).toEqual({ filtered: false, description: '' })
  })

  it('reads a Deck whose description is empty', () => {
    expect(decodeDeckKind(bytesField(1, stringField(4, ''))).description).toBe('')
  })

  it('skips the deck options Anki stores beside the description', () => {
    const normal = concat(
      uint32Field(1, 1_700_000_000_002),
      stringField(4, 'kept'),
      uint32Field(7, 20),
    )
    expect(decodeDeckKind(bytesField(1, normal)).description).toBe('kept')
  })
})
