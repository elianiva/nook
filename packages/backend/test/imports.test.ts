import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, HomeRpc, SettingsRpc, ImportsRpc, ReviewsRpc, DeckId, ImportId } from '@nook/api'
import type { ImportManifest, ImportNote, ImportReview } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Home, HomeHandlers } from '../src/home'
import { Imports, ImportsHandlers } from '../src/imports'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { Settings, SettingsHandlers } from '../src/settings'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const HandlersLive = Layer.mergeAll(
  DecksHandlers,
  HomeHandlers,
  ImportsHandlers,
  ReviewsHandlers,
  SettingsHandlers,
).pipe(
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Imports.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(SqlLive),
)

const TestLayers = HandlersLive

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

/** A Review of `cardId` on `day` of March 2024, noon-free: midnight UTC. */
const grade = (cardId: number, day: number, value: ImportReview['grade']): ImportReview => ({
  id: Date.UTC(2024, 2, day),
  cardId,
  grade: value,
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
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))

      const started = yield* client.importsStart({
        id: IMPORT_ID,
        filename: 'japanese.apkg',
        manifest: manifest(),
      })
      expect(started.status).toBe('running')
      expect(started.notesCursor).toBe(0)
      expect(started.noteCount).toBe(2)

      // The Deck and Note Type land with the manifest, before any Note needs them.
      const decksAfterStart = yield* client.decksList({})
      expect(decksAfterStart.find((deck) => deck.id === '7')?.name).toBe('Japanese::Core')

      const firstBatch = yield* client.importsWriteBatch({
        importId: IMPORT_ID,
        batch: {
          notes: [note(10, '水'), note(11, '火')],
          cards: [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
        },
      })
      expect(firstBatch.notesImported).toBe(2)
      expect(firstBatch.cardsImported).toBe(1)
      expect(firstBatch.notesCursor).toBe(11)
      expect(firstBatch.cardsCursor).toBe(20)

      const secondBatch = yield* client.importsWriteBatch({
        importId: IMPORT_ID,
        batch: {
          notes: [],
          cards: [{ id: 21, noteId: 11, deckId: 7, templateOrd: 0, suspended: true, flag: 2 }],
        },
      })
      expect(secondBatch.cardsImported).toBe(2)
      expect(secondBatch.cardsCursor).toBe(21)

      const finished = yield* client.importsComplete({ importId: IMPORT_ID })
      expect(finished.status).toBe('done')

      // The imported Deck shows through the screens that already read `cards`.
      const detail = yield* client.decksGetById({ deckId: DeckId.make('7') })
      expect(detail.summary.totalCount).toBe(2)
      expect(detail.summary.newCount).toBe(1)
      expect(detail.cards.length).toBe(2)
      expect(detail.cards.filter((card) => card.suspended)).toHaveLength(1)

      // Importing the same archive again lands on the same Import: it is done,
      // and its cursors say there is nothing left to write.
      const again = yield* client.importsStart({
        id: IMPORT_ID,
        filename: 'japanese.apkg',
        manifest: manifest(),
      })
      expect(again.status).toBe('done')
      expect(again.notesCursor).toBe(11)
      expect(again.cardsCursor).toBe(21)

      // Re-writing the same rows overrides them instead of duplicating.
      yield* client.importsWriteBatch({
        importId: IMPORT_ID,
        batch: { notes: [note(10, '水 (edited)')], cards: [] },
      })
      expect(yield* countRows('notes', `import_id = '${IMPORT_ID}'`)).toBe(2)
      expect(yield* countRows('note_types', `id = '100'`)).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('resumes an interrupted run from its cursors and records a failure', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const id = ImportId.make('b'.repeat(64))

      yield* client.importsStart({ id, filename: 'half.apkg', manifest: manifest() })
      yield* client.importsWriteBatch({
        importId: id,
        batch: { notes: [note(10, '水')], cards: [] },
      })
      yield* client.importsFail({ importId: id, error: 'The file moved.' })

      const failed = yield* client.importsGet({ importId: id })
      expect(failed.status).toBe('failed')
      expect(failed.notesCursor).toBe(10)
      expect(failed.notesImported).toBe(1)

      // Starting again resumes: the cursor survives, so the browser only sends
      // the Notes it has not sent yet.
      const resumed = yield* client.importsStart({
        id,
        filename: 'half.apkg',
        manifest: manifest(),
      })
      expect(resumed.status).toBe('running')
      expect(resumed.notesCursor).toBe(10)
      expect(resumed.error._tag).toBe('None')

      const done = yield* client.importsWriteBatch({
        importId: id,
        batch: { notes: [note(11, '火')], cards: [] },
      })
      expect(done.notesCursor).toBe(11)
      expect(done.notesImported).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.effect('counts each Import its own rows, not the whole table', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const first = ImportId.make('d'.repeat(64))
      const second = ImportId.make('e'.repeat(64))

      yield* client.importsStart({
        id: first,
        filename: 'first.apkg',
        manifest: manifest({ mediaCount: 3 }),
      })
      yield* client.importsWriteBatch({
        importId: first,
        batch: {
          notes: [note(10, '水'), note(11, '火')],
          cards: [
            { id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 },
            { id: 21, noteId: 11, deckId: 7, templateOrd: 0, suspended: false, flag: 0 },
          ],
        },
      })
      const done = yield* client.importsComplete({ importId: first })
      expect(done.notesImported).toBe(2)
      expect(done.cardsImported).toBe(2)
      expect(done.mediaCount).toBe(3)

      // A second archive lands in the same tables. Its progress counts its own
      // rows, and the first Import's counts do not move.
      yield* client.importsStart({ id: second, filename: 'second.apkg', manifest: manifest() })
      const secondStatus = yield* client.importsWriteBatch({
        importId: second,
        batch: {
          notes: [note(30, '山')],
          cards: [{ id: 40, noteId: 30, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
        },
      })
      expect(secondStatus.notesImported).toBe(1)
      expect(secondStatus.cardsImported).toBe(1)

      const firstAgain = yield* client.importsGet({ importId: first })
      expect(firstAgain.notesImported).toBe(2)
      expect(firstAgain.cardsImported).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.effect('reopens a run that finished without writing a row', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const id = ImportId.make('f'.repeat(64))

      // The Decks land with the manifest, so an empty run still names them.
      yield* client.importsStart({ id, filename: 'kaishi.apkg', manifest: manifest() })
      const empty = yield* client.importsComplete({ importId: id })
      expect(empty.status).toBe('done')
      expect(empty.notesImported).toBe(0)
      expect(empty.cardsImported).toBe(0)

      // Starting again reopens the run from the beginning instead of resuming
      // past every row, which would finish `done` empty a second time.
      const reopened = yield* client.importsStart({
        id,
        filename: 'kaishi.apkg',
        manifest: manifest(),
      })
      expect(reopened.status).toBe('running')
      expect(reopened.notesCursor).toBe(0)
      expect(reopened.cardsCursor).toBe(0)

      const written = yield* client.importsWriteBatch({
        importId: id,
        batch: {
          notes: [note(10, '水'), note(11, '火')],
          cards: [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
        },
      })
      expect(written.notesImported).toBe(2)
      expect(written.cardsImported).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('ignores review history unless the Import opted in', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const id = ImportId.make('1'.repeat(64))

      const started = yield* client.importsStart({
        id,
        filename: 'plain.apkg',
        manifest: { ...manifest(), reviewCount: 2 },
      })
      expect(started.includeHistory).toBe(false)
      expect(started.reviewCount).toBe(0)

      // A client that sends Reviews anyway cannot seed state the Learner declined.
      const written = yield* client.importsWriteBatch({
        importId: id,
        batch: {
          notes: [note(10, '水')],
          cards: [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
          reviews: [grade(20, 1, 'Good'), grade(20, 3, 'Good')],
        },
      })
      expect(written.reviewsCursor).toBe(0)
      expect(written.reviewsImported).toBe(0)
      expect(yield* countRows('reviews', `card_id = '20'`)).toBe(0)
      expect(yield* countRows('cards', `id = '20' AND state = 'new' AND reps = 0`)).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'seeds FSRS state and Review history for opted-in Cards, once however often it lands',
    () =>
      Effect.gen(function* () {
        yield* migrate
        const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
        const sql = yield* Effect.promise(() => import('effect/sql')).pipe(
          Effect.flatMap((module) => module.SqlClient.SqlClient),
        )
        const id = ImportId.make('2'.repeat(64))
        const cards = [20, 21, 22].map((cardId) => ({
          id: cardId,
          noteId: 10,
          deckId: 7,
          templateOrd: cardId - 20,
          suspended: false,
          flag: 0,
        }))

        const started = yield* client.importsStart({
          id,
          filename: 'history.apkg',
          manifest: { ...manifest(), cardCount: 3, reviewCount: 6 },
          includeHistory: true,
        })
        expect(started.includeHistory).toBe(true)
        expect(started.reviewCount).toBe(6)
        yield* client.importsWriteBatch({
          importId: id,
          batch: { notes: [note(10, '水')], cards },
        })

        // Card 22 was graded in nook before the history arrives: it keeps that.
        yield* sql.unsafe(
          `INSERT INTO reviews (id, card_id, grade, reviewed_at) VALUES ('native-1', '22', 'Good', '2024-02-01T00:00:00Z')`,
        )

        const batch = {
          notes: [],
          cards: [],
          reviews: [
            // Card 20: Good, then Good three days on.
            grade(20, 1, 'Good'),
            grade(20, 4, 'Good'),
            // Card 21: Good, then a lapse.
            grade(21, 1, 'Good'),
            grade(21, 6, 'Again'),
            // Card 22 carries native progress; card 99 was never imported.
            grade(22, 1, 'Easy'),
            grade(99, 1, 'Good'),
          ],
        }
        const seeded = yield* client.importsWriteBatch({ importId: id, batch })
        expect(seeded.reviewsCursor).toBe(99)
        expect(seeded.reviewsImported).toBe(4)

        const card20 = (yield* sql.unsafe<Record<string, number | string>>(
          `SELECT state, stability, difficulty, reps, lapses, review_lapses AS rl, due_at, last_reviewed_at AS last, introduced_day AS day, due_in_days AS days FROM cards WHERE id = '20'`,
        ))[0]
        expect(card20?.['state']).toBe('review')
        expect(Number(card20?.['stability'])).toBeCloseTo(13.8, 0)
        expect(card20?.['reps']).toBe(2)
        expect(card20?.['last']).toBe('2024-03-04T00:00:00Z')
        expect(card20?.['day']).toBe('2024-03-01')
        expect(card20?.['days']).toBe(14)
        expect(card20?.['due_at']).toBe('2024-03-18T00:00:00Z')

        const card21 = (yield* sql.unsafe<Record<string, number | string>>(
          `SELECT state, reps, lapses, review_lapses AS rl, due_in_days AS days FROM cards WHERE id = '21'`,
        ))[0]
        expect(card21).toMatchObject({ state: 'relearning', reps: 2, lapses: 1, rl: 1, days: 0 })

        // Each replayed Review carries its after-state, tied to the Import.
        const rows = yield* sql.unsafe<Record<string, number | string | null>>(
          `SELECT id, grade, reviewed_at, state_after, stability_after, due_at_after, import_id
         FROM reviews WHERE card_id = '20' ORDER BY reviewed_at`,
        )
        expect(rows.map((row) => row['id'])).toEqual([
          `anki-20-${Date.UTC(2024, 2, 1)}`,
          `anki-20-${Date.UTC(2024, 2, 4)}`,
        ])
        expect(rows[0]).toMatchObject({
          grade: 'Good',
          state_after: 'review',
          import_id: id,
          due_at_after: '2024-03-03T00:00:00Z',
        })
        expect(Number(rows[0]?.['stability_after'])).toBeCloseTo(2.3065, 4)

        // The native Card and the unknown Card are untouched.
        expect(yield* countRows('reviews', `card_id = '22'`)).toBe(1)
        expect(yield* countRows('cards', `id = '22' AND state = 'new'`)).toBe(1)
        expect(yield* countRows('reviews', `card_id = '99'`)).toBe(0)

        // A retry of the same batch lands on the same rows.
        yield* client.importsWriteBatch({ importId: id, batch })
        expect(yield* countRows('reviews', `import_id = '${id}'`)).toBe(4)
        expect(
          (yield* sql.unsafe<{ reps: number }>(`SELECT reps FROM cards WHERE id = '20'`))[0]?.reps,
        ).toBe(2)
      }).pipe(Effect.scoped),
  )

  it.effect('adds history to an Import that already finished, and keeps the choice on resume', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const id = ImportId.make('3'.repeat(64))
      const cards = [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }]

      yield* client.importsStart({ id, filename: 'later.apkg', manifest: manifest() })
      yield* client.importsWriteBatch({ importId: id, batch: { notes: [note(10, '水')], cards } })
      const done = yield* client.importsComplete({ importId: id })
      expect(done.status).toBe('done')
      expect(done.includeHistory).toBe(false)

      // Same archive, opting in this time: Notes and Cards are kept, history is left to write.
      const reopened = yield* client.importsStart({
        id,
        filename: 'later.apkg',
        manifest: { ...manifest(), reviewCount: 2 },
        includeHistory: true,
      })
      expect(reopened.status).toBe('running')
      expect(reopened.includeHistory).toBe(true)
      expect(reopened.reviewCount).toBe(2)
      expect(reopened.notesCursor).toBe(10)
      expect(reopened.cardsCursor).toBe(20)
      expect(reopened.reviewsCursor).toBe(0)

      yield* client.importsWriteBatch({
        importId: id,
        batch: { notes: [], cards: [], reviews: [grade(20, 1, 'Good')] },
      })
      yield* client.importsFail({ importId: id, error: 'The connection dropped.' })

      // A resumed run asks without the flag, as a reload would; the Import still holds it.
      const resumed = yield* client.importsStart({
        id,
        filename: 'later.apkg',
        manifest: { ...manifest(), reviewCount: 2 },
      })
      expect(resumed.includeHistory).toBe(true)
      expect(resumed.reviewCount).toBe(2)
      expect(resumed.reviewsCursor).toBe(20)
      expect(resumed.reviewsImported).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect("keeps resolving a re-imported Note's Media from the Import that stored it", () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(
        DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc, ReviewsRpc),
      )
      const withMedia = ImportId.make('d'.repeat(64))
      const withoutMedia = ImportId.make('e'.repeat(64))
      const withMoreMedia = ImportId.make('f'.repeat(64))
      const batch = {
        notes: [{ ...note(10, '<img src="a.png">') }],
        cards: [{ id: 20, noteId: 10, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
      }
      const question = () =>
        client
          .reviewsQueue({ deckId: DeckId.make('7'), timezone: 'UTC' })
          .pipe(Effect.map((queue) => queue.cards.find((card) => card.noteId === '10')?.question))

      yield* client.importsStart({
        id: withMedia,
        filename: 'one.apkg',
        manifest: manifest({ mediaCount: 1 }),
      })
      yield* client.importsWriteBatch({ importId: withMedia, batch })
      expect(yield* question()).toContain(`/api/media/${withMedia}/a.png`)

      // A later archive re-imports the Note with its Media excluded: the files
      // exist only under the first Import, so the Note must keep pointing there.
      yield* client.importsStart({
        id: withoutMedia,
        filename: 'two.apkg',
        manifest: manifest({ mediaCount: 0 }),
      })
      yield* client.importsWriteBatch({ importId: withoutMedia, batch })
      expect(yield* question()).toContain(`/api/media/${withMedia}/a.png`)

      // The Import still owns the Note's row, so its progress is unaffected.
      expect(yield* countRows('notes', `import_id = '${withoutMedia}'`)).toBe(1)

      // A re-import that does upload Media takes over its Media scope.
      yield* client.importsStart({
        id: withMoreMedia,
        filename: 'three.apkg',
        manifest: manifest({ mediaCount: 1 }),
      })
      yield* client.importsWriteBatch({ importId: withMoreMedia, batch })
      expect(yield* question()).toContain(`/api/media/${withMoreMedia}/a.png`)
    }).pipe(Effect.scoped),
  )

  it.effect('answers 404 for an Import it does not know', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc, ImportsRpc))
      const exit = yield* Effect.exit(
        client.importsGet({ importId: ImportId.make('c'.repeat(64)) }),
      )
      assert.strictEqual(exit._tag, 'Failure')
    }).pipe(Effect.scoped),
  )
})
