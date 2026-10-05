import { SqliteClient } from '@effect/sql-sqlite-node'
import { assert, describe, it } from '@effect/vitest'
import { Arbitrary, Effect, Schema, Stream } from 'effect'
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
import { deckComponents } from '../src/DeckName'
import type { AnkiNoteType } from '../src/AnkiManifest'
import type { CollectionSpec, NoteTypeSpec } from './Collection'
import { removeCollection, writeCollection } from './Collection'
import { boolField, concat, stringField, uint32Field } from './Protobuf'
import { natural, nonEmptyText, optional, text, uint32 } from './Generators'

/**
 * The reader runs real SQL against a real SQLite file.
 *
 * SQLite decides whether a query is legal, so the only way to know the reader's
 * SQL is right is to run it. Each property below writes a collection from
 * generated data and reads it back, so the generated data is the oracle: it
 * holds every shape a collection can have, not the handful an example can.
 */
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

/** A Field Anki can store: no separator, so the joined column splits back. */
const field = text.pipe(Arbitrary.filter((value) => !value.includes('\x1f')))

/** A Tag Anki can store: non-empty, and free of both separators. */
const tag = nonEmptyText.pipe(Arbitrary.filter((value) => !/[ 　]/.test(value)))

/** A native Deck name with no empty component, which is the only kind that round-trips. */
const nativeName = text.pipe(
  Arbitrary.filter(
    (value) => !value.startsWith('\x1f') && !value.endsWith('\x1f') && !value.includes('\x1f\x1f'),
  ),
)

/** Notes, with ids assigned by position so the reader's id order is the array's order. */
const notes = Arbitrary.array(
  Arbitrary.all({
    guid: text,
    noteTypeId: natural,
    modified: natural,
    fields: Arbitrary.array(field, { minLength: 1, maxLength: 4 }),
    tags: Arbitrary.array(tag, { maxLength: 4 }),
  }),
  { maxLength: 6 },
).pipe(Arbitrary.map((values) => values.map((value, index) => ({ id: index + 1, ...value }))))

/** Cards, including the origin Deck a filtered Deck would have moved them from. */
const cards = Arbitrary.array(
  Arbitrary.all({
    templateOrd: uint32,
    suspended: Arbitrary.schema(Schema.Boolean),
    flag: uint32,
    originDeckId: natural,
  }),
  { maxLength: 6 },
).pipe(
  Arbitrary.map((values) =>
    values.map((value, index) => ({ id: index + 1, noteId: index + 1, deckId: 7, ...value })),
  ),
)

const decks = Arbitrary.array(
  Arbitrary.all({
    name: nativeName,
    description: text,
    filtered: Arbitrary.schema(Schema.Boolean),
  }),
  { maxLength: 5 },
).pipe(Arbitrary.map((values) => values.map((value, index) => ({ id: index + 1, ...value }))))

const fieldValue = Arbitrary.all({
  name: text,
  rightToLeft: Arbitrary.schema(Schema.Boolean),
  fontName: optional(text),
  fontSize: optional(uint32),
  description: text,
  plainText: Arbitrary.schema(Schema.Boolean),
})

const templateValue = Arbitrary.all({
  name: text,
  questionFormat: text,
  answerFormat: text,
  deckId: natural,
})

/**
 * Note Types with their ordinals assigned by position, plus the value the
 * reader must return. The two are built together because the expected side
 * turns the raw config bytes back into the settings they encode.
 */
