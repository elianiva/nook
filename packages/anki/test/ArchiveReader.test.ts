import { SqliteClient } from '@effect/sql-sqlite-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import {
  countCards,
  countNotes,
  readDecks,
  readNoteTypes,
  readSchemaVersion,
  streamCards,
  streamNotes,
} from '../src/ArchiveReader'
import type { CollectionSpec } from './Collection'
import { removeCollection, writeCollection } from './Collection'
import { concat, stringField, uint32Field } from './Protobuf'

/** Writes a collection file, opens it read-only, and runs `use` against it. */
const withCollection = <A, E>(
  spec: CollectionSpec,
  use: (sql: SqliteClient.SqliteClient) => Effect.Effect<A, E, Reactivity.Reactivity>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => writeCollection(spec)),
    (filename) =>
      SqliteClient.make({ filename, readonly: true, disableWAL: true }).pipe(
        Effect.flatMap((client) => use(client as SqliteClient.SqliteClient)),
        Effect.scoped,
        Effect.provide(Reactivity.layer),
      ),
    (filename) => Effect.sync(() => removeCollection(filename)),
  )

const basic: CollectionSpec = {
  decks: [{ id: 1, name: 'Japanese' }],
  noteTypes: [
    {
      id: 100,
      name: 'Basic',
      css: '.card {}',
      fields: [{ name: 'Front' }, { ord: 1, name: 'Back' }],
      templates: [
        { name: 'Card 1', config: concat(stringField(1, '{{Front}}'), stringField(2, '{{Back}}')) },
        { ord: 1, name: 'Card 2', config: concat(stringField(1, '{{Back}}'), uint32Field(5, 1)) },
      ],
    },
  ],
  notes: [{ id: 10, noteTypeId: 100, fields: ['水', 'water'], tags: ['noun'] }],
  cards: [{ id: 20, noteId: 10, deckId: 1 }],
}

describe('readSchemaVersion', () => {
  it.effect('reads col.ver', () =>
    withCollection(basic, (sql) =>
      Effect.map(readSchemaVersion(sql), (version) => assert.strictEqual(version, 18)),
    ),
  )

  it.effect('reads a schema Anki no longer writes', () =>
    withCollection({ ...basic, schemaVersion: 11 }, (sql) =>
      Effect.map(readSchemaVersion(sql), (version) => assert.strictEqual(version, 11)),
    ),
  )
})

describe('readDecks', () => {
  it.effect('reads a nested Deck as its components and its description', () =>
    withCollection(
      {
        ...basic,
        decks: [{ id: 7, name: 'Japanese\u001fVocab', description: 'from the textbook' }],
      },
      (sql) =>
        Effect.map(readDecks(sql), (decks) => {
          assert.deepStrictEqual(decks, [
            { id: 7, components: ['Japanese', 'Vocab'], description: 'from the textbook' },
          ])
        }),
    ),
  )

  it.effect('skips a filtered Deck, which is a saved search rather than a place', () =>
    withCollection(
      {
        ...basic,
        decks: [
          { id: 1, name: 'Japanese' },
          { id: 2, name: 'Japanese\u001fHard', filtered: true },
        ],
      },
      (sql) =>
        Effect.map(readDecks(sql), (decks) => {
          assert.deepStrictEqual(
            decks.map((deck) => deck.id),
            [1],
          )
        }),
    ),
  )
})

