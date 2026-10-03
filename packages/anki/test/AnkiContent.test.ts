import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { AnkiCard, AnkiNote } from '../src/AnkiContent'

const decodeNote = Schema.decodeUnknownSync(AnkiNote)
const decodeCard = Schema.decodeUnknownSync(AnkiCard)

describe('AnkiNote', () => {
  it("reads a row of the notes table using Anki's column names", () => {
    const note = decodeNote({
      id: 1_706_642_722_424,
      guid: 'g1',
      mid: 1_700_000_000_001,
      mod: 1_707_681_587,
      flds: 'Cloze\u001fThe {{c1::word}} is {{c2::defined}}',
      tags: ' noun verb ',
    })

    expect(note).toEqual({
      id: 1_706_642_722_424,
      guid: 'g1',
      noteTypeId: 1_700_000_000_001,
      modified: 1_707_681_587,
      fields: ['Cloze', 'The {{c1::word}} is {{c2::defined}}'],
      tags: ['noun', 'verb'],
    })
  })

  it("keeps an empty Field, so a Note's Field count stays right", () => {
    const note = decodeNote({
      id: 1,
      guid: '',
      mid: 2,
      mod: 0,
      flds: 'Front\u001f\u001fBack',
      tags: '',
    })
    expect(note.fields).toEqual(['Front', '', 'Back'])
    expect(note.tags).toEqual([])
  })

  it('rejects a row that is not a Note', () => {
    expect(() => decodeNote({ id: 1, guid: 'g', mid: 2, mod: 0, flds: 4, tags: '' })).toThrow()
  })

  it('encodes back to the row Anki would have written', () => {
    const row = { id: 1, guid: 'g', mid: 2, mod: 3, flds: 'a\u001fb', tags: ' t ' }
    expect(Schema.encodeSync(AnkiNote)(decodeNote(row))).toEqual(row)
  })
})

describe('AnkiCard', () => {
  it('reads a row of the cards table and drops every scheduling column', () => {
    const card = decodeCard({
      id: 10,
      nid: 1_706_642_722_424,
      did: 1_706_642_737_485,
      odid: 0,
      ord: 1,
      queue: 2,
      flags: 0,
    })

    expect(card).toEqual({
      id: 10,
      noteId: 1_706_642_722_424,
      deckId: 1_706_642_737_485,
      templateOrd: 1,
      suspended: false,
      flag: 0,
    })
    expect(Object.keys(card).sort()).toEqual([
      'deckId',
      'flag',
      'id',
      'noteId',
      'suspended',
      'templateOrd',
    ])
  })

  it('sends a Card home when a filtered Deck moved it', () => {
    const card = decodeCard({ id: 10, nid: 1, did: 99, odid: 42, ord: 0, queue: 0, flags: 0 })
    expect(card.deckId).toBe(42)
  })

  it('reads a Card the Learner suspended', () => {
    expect(
      decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -1, flags: 0 }).suspended,
    ).toBe(true)
  })

  it('reads a buried Card as not suspended, because burying ends on its own', () => {
    expect(
      decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -2, flags: 0 }).suspended,
    ).toBe(false)
  })

  it('keeps only the star colour out of cards.flags', () => {
    expect(
      decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: 0, flags: 0b1101 }).flag,
    ).toBe(0b101)
  })

  it('encodes back to the row Anki would have written', () => {
    const row = { id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: 0, flags: 2 }
    expect(Schema.encodeSync(AnkiCard)(decodeCard(row))).toEqual(row)
  })

  it('encodes a suspended Card with the queue Anki suspends to', () => {
    const card = decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -1, flags: 0 })
    expect(Schema.encodeSync(AnkiCard)(card)).toEqual({
      id: 1,
      nid: 2,
      did: 3,
      odid: 0,
      ord: 0,
      queue: -1,
      flags: 0,
    })
  })
})