const noteTypes = Arbitrary.array(
  Arbitrary.all({
    name: text,
    kind: Arbitrary.schema(Schema.Boolean),
    sortFieldIdx: uint32,
    css: text,
    fields: Arbitrary.array(fieldValue, { maxLength: 4 }),
    templates: Arbitrary.array(templateValue, { maxLength: 3 }),
  }),
  { maxLength: 3 },
).pipe(
  Arbitrary.map((values) => {
    const spec: Array<NoteTypeSpec> = []
    const expected: Array<AnkiNoteType> = []
    values.forEach((value, index) => {
      const id = index + 1
      spec.push({
        id,
        name: value.name,
        kind: value.kind ? 1 : 0,
        sortFieldIdx: value.sortFieldIdx,
        css: value.css,
        fields: value.fields.map((entry, ord) => ({
          name: entry.name,
          ord,
          config: concat(
            boolField(2, entry.rightToLeft),
            entry.fontName === null ? new Uint8Array(0) : stringField(3, entry.fontName),
            entry.fontSize === null ? new Uint8Array(0) : uint32Field(4, entry.fontSize),
            stringField(5, entry.description),
            boolField(6, entry.plainText),
          ),
        })),
        templates: value.templates.map((entry, ord) => ({
          name: entry.name,
          ord,
          config: concat(
            stringField(1, entry.questionFormat),
            stringField(2, entry.answerFormat),
            uint32Field(5, entry.deckId),
          ),
        })),
      })
      expected.push({
        id,
        name: value.name,
        kind: value.kind ? 'cloze' : 'normal',
        sortFieldOrd: value.sortFieldIdx,
        css: value.css,
        fields: value.fields.map((entry, ord) => ({
          ord,
          name: entry.name,
          rightToLeft: entry.rightToLeft,
          fontName: entry.fontName,
          fontSize: entry.fontSize,
          plainText: entry.plainText,
          description: entry.description,
          sticky: false,
        })),
        templates: value.templates.map((entry, ord) => ({
          ord,
          name: entry.name,
          questionFormat: entry.questionFormat,
          answerFormat: entry.answerFormat,
          deckId: entry.deckId,
        })),
      })
    })
    return { spec, expected }
  }),
)

describe('readSchemaVersion', () => {
  it.effect.prop('reads col.ver', [uint32], ([version]) =>
    withCollection({ schemaVersion: version }, (sql) =>
      Effect.map(readSchemaVersion(sql), (read) => assert.strictEqual(read, version)),
    ),
  )
})

describe('readDecks', () => {
  it.effect.prop('reads back every Deck it wrote, minus the filtered ones', [decks], ([spec]) =>
    withCollection({ decks: spec }, (sql) =>
      Effect.map(readDecks(sql), (read) =>
        assert.deepStrictEqual(
          [...read],
          spec
            .filter((deck) => !deck.filtered)
            .map((deck) => ({
              id: deck.id,
              components: deckComponents(deck.name),
              description: deck.description,
            })),
        ),
      ),
    ),
  )
})

describe('readNoteTypes', () => {
  it.effect.prop(
    'joins every Note Type to its Fields and Templates',
    [noteTypes],
    ([{ spec, expected }]) =>
      withCollection({ noteTypes: spec }, (sql) =>
        Effect.map(readNoteTypes(sql), (read) => assert.deepStrictEqual([...read], expected)),
      ),
  )
})

describe('streamNotes', () => {
  it.effect.prop('streams back every Note it wrote, in id order', [notes], ([spec]) =>
    withCollection({ notes: spec }, (sql) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* countNotes(sql), spec.length)
        assert.deepStrictEqual([...(yield* Stream.runCollect(streamNotes(sql)))], spec)
      }),
    ),
  )
})

describe('streamCards', () => {
  it.effect.prop(
    'streams back every Card it wrote, with a filtered Deck resolved away',
    [cards],
    ([spec]) =>
      withCollection({ cards: spec }, (sql) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* countCards(sql), spec.length)
          assert.deepStrictEqual(
            [...(yield* Stream.runCollect(streamCards(sql)))],
            spec.map((card) => ({
              id: card.id,
              noteId: card.noteId,
              deckId: card.originDeckId !== 0 ? card.originDeckId : card.deckId,
              templateOrd: card.templateOrd,
              suspended: card.suspended,
              flag: card.flag & 0b111,
            })),
          )
        }),
      ),
  )
})