describe('readNoteTypes', () => {
  it.effect('joins a Note Type to its Fields and Templates', () =>
    withCollection(basic, (sql) =>
      Effect.map(readNoteTypes(sql), (noteTypes) => {
        assert.strictEqual(noteTypes.length, 1)
        const noteType = noteTypes[0]
        assert.strictEqual(noteType?.name, 'Basic')
        assert.strictEqual(noteType?.css, '.card {}')
        assert.deepStrictEqual(
          noteType?.fields.map((field) => field.name),
          ['Front', 'Back'],
        )
        assert.deepStrictEqual(
          noteType?.templates.map((template) => template.questionFormat),
          ['{{Front}}', '{{Back}}'],
        )
      }),
    ),
  )

  it.effect('reads a Template that sends its Cards to one Deck', () =>
    withCollection(basic, (sql) =>
      Effect.map(readNoteTypes(sql), (noteTypes) => {
        assert.strictEqual(noteTypes[0]?.templates[1]?.deckId, 1)
      }),
    ),
  )

  it.effect('reads a cloze Note Type', () =>
    withCollection({ ...basic, noteTypes: [{ id: 100, name: 'Cloze', kind: 1 }] }, (sql) =>
      Effect.map(readNoteTypes(sql), (noteTypes) => {
        assert.strictEqual(noteTypes[0]?.kind, 'cloze')
      }),
    ),
  )

  it.effect('reads Field settings out of their config blob', () =>
    withCollection(
      {
        ...basic,
        noteTypes: [
          {
            id: 100,
            name: 'Basic',
            fields: [
              { name: 'Reading', config: concat(uint32Field(2, 1), stringField(3, 'Noto')) },
            ],
          },
        ],
      },
      (sql) =>
        Effect.map(readNoteTypes(sql), (noteTypes) => {
          const field = noteTypes[0]?.fields[0]
          assert.strictEqual(field?.rightToLeft, true)
          assert.strictEqual(field?.fontName, 'Noto')
        }),
    ),
  )

  it.effect('gives a Note Type no Fields rather than failing when it has none', () =>
    withCollection({ ...basic, noteTypes: [{ id: 100, name: 'Empty' }] }, (sql) =>
      Effect.map(readNoteTypes(sql), (noteTypes) => {
        assert.deepStrictEqual(noteTypes[0]?.fields, [])
        assert.deepStrictEqual(noteTypes[0]?.templates, [])
      }),
    ),
  )
})

describe('countNotes and countCards', () => {
  it.effect('count a collection without reading it', () =>
    withCollection(basic, (sql) =>
      Effect.all([countNotes(sql), countCards(sql)], { concurrency: 'unbounded' }).pipe(
        Effect.map(([notes, cards]) => {
          assert.strictEqual(notes, 1)
          assert.strictEqual(cards, 1)
        }),
      ),
    ),
  )
})

describe('streamNotes', () => {
  it.effect('streams every Note with its Fields and Tags split', () =>
    withCollection(basic, (sql) =>
      Stream.runCollect(streamNotes(sql)).pipe(
        Effect.map((notes) => {
          assert.strictEqual(notes.length, 1)
          assert.deepStrictEqual(notes[0]?.fields, ['水', 'water'])
          assert.deepStrictEqual(notes[0]?.tags, ['noun'])
        }),
      ),
    ),
  )

  it.effect('streams Notes in Anki id order', () =>
    withCollection(
      {
        ...basic,
        notes: [3, 1, 2].map((id) => ({ id, noteTypeId: 100, fields: [`n${id}`] })),
      },
      (sql) =>
        Stream.runCollect(streamNotes(sql)).pipe(
          Effect.map((notes) => {
            assert.deepStrictEqual(
              notes.map((note) => note.id),
              [1, 2, 3],
            )
          }),
        ),
    ),
  )

  it.effect('streams nothing from an archive with no Notes', () =>
    withCollection({ ...basic, notes: [], cards: [] }, (sql) =>
      Stream.runCollect(streamNotes(sql)).pipe(
        Effect.map((notes) => assert.strictEqual(notes.length, 0)),
      ),
    ),
  )
})

describe('streamCards', () => {
  it.effect('streams a Card with its scheduling discarded', () =>
    withCollection(basic, (sql) =>
      Stream.runCollect(streamCards(sql)).pipe(
        Effect.map((cards) => {
          assert.deepStrictEqual(cards, [
            { id: 20, noteId: 10, deckId: 1, templateOrd: 0, suspended: false, flag: 0 },
          ])
        }),
      ),
    ),
  )

  it.effect('sends a Card home when a filtered Deck moved it', () =>
    withCollection(
      {
        ...basic,
        decks: [...basic.decks!, { id: 2, name: 'Hard', filtered: true }],
        cards: [{ id: 20, noteId: 10, deckId: 2, originDeckId: 1 }],
      },
      (sql) =>
        Stream.runCollect(streamCards(sql)).pipe(
          Effect.map((cards) => {
            assert.strictEqual(cards[0]?.deckId, 1)
          }),
        ),
    ),
  )

  it.effect('reads a Card the Learner suspended and starred', () =>
    withCollection(
      { ...basic, cards: [{ id: 20, noteId: 10, deckId: 1, suspended: true, flag: 3 }] },
      (sql) =>
        Stream.runCollect(streamCards(sql)).pipe(
          Effect.map((cards) => {
            assert.strictEqual(cards[0]?.suspended, true)
            assert.strictEqual(cards[0]?.flag, 3)
          }),
        ),
    ),
  )
})
