import { assert, describe, expect, it } from '@effect/vitest'
import { Arbitrary, Schema } from 'effect'
import { AnkiDiagnostic } from '../src/AnkiDiagnostic'
import { AnkiDeck, AnkiManifest, AnkiNoteType } from '../src/AnkiManifest'
import { joinComponents } from '../src/DeckName'
import { text } from './Generators'

const decodeDeck = Schema.decodeUnknownSync(AnkiDeck)
const encodeDeck = Schema.encodeSync(AnkiDeck)
const decodeNoteType = Schema.decodeUnknownSync(AnkiNoteType)
const decodeDiagnostic = Schema.decodeUnknownSync(AnkiDiagnostic)

/** An empty component is stored as `blank`, so only a non-empty one round-trips. */
const component = text.pipe(
  Arbitrary.filter((value) => value.length > 0 && !value.includes('\x1f')),
)

/** The native Deck name Anki would write, which has no empty component. */
const nativeName = text.pipe(
  Arbitrary.filter(
    (value) => !value.startsWith('\x1f') && !value.endsWith('\x1f') && !value.includes('\x1f\x1f'),
  ),
)

/** A row of `decks`, with Anki's native name and no decoding. */
const DeckRow = Arbitrary.all({
  id: Arbitrary.schema(Schema.Number),
  name: nativeName,
  description: Arbitrary.schema(Schema.String),
})

describe('AnkiDeck', () => {
  it.prop('reads a Deck into components and writes the row back unchanged', [DeckRow], ([row]) => {
    assert.deepStrictEqual(encodeDeck(decodeDeck(row)), row)
  })

  it.prop(
    'reads a nested Deck as its components, root first',
    [Arbitrary.array(component)],
    ([components]) => {
      const deck = decodeDeck({ id: 1, name: joinComponents(components), description: '' })
      expect(deck.components).toEqual(components)
    },
  )
})

describe('AnkiNoteType', () => {
  it.prop('round-trips every Note Type', [Arbitrary.schema(AnkiNoteType)], ([noteType]) => {
    assert.deepStrictEqual(decodeNoteType(noteType), noteType)
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

describe('AnkiManifest', () => {
  it('counts what the archive holds', () => {
    const manifest = Schema.decodeUnknownSync(AnkiManifest)({
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
    expect(manifest.media.at(0)?.entry).toBe('0')
  })
})

describe('AnkiDiagnostic', () => {
  it.prop('reads every problem it reports', [Arbitrary.schema(AnkiDiagnostic)], ([diagnostic]) => {
    assert.deepStrictEqual(decodeDiagnostic(diagnostic), diagnostic)
  })
})
