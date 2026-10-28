/**
 * Two users, one database.
 *
 * Ids are not unique across users: both import the same archive, so every Deck,
 * Note, Card, and Import id exists twice. Each test makes sure what one user
 * does never shows up in, changes, or deletes the other's collection.
 */

import { expect, layer } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { CardId, DeckId, ImportId } from '@nook/api'
import type { ImportManifest } from '@nook/api'
import { Decks } from '../src/decks'
import { Home } from '../src/home'
import { Imports } from '../src/imports'
import { Restore } from '../src/restore'
import { Reviews } from '../src/reviews'
import { Settings } from '../src/settings'
import {
  adoptLegacyCollection,
  CurrentUser,
  deleteAccount,
  LEGACY_OWNER,
  listAccounts,
  provisionUser,
  setAccountStatus,
} from '../src/users'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const Services = Layer.mergeAll(
  Decks.layer,
  Home.layer,
  Imports.layer,
  Restore.layer,
  Reviews.layer,
  Settings.layer,
)

/** Runs `effect` as `userId`: every service is built for that user alone. */
const asUser = <A, E>(
  userId: string,
  effect: Effect.Effect<
    A,
    E,
    Decks | Home | Imports | Restore | Reviews | Settings | Sql.SqlClient
  >,
) => effect.pipe(Effect.provide(Services.pipe(Layer.provide(CurrentUser.layer(userId)))))

const IMPORT_ID = ImportId.make('c'.repeat(64))

const manifest: ImportManifest = {
  schemaVersion: 18,
  decks: [{ id: 7, name: 'Japanese', description: '' }],
  noteTypes: [
    {
      id: 100,
      name: 'Basic',
      kind: 'normal',
      sortFieldOrd: 0,
      css: '',
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
      ],
      templates: [
        {
          ord: 0,
          name: 'Card 1',
          questionFormat: '{{Front}}',
          answerFormat: '{{Front}}',
          deckId: 0,
        },
      ],
    },
  ],
  noteCount: 1,
  cardCount: 1,
  mediaCount: 0,
}

/** The same archive, every time: its ids are what two users share. */
const importArchive = Effect.gen(function* () {
  const imports = yield* Imports
  yield* imports.start({ id: IMPORT_ID, filename: 'a.apkg', manifest })
  yield* imports.writeBatch(IMPORT_ID, {
    notes: [{ id: 1, guid: 'g1', noteTypeId: 100, modified: 1, fields: ['犬'], tags: [] }],
    cards: [{ id: 11, noteId: 1, deckId: 7, templateOrd: 0, suspended: false, flag: 0 }],
  })
  yield* imports.complete(IMPORT_ID)
})

const DECK = DeckId.make('7')
const CARD = CardId.make('11')

const setUp = Effect.gen(function* () {
  yield* migrate
  yield* asUser('alice', provisionUser('alice'))
  yield* asUser('bob', provisionUser('bob'))
})

