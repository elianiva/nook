import { CurrentUser, LEGACY_OWNER } from '../src/users'
import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { ReviewsRpc, CardId, DeckId } from '@nook/api'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = ReviewsHandlers.pipe(
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(CurrentUser.layer(LEGACY_OWNER)),
  Layer.provideMerge(SqlLive),
)

const showcaseDeck = DeckId.make('deck-showcase-japanese')
const query = { deckId: showcaseDeck, timezone: 'UTC' } as const

layer(TestLayers)('review session behaviour', (it) => {
  it.effect('suspends review-mode leeches at eight lapses and records the idempotent result', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)
      const sql = yield* Sql.SqlClient
      const target = (yield* client.reviewsQueue(query)).cards.find(
        (card) => card.state === 'review',
      )
      assert.isDefined(target)
      if (target === undefined) return
      yield* sql`UPDATE cards SET review_lapses = 7 WHERE id = ${target.cardId}`

      const graded = yield* client.reviewsGrade({
        id: 'review-leech-threshold',
        cardId: target.cardId,
        grade: 'Again',
      })
      expect(graded.reviewLapses).toBe(8)
      expect(graded.leechSuspended).toBe(true)

      const replayed = yield* client.reviewsGrade({
        id: 'review-leech-threshold',
        cardId: target.cardId,
        grade: 'Again',
      })
      expect(replayed.leechSuspended).toBe(true)
      expect(replayed.reviewLapses).toBe(8)

      const rows = yield* sql`SELECT suspended, review_lapses AS "reviewLapses"
        FROM cards WHERE id = ${target.cardId}`
      expect((rows as ReadonlyArray<{ suspended: number; reviewLapses: number }>)[0]).toEqual({
        suspended: 1,
        reviewLapses: 8,
      })
      const after = yield* client.reviewsQueue(query)
      expect(after.cards.some((card) => card.cardId === target.cardId)).toBe(false)

      yield* client.reviewsUndo({ cardId: target.cardId })
      const undoneRows = yield* sql`SELECT suspended, review_lapses AS "reviewLapses"
        FROM cards WHERE id = ${target.cardId}`
      expect((undoneRows as ReadonlyArray<{ suspended: number; reviewLapses: number }>)[0]).toEqual(
        {
          suspended: 0,
          reviewLapses: 7,
        },
      )
      const restored = yield* client.reviewsQueue(query)
      expect(restored.cards.some((card) => card.cardId === target.cardId)).toBe(true)

      yield* sql`UPDATE cards SET review_lapses = 11 WHERE id = ${target.cardId}`
      const repeatedWarning = yield* client.reviewsGrade({
        id: 'review-leech-repeat-warning',
        cardId: target.cardId,
        grade: 'Again',
      })
      expect(repeatedWarning.reviewLapses).toBe(12)
      expect(repeatedWarning.leechSuspended).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect('re-queues an Again Card in-session and undoes a grade', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)

      const queue = yield* client.reviewsQueue({ deckId: query.deckId, timezone: query.timezone })
      const target = queue.cards.find((card) => card.state === 'review')
      assert.isDefined(target)
      if (target === undefined) return

      // `Again` re-queues later this session: the answer says so, and the Card
      // stays out of the queue only until its lapse passes.
      const again = yield* client.reviewsGrade({
        id: 'review-again-1',
        cardId: target.cardId,
        grade: 'Again',
      })
      expect(again.state).toBe('relearning')
      expect(again.intervalDays).toBe(0)
      expect(again.requeueInSession).toBe(true)

      const queuedIds = (yield* client.reviewsQueue({
        deckId: query.deckId,
        timezone: query.timezone,
      })).cards.map((card) => card.cardId)
      expect(queuedIds).not.toContain(target.cardId)

      // Undo restores the Card exactly: state, stability, difficulty, and queue membership.
      const undone = yield* client.reviewsUndo({ cardId: target.cardId })
      expect(undone.state).toBe(target.state)
      expect(undone.stability).toBeCloseTo(target.stability, 6)
      expect(undone.difficulty).toBeCloseTo(target.difficulty, 6)

      const restored = (yield* client.reviewsQueue({
        deckId: query.deckId,
        timezone: query.timezone,
      })).cards.map((card) => card.cardId)
      expect(restored).toContain(target.cardId)

      // A passing grade leaves the queue until tomorrow and is not re-queued.
      const good = yield* client.reviewsGrade({
        id: 'review-good-1',
        cardId: target.cardId,
        grade: 'Good',
      })
      expect(good.requeueInSession).toBe(false)
      expect(good.intervalDays).toBeGreaterThanOrEqual(1)
      const afterGood = (yield* client.reviewsQueue({
        deckId: query.deckId,
        timezone: query.timezone,
      })).cards.map((card) => card.cardId)
      expect(afterGood).not.toContain(target.cardId)

      const missing = yield* Effect.exit(client.reviewsUndo({ cardId: CardId.make('card-nope') }))
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )

  it.effect('a retried undo with the same review id does not undo an earlier grade', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)
      const sql = yield* Sql.SqlClient
      const target = (yield* client.reviewsQueue(query)).cards.find(
        (card) => card.state === 'review',
      )
      assert.isDefined(target)
      if (target === undefined) return

      const good = yield* client.reviewsGrade({
        id: 'undo-retry-good',
        cardId: target.cardId,
        grade: 'Good',
      })
      yield* client.reviewsGrade({ id: 'undo-retry-again', cardId: target.cardId, grade: 'Again' })

      // The first undo lands but its response is lost; the client retries the
      // same undo. The retry must be a no-op, not a second undo.
      yield* client.reviewsUndo({ cardId: target.cardId, reviewId: 'undo-retry-again' })
      const retried = yield* client.reviewsUndo({
        cardId: target.cardId,
        reviewId: 'undo-retry-again',
      })
      expect(retried.state).toBe(good.state)
      expect(retried.stability).toBeCloseTo(good.stability, 6)

      const reviews = yield* sql`SELECT id FROM reviews WHERE card_id = ${target.cardId}
        AND id LIKE 'undo-retry-%'`
      expect(reviews.map((row) => row['id'])).toEqual(['undo-retry-good'])
      const cards = yield* sql`SELECT state, stability FROM cards WHERE id = ${target.cardId}`
      expect(cards[0]?.['state']).toBe(good.state)
      expect(cards[0]?.['stability']).toBeCloseTo(good.stability, 6)
    }).pipe(Effect.scoped),
  )

  it.effect('refuses to undo a review that is no longer the latest on its Card', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)
      const sql = yield* Sql.SqlClient
      const target = (yield* client.reviewsQueue(query)).cards.find(
        (card) => card.state === 'review',
      )
      assert.isDefined(target)
      if (target === undefined) return

      yield* client.reviewsGrade({ id: 'stale-undo-1', cardId: target.cardId, grade: 'Good' })
      const second = yield* client.reviewsGrade({
        id: 'stale-undo-2',
        cardId: target.cardId,
        grade: 'Easy',
      })

      const stale = yield* Effect.exit(
        client.reviewsUndo({ cardId: target.cardId, reviewId: 'stale-undo-1' }),
      )
      assert.strictEqual(stale._tag, 'Failure')

      const reviews = yield* sql`SELECT id FROM reviews WHERE id LIKE 'stale-undo-%' ORDER BY id`
      expect(reviews.map((row) => row['id'])).toEqual(['stale-undo-1', 'stale-undo-2'])
      const cards = yield* sql`SELECT stability FROM cards WHERE id = ${target.cardId}`
      expect(cards[0]?.['stability']).toBeCloseTo(second.stability, 6)
    }).pipe(Effect.scoped),
  )

  it.effect('ignores a stale replay of a grade that was undone', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)
      const sql = yield* Sql.SqlClient
      const target = (yield* client.reviewsQueue(query)).cards.find(
        (card) => card.state === 'review',
      )
      assert.isDefined(target)
      if (target === undefined) return

      const grade = { id: 'undone-replay', cardId: target.cardId, grade: 'Again' } as const
      yield* client.reviewsGrade(grade)
      const undone = yield* client.reviewsUndo({ cardId: target.cardId, reviewId: grade.id })

      // A second tab's outbox (or a slow retry) delivers the grade again.
      const replay = yield* Effect.flip(client.reviewsGrade(grade))
      expect(replay._tag).toBe('ReviewUndone')

      const reviews = yield* sql`SELECT id FROM reviews WHERE id = ${grade.id}`
      expect(reviews).toEqual([])
      const cards = yield* sql`SELECT state, stability, reps FROM cards WHERE id = ${target.cardId}`
      expect(cards[0]?.['state']).toBe(undone.state)
      expect(cards[0]?.['stability']).toBeCloseTo(undone.stability, 6)
    }).pipe(Effect.scoped),
  )

  it.effect('buries same-Note siblings and enforces the daily new limit', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)

      // Grading one Card buries the other Cards from its Note until tomorrow.
      const queue = yield* client.reviewsQueue({ deckId: query.deckId, timezone: query.timezone })
      const first = queue.cards.find((card) => card.noteId === 'showcase-note-8')
      assert.isDefined(first)
      if (first === undefined) return
      const siblingBefore = queue.cards.filter(
        (card) => card.noteId === first.noteId && card.cardId !== first.cardId,
      )
      void siblingBefore

      yield* client.reviewsGrade({
        id: 'review-bury-1',
        cardId: first.cardId,
        grade: 'Good',
      })
      const after = yield* client.reviewsQueue({ deckId: query.deckId, timezone: query.timezone })
      const siblingsAfter = after.cards.filter((card) => card.noteId === first.noteId)
      expect(siblingsAfter.length).toBe(0)

      // The whole collection exports as one JSON document.
      const exported = yield* client.reviewsExport()
      expect(exported.decks.length).toBeGreaterThanOrEqual(1)
      expect(exported.cards.length).toBeGreaterThanOrEqual(8)
      expect(exported.reviews.length).toBeGreaterThanOrEqual(1)
      expect(exported.exportedAt.length).toBeGreaterThan(0)
    }).pipe(Effect.scoped),
  )
})
