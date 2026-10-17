import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import * as Sql from 'effect/sql/SqlClient'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { CardId, RestoreRejected, RestoreRpc, ReviewsRpc } from '@nook/api'
import type { CollectionExport } from '@nook/api'
import { Restore, RestoreHandlers } from '../src/restore'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = Layer.mergeAll(RestoreHandlers, ReviewsHandlers).pipe(
  Layer.provideMerge(Restore.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(SqlLive),
)

const Api = ReviewsRpc.merge(RestoreRpc)

const emptyCollection = Effect.gen(function* () {
  const sql = yield* Sql.SqlClient
  for (const table of [
    'review_snapshots',
    'reviews',
    'cards',
    'notes',
    'imports',
    'decks',
    'note_types',
  ]) {
    yield* sql.unsafe(`DELETE FROM ${table}`)
  }
})

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient
    const rows = yield* sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`)
    return (rows[0] as { n: number }).n
  })

const withoutTime = (collection: CollectionExport) => ({ ...collection, exportedAt: '' })

/** A graded showcase collection, exported. */
const gradedExport = Effect.gen(function* () {
  yield* migrate
  const client = yield* RpcTest.makeClient(Api)
  const queue = yield* client.reviewsQueue({ timezone: 'UTC' })
  const fresh = queue.cards.find((card) => card.state === 'new')
  assert.isDefined(fresh)
  if (fresh === undefined) return yield* Effect.die('no new card')
  yield* client.reviewsGrade({ id: 'r-1', cardId: fresh.cardId, grade: 'Good' })
  yield* client.reviewsGrade({ id: 'r-2', cardId: fresh.cardId, grade: 'Again' })
  const exported = yield* client.reviewsExport()
  return { client, exported, cardId: fresh.cardId, total: exported.reviews.length }
})

layer(TestLayers)('restore over sqlite', (it) => {
  it.effect('restores a wiped collection to exactly what was exported', () =>
    Effect.gen(function* () {
      const { client, exported, cardId } = yield* gradedExport
      expect(exported.version).toBe(2)
      expect(exported.noteTypes.length).toBeGreaterThan(0)
      expect(exported.reviews.some((review) => review.id === 'r-2')).toBe(true)

      yield* emptyCollection
      expect(yield* countRows('cards')).toBe(0)

      const result = yield* client.collectionRestore({
        json: JSON.stringify(exported),
        dryRun: false,
      })
      expect(result.added.cards).toBe(exported.cards.length)
      expect(result.added.reviews).toBe(exported.reviews.length)
      expect(result.added.noteTypes).toBe(exported.noteTypes.length)
      expect(result.existing.cards).toBe(0)

      const again = yield* client.reviewsExport()
      expect(withoutTime(again)).toEqual(withoutTime(exported))

      // Review history, including each Review's resulting Schedule, survives.
      const history = yield* client.reviewsHistory({ cardId: CardId.make(cardId) })
      expect(history.total).toBe(2)
      expect(history.events.map((event) => event.id)).toEqual(['r-2', 'r-1'])
      expect(history.events[1]?.after?.state).toBe('review')
      expect(history.events[0]?.before).toBeNull()
      expect(history.events[0]?.after?.state).toBe('relearning')

      // The restored collection can serve its queue.
      const queue = yield* client.reviewsQueue({ timezone: 'UTC' })
      expect(queue.cards.length).toBeGreaterThan(0)
    }),
  )

  it.effect('is idempotent: a second restore adds nothing', () =>
    Effect.gen(function* () {
      const { client, exported, total } = yield* gradedExport
      yield* emptyCollection
      const json = JSON.stringify(exported)
      yield* client.collectionRestore({ json, dryRun: false })
      const second = yield* client.collectionRestore({ json, dryRun: false })
      expect(second.added).toEqual({ decks: 0, noteTypes: 0, notes: 0, cards: 0, reviews: 0 })
      expect(second.schedulesUpdated).toBe(0)
      expect(second.existing.reviews).toBe(total)
      expect(yield* countRows('reviews')).toBe(total)
    }),
  )

  it.effect('dry run reports the merge without writing', () =>
    Effect.gen(function* () {
      const { client, exported } = yield* gradedExport
      yield* emptyCollection
      const preview = yield* client.collectionRestore({
        json: JSON.stringify(exported),
        dryRun: true,
      })
      expect(preview.dryRun).toBe(true)
      expect(preview.added.cards).toBe(exported.cards.length)
      expect(yield* countRows('cards')).toBe(0)
      expect(yield* countRows('reviews')).toBe(0)
    }),
  )

  it.effect('merges: the more recently reviewed Schedule wins, reviews union by id', () =>
    Effect.gen(function* () {
      const { client, exported, cardId, total } = yield* gradedExport
      const sql = yield* Sql.SqlClient
      const old = exported.cards.find((card) => card.id === cardId)
      assert.isDefined(old)

      // Live collection: this Card was graded once more after the backup.
      const later = '2999-01-01T00:00:00Z'
      yield* sql`UPDATE cards SET reps = 99, last_reviewed_at = ${later} WHERE id = ${cardId}`
      yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
        VALUES ('live-only', ${cardId}, 'Good', ${later})`
      const kept = yield* client.collectionRestore({
        json: JSON.stringify(exported),
        dryRun: false,
      })
      expect(kept.schedulesUpdated).toBe(0)
      expect(kept.added.reviews).toBe(0)
      const rows = yield* sql`SELECT reps FROM cards WHERE id = ${cardId}`
      expect((rows[0] as { reps: number }).reps).toBe(99)
      expect(yield* countRows('reviews')).toBe(total + 1)

      // Live collection: this Card is older than the backup, so the backup wins.
      yield* sql`UPDATE cards SET reps = 0, last_reviewed_at = '2000-01-01 00:00:00' WHERE id = ${cardId}`
      const replaced = yield* client.collectionRestore({
        json: JSON.stringify(exported),
        dryRun: false,
      })
      expect(replaced.schedulesUpdated).toBe(1)
      const after = yield* sql`SELECT reps, last_reviewed_at AS at FROM cards WHERE id = ${cardId}`
      expect(after[0]).toEqual({ reps: old?.reps, at: old?.lastReviewedAt })
      // The live-only Review is never removed.
      expect(yield* countRows('reviews')).toBe(total + 1)
    }),
  )

  it.effect('restores an unversioned v1 export into a collection that has the Note Types', () =>
    Effect.gen(function* () {
      const { client, exported, cardId } = yield* gradedExport
      yield* emptyCollection
      const sql = yield* Sql.SqlClient
      // v1 files carry no Note Types, so the collection must still hold them.
      yield* Effect.forEach(
        exported.noteTypes,
        (noteType) =>
          sql`INSERT INTO note_types (id, name, kind, sort_field_ord, css, fields, templates)
          VALUES (${noteType.id}, ${noteType.name}, ${noteType.kind}, ${noteType.sortFieldOrd},
            ${noteType.css}, ${JSON.stringify(noteType.fields)}, ${JSON.stringify(noteType.templates)})`,
      )
      const v1 = {
        exportedAt: exported.exportedAt,
        decks: exported.decks.map(({ id, name, description }) => ({ id, name, description })),
        notes: exported.notes,
        cards: exported.cards.map(({ dueInDays: _d, introducedDay: _i, ...card }) => card),
        reviews: exported.reviews.map(({ id, cardId, grade, reviewedAt }) => ({
          id,
          cardId,
          grade,
          reviewedAt,
        })),
      }
      const result = yield* client.collectionRestore({ json: JSON.stringify(v1), dryRun: false })
      expect(result.version).toBe(1)
      expect(result.added.cards).toBe(exported.cards.length)
      expect(result.added.noteTypes).toBe(0)
      const history = yield* client.reviewsHistory({ cardId: CardId.make(cardId) })
      expect(history.total).toBe(2)
      expect(history.events[0]?.after).toBeNull()
    }),
  )

  it.effect('rejects bad files with specific errors and writes nothing', () =>
    Effect.gen(function* () {
      const { client, exported } = yield* gradedExport
      yield* emptyCollection
      const reject = (value: unknown) =>
        client
          .collectionRestore({
            json: typeof value === 'string' ? value : JSON.stringify(value),
            dryRun: false,
          })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error instanceof RestoreRejected ? Effect.succeed(error) : Effect.die(error),
            ),
          )
      const [card] = exported.cards
      const [review] = exported.reviews
      assert.isDefined(card)
      assert.isDefined(review)
      if (card === undefined || review === undefined) return

      const notJson = yield* reject('not json')
      expect(notJson).toBeInstanceOf(RestoreRejected)
      expect(notJson.message).toContain('not valid JSON')

      const newer = yield* reject({ ...exported, version: 3 })
      expect(newer.message).toContain('version 3')

      const notBackup = yield* reject({ hello: 'world' })
      expect(notBackup.message).toContain('not a complete nook export')

      const refs = yield* reject({
        ...exported,
        cards: [{ ...card, deckId: 'ghost-deck' }, ...exported.cards.slice(1)],
        reviews: [...exported.reviews, { ...review, id: 'orphan', cardId: 'ghost-card' }],
      })
      expect(refs.issues.join('\n')).toContain('Deck "ghost-deck"')
      expect(refs.issues.join('\n')).toContain('Card "ghost-card"')

      const dupes = yield* reject({ ...exported, reviews: [...exported.reviews, review] })
      expect(dupes.issues[0]).toContain('share the id')

      const values = yield* reject({
        ...exported,
        cards: [{ ...card, stability: -1, dueAt: 'tomorrow-ish' }, ...exported.cards.slice(1)],
      })
      expect(values.issues.join('\n')).toContain('stability has an out-of-range value')
      expect(values.issues.join('\n')).toContain('unreadable time')

      expect(yield* countRows('cards')).toBe(0)
      expect(yield* countRows('decks')).toBe(0)
      expect(yield* countRows('reviews')).toBe(0)
    }),
  )
})