const count = (table: string, userId: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    const rows = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`,
      [userId],
    )
    return rows[0]?.n ?? 0
  })

layer(SqlLive)('two users sharing one database', (it) => {
  it.effect('starts every user with an empty collection', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)
      expect(
        yield* asUser(
          'alice',
          Effect.flatMap(Decks, (decks) => decks.list()),
        ),
      ).toHaveLength(1)
      expect(
        yield* asUser(
          'bob',
          Effect.flatMap(Decks, (decks) => decks.list()),
        ),
      ).toHaveLength(0)
    }),
  )

  it.effect('keeps one import per user when both import the same archive', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)
      yield* asUser('bob', importArchive)

      for (const table of ['imports', 'decks', 'note_types', 'notes', 'cards']) {
        expect(yield* count(table, 'alice')).toBe(1)
        expect(yield* count(table, 'bob')).toBe(1)
      }
    }),
  )

  it.effect('does not show or change another user\u2019s Deck, even with the same id', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)

      // Bob has no Deck 7 yet: Alice's does not answer to his request.
      const missing = yield* asUser(
        'bob',
        Effect.flatMap(Decks, (decks) => decks.getById(DECK)),
      ).pipe(Effect.flip)
      expect(missing._tag).toBe('DeckNotFound')

      yield* asUser('bob', importArchive)
      yield* asUser(
        'alice',
        Effect.flatMap(Decks, (decks) =>
          decks.rename(DECK, { name: 'Alice renamed', description: '' }),
        ),
      )
      const bobsDeck = yield* asUser(
        'bob',
        Effect.flatMap(Decks, (decks) => decks.getById(DECK)),
      )
      expect(bobsDeck.summary.name).toBe('Japanese')
    }),
  )

  it.effect('grades, queues, and exports each user\u2019s Cards on their own', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)
      yield* asUser('bob', importArchive)

      yield* asUser(
        'alice',
        Effect.flatMap(Reviews, (reviews) =>
          reviews.grade({ id: 'alice-1', cardId: CARD, grade: 'Good' }),
        ),
      )

      const bobsQueue = yield* asUser(
        'bob',
        Effect.flatMap(Reviews, (reviews) =>
          reviews.queue({ deckId: Option.none(), timezone: 'UTC' }),
        ),
      )
      expect(bobsQueue.cards.map((card) => card.state)).toEqual(['new'])

      const bobsExport = yield* asUser(
        'bob',
        Effect.flatMap(Reviews, (reviews) => reviews.exportCollection()),
      )
      expect(bobsExport.reviews).toEqual([])
      const alicesExport = yield* asUser(
        'alice',
        Effect.flatMap(Reviews, (reviews) => reviews.exportCollection()),
      )
      expect(alicesExport.reviews.map((review) => review.id)).toEqual(['alice-1'])

      // A review id is per user too: Bob can use the same id Alice did.
      yield* asUser(
        'bob',
        Effect.flatMap(Reviews, (reviews) =>
          reviews.grade({ id: 'alice-1', cardId: CARD, grade: 'Again' }),
        ),
      )
      expect(yield* count('reviews', 'alice')).toBe(1)
      expect(yield* count('reviews', 'bob')).toBe(1)
    }),
  )

  it.effect('refuses a Card that belongs to someone else', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)

      const grade = yield* asUser(
        'bob',
        Effect.flatMap(Reviews, (reviews) =>
          reviews.grade({ id: 'b-1', cardId: CARD, grade: 'Good' }),
        ),
      ).pipe(Effect.flip)
      expect(grade._tag).toBe('CardNotFound')

      const suspend = yield* asUser(
        'bob',
        Effect.flatMap(Decks, (decks) => decks.setSuspended(CARD, true)),
      ).pipe(Effect.flip)
      expect(suspend._tag).toBe('CardNotFound')

      const sql = yield* Sql.SqlClient
      expect(yield* sql.unsafe(`SELECT suspended FROM cards WHERE user_id = 'alice'`)).toEqual([
        { suspended: 0 },
      ])
      expect(yield* count('reviews', 'alice')).toBe(0)
    }),
  )

  it.effect('removes only the caller\u2019s Deck, Notes, and Cards', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)
      yield* asUser('bob', importArchive)

      yield* asUser(
        'alice',
        Effect.flatMap(Decks, (decks) => decks.remove(DECK)),
      )

      for (const table of ['decks', 'notes', 'cards', 'note_types']) {
        expect(yield* count(table, 'alice')).toBe(table === 'note_types' ? 1 : 0)
        expect(yield* count(table, 'bob')).toBe(1)
      }
    }),
  )

  it.effect('restores an export from another user into the caller\u2019s collection only', () =>
    Effect.gen(function* () {
      yield* setUp
      yield* asUser('alice', importArchive)
      yield* asUser(
        'alice',
        Effect.flatMap(Reviews, (reviews) =>
          reviews.grade({ id: 'alice-1', cardId: CARD, grade: 'Good' }),
        ),
      )
      const alicesExport = yield* asUser(
        'alice',
        Effect.flatMap(Reviews, (reviews) => reviews.exportCollection()),
      )

      yield* asUser(
        'bob',
        Effect.flatMap(Restore, (restore) =>
          restore.restore({ json: JSON.stringify(alicesExport), dryRun: false }),
        ),
      )

      for (const table of ['decks', 'notes', 'cards', 'reviews']) {
        expect(yield* count(table, 'alice')).toBe(1)
        expect(yield* count(table, 'bob')).toBe(1)
      }
      const bobsDecks = yield* asUser(
        'bob',
        Effect.flatMap(Decks, (decks) => decks.list()),
      )
      expect(bobsDecks.map((deck) => deck.name)).toEqual(['Japanese'])
    }),
  )

  it.effect('keeps settings per user', () =>
    Effect.gen(function* () {
      yield* setUp
      const settings = Effect.flatMap(Settings, (service) => service.read)
      const before = yield* asUser('bob', settings)

      yield* asUser(
        'alice',
        Effect.flatMap(Settings, (service) =>
          service.save({
            ...before,
            fsrs: { ...before.fsrs, newPerDay: before.fsrs.newPerDay + 5 },
          }),
        ),
      )

      expect((yield* asUser('alice', settings)).fsrs.newPerDay).toBe(before.fsrs.newPerDay + 5)
      expect(yield* asUser('bob', settings)).toEqual(before)
    }),
  )

  it.effect('hands the pre-users collection to one user and nobody else', () =>
    Effect.gen(function* () {
      yield* setUp
      const sql = yield* Sql.SqlClient
      const list = Effect.flatMap(Decks, (decks) => decks.list())

      // The showcase deck belongs to the legacy owner: nobody sees it yet.
      expect(yield* count('decks', LEGACY_OWNER)).toBe(1)
      expect(yield* asUser('alice', list)).toHaveLength(0)

      // A collection with an import: each row references two parents, so no
      // order of updates keeps every reference whole at each step.
      yield* asUser(LEGACY_OWNER, importArchive)
      yield* asUser(
        LEGACY_OWNER,
        Effect.flatMap(Reviews, (reviews) =>
          reviews.grade({ id: 'legacy-1', cardId: CARD, grade: 'Good' }),
        ),
      )

      yield* adoptLegacyCollection('alice')

      expect(yield* asUser('alice', list)).toHaveLength(2)
      expect(yield* asUser('bob', list)).toHaveLength(0)
      expect(yield* count('reviews', 'alice')).toBeGreaterThan(4)
      for (const table of ['decks', 'cards', 'reviews', 'notes', 'note_types', 'imports']) {
        expect(yield* count(table, LEGACY_OWNER)).toBe(0)
      }
      // The collection arrived with its own settings and every reference intact.
      expect(yield* count('settings', 'alice')).toBe(1)
      expect(yield* count('settings', LEGACY_OWNER)).toBe(0)
      expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([])

      // Adopting twice changes nothing.
      yield* adoptLegacyCollection('alice')
      expect(yield* asUser('alice', list)).toHaveLength(2)
    }),
  )

  it.effect('lists accounts, approves one, and deletes only that account\u2019s data', () =>
    Effect.gen(function* () {
      yield* setUp
      const sql = yield* Sql.SqlClient
      const now = new Date().toISOString()
      for (const [id, role, status] of [
        ['alice', 'user', 'pending'],
        ['bob', 'user', 'approved'],
        ['root', 'admin', 'approved'],
      ] as const) {
        yield* sql`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt",
          "updatedAt", "role", "status")
          VALUES (${id}, ${id}, ${id + '@example.com'}, 1, ${now}, ${now}, ${role}, ${status})`
      }
      yield* asUser('alice', importArchive)
      yield* asUser('bob', importArchive)

      // Pending accounts come first.
      expect((yield* listAccounts).map((account) => account.id)[0]).toBe('alice')
      yield* setAccountStatus('alice', 'approved')
      // The admin's status is not changeable.
      yield* setAccountStatus('root', 'rejected')
      const byId = Object.fromEntries((yield* listAccounts).map((a) => [a.id, a.status]))
      expect(byId).toEqual({ alice: 'approved', bob: 'approved', root: 'approved' })

      yield* deleteAccount('alice')
      for (const table of ['imports', 'decks', 'note_types', 'notes', 'cards', 'settings']) {
        expect(yield* count(table, 'alice')).toBe(0)
        expect(yield* count(table, 'bob')).toBe(1)
      }
      expect((yield* listAccounts).map((account) => account.id).sort()).toEqual(['bob', 'root'])
      expect(yield* sql.unsafe('PRAGMA foreign_key_check')).toEqual([])

      // The admin account cannot be deleted this way.
      yield* deleteAccount('root')
      expect((yield* listAccounts).map((account) => account.id)).toContain('root')
    }),
  )
})
