import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { AnkiDiagnostic } from '../src/AnkiDiagnostic'
import { AnkiDeck, AnkiField, AnkiManifest, AnkiNoteType, AnkiTemplate } from '../src/AnkiManifest'

const decodeDeck = Schema.decodeUnknownSync(AnkiDeck)
const decodeNoteType = Schema.decodeUnknownSync(AnkiNoteType)
const decodeManifest = Schema.decodeUnknownSync(AnkiManifest)

describe('AnkiDeck', () => {
  it('reads a Deck at the root', () => {
    expect(decodeDeck({ id: 1, name: 'Japanese', description: '' })).toEqual({
      id: 1,
      components: ['Japanese'],
      description: '',
    })
  })

  it('reads a nested Deck as its components, root first', () => {
    expect(decodeDeck({ id: 2, name: 'Japanese\u001fVocab', description: '' }).components).toEqual([
      'Japanese',
      'Vocab',
    ])
  })

  it('keeps a colon inside a component, which :: would have lost', () => {
    expect(
      decodeDeck({ id: 2, name: 'Japanese\u001fGrammar: advanced', description: '' }).components,
    ).toEqual(['Japanese', 'Grammar: advanced'])
  })

  it('encodes back to the native name', () => {
    const row = { id: 2, name: 'Japanese\u001fblank\u001fVocab', description: 'from a textbook' }
    expect(Schema.encodeSync(AnkiDeck)(decodeDeck(row))).toEqual(row)
  })
})

describe('AnkiNoteType', () => {
  it('reads a Note Type with its Fields and Templates', () => {
    const noteType = decodeNoteType({
      id: 1_700_000_000_001,
      name: 'Basic',
      kind: 'normal',
      sortFieldOrd: 0,
      css: '.card { font-size: 20px }',
      fields: [
        {
          ord: 0,
          name: 'Front',
          rightToLeft: false,
          fontName: null,
          fontSize: null,
          plainText: false,
          description: '',
          sticky: true,
        },
        {
          ord: 1,
          name: 'Back',
          rightToLeft: false,
          fontName: 'Arial',
          fontSize: 24,
          plainText: true,
          description: 'the answer',
          sticky: false,
        },
      ],
      templates: [
        {
          ord: 0,
          name: 'Card 1',
          questionFormat: '{{Front}}',
          answerFormat: '{{FrontSide}}\n\n<hr id=answer>\n{{Back}}',
          deckId: 0,
        },
      ],
    })

    expect(noteType.kind).toBe('normal')
    expect(noteType.fields.map((field) => field.name)).toEqual(['Front', 'Back'])
    expect(noteType.templates.at(0)?.questionFormat).toBe('{{Front}}')
  })

  it('reads a cloze Note Type', () => {
    const noteType = decodeNoteType({
      id: 2,
      name: 'Cloze',
      kind: 'cloze',
      sortFieldOrd: 0,
      css: '',
      fields: [
        {
          ord: 0,
          name: 'Text',
          rightToLeft: false,
          fontName: null,
          fontSize: null,
          plainText: false,
          description: '',
          sticky: false,
        },
      ],
      templates: [],
    })
    expect(noteType.kind).toBe('cloze')
  })

  it('refuses a Note Type whose kind is neither normal nor cloze', () => {
    expect(() =>
      decodeNoteType({
        id: 2,
        name: 'Odd',
        kind: 'other',
        sortFieldOrd: 0,
        css: '',
        fields: [],
        templates: [],
      }),
    ).toThrow()
  })
})

describe('AnkiField and AnkiTemplate', () => {
  it('carry no codecs, so they decode as themselves', () => {
    const field = Schema.decodeUnknownSync(AnkiField)({
      ord: 0,
      name: 'Front',
      rightToLeft: true,
      fontName: null,
      fontSize: null,
      plainText: false,
      description: '',
      sticky: false,
    })
    expect(field.rightToLeft).toBe(true)

    const template = Schema.decodeUnknownSync(AnkiTemplate)({
      ord: 0,
      name: 'Card 1',
      questionFormat: '{{Front}}',
      answerFormat: '{{Back}}',
      deckId: 0,
    })
    expect(template.deckId).toBe(0)
  })
})

describe('AnkiManifest', () => {
  it('counts what the archive holds', () => {
    const manifest = decodeManifest({
      schemaVersion: 18,
      noteTypes: [],
      decks: [],
      media: [{ name: 'cat.png', entry: '0', bytes: 12, checksum: 'a'.repeat(40) }],
      noteCount: 3402,
      cardCount: 6804,
      mediaCount: 1,
      mediaBytes: 12,
    })

    expect(manifest.noteCount).toBe(3402)
    expect(manifest.cardCount).toBe(6804)
    expect(manifest.media.at(0)?.entry).toBe('0')
  })
})

describe('AnkiDiagnostic', () => {
  it('reads each problem it reports', () => {
    const decode = Schema.decodeUnknownSync(AnkiDiagnostic)
    expect(decode({ _tag: 'AnkiMissingMedia', name: 'cat.png', noteId: 7 })).toEqual({
      _tag: 'AnkiMissingMedia',
      name: 'cat.png',
      noteId: 7,
    })
    expect(decode({ _tag: 'AnkiMediaChecksumMismatch', name: 'cat.png' })).toEqual({
      _tag: 'AnkiMediaChecksumMismatch',
      name: 'cat.png',
    })
  })
})
