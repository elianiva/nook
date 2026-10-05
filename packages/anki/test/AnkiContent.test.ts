import { assert, describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { AnkiCard, AnkiNote } from '../src/AnkiContent'

const decodeNote = Schema.decodeUnknownSync(AnkiNote)
const encodeNote = Schema.encodeSync(AnkiNote)
const decodeCard = Schema.decodeUnknownSync(AnkiCard)
const encodeCard = Schema.encodeSync(AnkiCard)

/** A row of `notes`, with Anki's column names and both joined columns as text. */
const NoteRow = Schema.Struct({
  id: Schema.Number,
  guid: Schema.String,
  mid: Schema.Number,
  mod: Schema.Number,
  flds: Schema.String,
  tags: Schema.String,
})

/** A row of `cards`, with every scheduling column, even the ones nook drops. */
const CardRow = Schema.Struct({
  id: Schema.Number,
  nid: Schema.Number,
  did: Schema.Number,
  odid: Schema.Number,
  ord: Schema.Number,
  queue: Schema.Number,
  flags: Schema.Number,
})

describe('AnkiNote', () => {
  it.prop('decodes any row into a Note that encodes back to the same Note', [NoteRow], ([row]) => {
    const note = decodeNote(row)
    assert.deepStrictEqual(decodeNote(encodeNote(note)), note)
  })

  it("reads a row of the notes table using Anki's column names", () => {
    const note = decodeNote({
      id: 1_706_642_722_424,
      guid: 'g1',
      mid: 1_700_000_000_001,
      mod: 1_707_681_587,
      flds: 'Cloze\x1fThe {{c1::word}} is {{c2::defined}}',
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
      flds: 'Front\x1f\x1fBack',
      tags: '',
    })
    expect(note.fields).toEqual(['Front', '', 'Back'])
    expect(note.tags).toEqual([])
  })

  it('rejects a row that is not a Note', () => {
    expect(() => decodeNote({ id: 1, guid: 'g', mid: 2, mod: 0, flds: 4, tags: '' })).toThrow()
  })

  it('encodes back to the row Anki would have written', () => {
    const row = { id: 1, guid: 'g', mid: 2, mod: 3, flds: 'a\x1fb', tags: ' t ' }
    expect(encodeNote(decodeNote(row))).toEqual(row)
  })
})

describe('AnkiCard', () => {
  it.prop('decodes any row into a Card that encodes back to the same Card', [CardRow], ([row]) => {
    const card = decodeCard(row)
    assert.deepStrictEqual(decodeCard(encodeCard(card)), card)
  })

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
  })

  it('sends a Card home when a filtered Deck moved it', () => {
    const card = decodeCard({ id: 10, nid: 1, did: 99, odid: 42, ord: 0, queue: 0, flags: 0 })
    expect(card.deckId).toBe(42)
  })

  it('reads a Card the Learner suspended, and not one that is only buried', () => {
    const suspended = decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -1, flags: 0 })
    expect(suspended.suspended).toBe(true)

    const buried = decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -2, flags: 0 })
    expect(buried.suspended).toBe(false)
  })

  it('keeps only the star colour out of cards.flags', () => {
    const card = decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: 0, flags: 0b1101 })
    expect(card.flag).toBe(0b101)
  })

  it('encodes a suspended Card with the queue Anki suspends to', () => {
    const card = decodeCard({ id: 1, nid: 2, did: 3, odid: 0, ord: 0, queue: -1, flags: 0 })
    expect(encodeCard(card)).toEqual({
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
