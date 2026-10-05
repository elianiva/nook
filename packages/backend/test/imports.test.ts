import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { HttpApiTest } from 'effect/http-api'
import { HttpServer } from 'effect/http'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Api, DeckId, ImportId } from '@nook/api'
import type { ImportManifest, ImportNote } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Home, HomeHandlers } from '../src/home'
import { Imports, ImportsHandlers } from '../src/imports'
import { Settings, SettingsHandlers } from '../src/settings'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const HandlersLive = Layer.mergeAll(
  DecksHandlers,
  HomeHandlers,
  ImportsHandlers,
  SettingsHandlers,
).pipe(
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(SqlLive),
)

const TestLayers = Layer.mergeAll(HandlersLive, HttpServer.layerServices)

const makeClient = HttpApiTest.groups(Api, ['decks', 'home', 'settings', 'imports'])

const IMPORT_ID = ImportId.make('a'.repeat(64))

const manifest = (overrides: Partial<ImportManifest> = {}): ImportManifest => ({
  schemaVersion: 18,
  decks: [{ id: 7, name: 'Japanese::Core', description: 'Imported from Anki' }],
  noteTypes: [
    {
      id: 100,
      name: 'Basic',
      kind: 'normal',
      sortFieldOrd: 0,
      css: '.card { color: black; }',
      fields: [
        {
          ord: 0,
          name: 'Front',
          rightToLeft: false,
          fontName: null,
          fontSize: null,
          plainText: false,
          description: '',
          sticky: false,
        },
        {
          ord: 1,
          name: 'Back',
          rightToLeft: false,
          fontName: null,
          fontSize: null,
          plainText: false,
          description: '',
          sticky: false,
        },
      ],
      templates: [
        {
          ord: 0,
          name: 'Card 1',
          questionFormat: '{{Front}}',
          answerFormat: '{{Back}}',
          deckId: 0,
        },
      ],
    },
  ],
  noteCount: 2,
  cardCount: 2,
  mediaCount: 0,

  ...overrides,
})

const note = (id: number, front: string): ImportNote => ({
  id,
  guid: `guid-${id}`,
  noteTypeId: 100,
  modified: 1_700_000_000,
  fields: [front, 'water'],
  tags: ['noun'],
})

const countRows = (table: string, where = '1 = 1') =>
  Effect.gen(function* () {
    const { SqlClient } = yield* Effect.promise(() => import('effect/sql'))
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    )
    return rows[0]?.n ?? 0
  })

layer(TestLayers)('imports over sqlite', (it) => {
  it.effect('imports, resumes, and overrides on a second run of the same archive', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient

      const started = yield* client.imports.start({
        payload: { id: IMPORT_ID, filename: 'japanese.apkg', manifest: manifest() },
      })
      expect(started.status).toBe('running')
      expect(started.notesCursor).toBe(0)
      expect(started.noteCount).toBe(2)

      // The Deck and Note Type land with the manifest, before any Note needs them.
      const decksAfterStart = yield* client.decks.list()
      expect(decksAfterStart.find((deck) => deck.id === '7')?.name).toBe('Japanese::Core')

      const firstBatch = yield* client.imports.writeBatch({
        params: { importId: IMPORT_ID },
        payload: {
          notes: [note(10, '水'), note(11, '火')],
          cards: [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
        },
      })
      expect(firstBatch.notesImported).toBe(2)
      expect(firstBatch.cardsImported).toBe(1)
      expect(firstBatch.notesCursor).toBe(11)
      expect(firstBatch.cardsCursor).toBe(20)

      const secondBatch = yield* client.imports.writeBatch({
        params: { importId: IMPORT_ID },
        payload: {
          notes: [],
          cards: [{ id: 21, noteId: 11, deckId: 7, templateOrd: 0, suspended: true, flag: 2 }],
        },
      })
      expect(secondBatch.cardsImported).toBe(2)
      expect(secondBatch.cardsCursor).toBe(21)

      const finished = yield* client.imports.complete({ params: { importId: IMPORT_ID } })
      expect(finished.status).toBe('done')

      // The imported Deck shows through the screens that already read `cards`.
      const detail = yield* client.decks.getById({
        params: { deckId: DeckId.make('7') },
      })
      expect(detail.summary.totalCount).toBe(2)
      expect(detail.summary.newCount).toBe(2)
      expect(detail.cards.length).toBe(2)

      // Importing the same archive again lands on the same Import: it is done,
      // and its cursors say there is nothing left to write.
      const again = yield* client.imports.start({
        payload: { id: IMPORT_ID, filename: 'japanese.apkg', manifest: manifest() },
      })
      expect(again.status).toBe('done')
      expect(again.notesCursor).toBe(11)
      expect(again.cardsCursor).toBe(21)

      // Re-writing the same rows overrides them instead of duplicating.
      yield* client.imports.writeBatch({
        params: { importId: IMPORT_ID },
        payload: { notes: [note(10, '水 (edited)')], cards: [] },
      })
      expect(yield* countRows('notes', `import_id = '${IMPORT_ID}'`)).toBe(2)
      expect(yield* countRows('note_types', `id = '100'`)).toBe(1)
    }),
  )

  it.effect('resumes an interrupted run from its cursors and records a failure', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient
      const id = ImportId.make('b'.repeat(64))

      yield* client.imports.start({
        payload: { id, filename: 'half.apkg', manifest: manifest() },
      })
      yield* client.imports.writeBatch({
        params: { importId: id },
        payload: { notes: [note(10, '水')], cards: [] },
      })
      yield* client.imports.fail({
        params: { importId: id },
        payload: { error: 'The file moved.' },
      })

      const failed = yield* client.imports.get({ params: { importId: id } })
      expect(failed.status).toBe('failed')
      expect(failed.notesCursor).toBe(10)
      expect(failed.notesImported).toBe(1)

      // Starting again resumes: the cursor survives, so the browser only sends
      // the Notes it has not sent yet.
      const resumed = yield* client.imports.start({
        payload: { id, filename: 'half.apkg', manifest: manifest() },
      })
      expect(resumed.status).toBe('running')
      expect(resumed.notesCursor).toBe(10)
      expect(resumed.error._tag).toBe('None')

      const done = yield* client.imports.writeBatch({
        params: { importId: id },
        payload: { notes: [note(11, '火')], cards: [] },
      })
      expect(done.notesCursor).toBe(11)
      expect(done.notesImported).toBe(2)
    }),
  )

  it.effect('counts each Import its own rows, not the whole table', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient
      const first = ImportId.make('d'.repeat(64))
      const second = ImportId.make('e'.repeat(64))

      yield* client.imports.start({
        payload: { id: first, filename: 'first.apkg', manifest: manifest({ mediaCount: 3 }) },
      })
      yield* client.imports.writeBatch({
        params: { importId: first },
        payload: {
          notes: [note(10, '水'), note(11, '火')],
          cards: [
            { id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 },
            { id: 21, noteId: 11, deckId: 7, templateOrd: 0, suspended: false, flag: 0 },
          ],
        },
      })
      const done = yield* client.imports.complete({ params: { importId: first } })
      expect(done.notesImported).toBe(2)
      expect(done.cardsImported).toBe(2)
      expect(done.mediaCount).toBe(3)

      // A second archive lands in the same tables. Its progress counts its own
      // rows, and the first Import's counts do not move.
      yield* client.imports.start({
        payload: { id: second, filename: 'second.apkg', manifest: manifest() },
      })
      const secondStatus = yield* client.imports.writeBatch({
        params: { importId: second },
        payload: {
          notes: [note(30, '山')],
          cards: [{ id: 40, noteId: 30, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
        },
      })
      expect(secondStatus.notesImported).toBe(1)
      expect(secondStatus.cardsImported).toBe(1)

      const firstAgain = yield* client.imports.get({ params: { importId: first } })
      expect(firstAgain.notesImported).toBe(2)
      expect(firstAgain.cardsImported).toBe(2)
    }),
  )

  it.effect('answers 404 for an Import it does not know', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient
      const exit = yield* Effect.exit(
        client.imports.get({ params: { importId: ImportId.make('c'.repeat(64)) } }),
      )
      assert.strictEqual(exit._tag, 'Failure')
    }),
  )
})
