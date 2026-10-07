import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import * as Sql from 'effect/sql/SqlClient'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, ReviewsRpc, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = Layer.mergeAll(DecksHandlers, ReviewsHandlers).pipe(
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(SqlLive),
)

const showcaseDeck = DeckId.make('deck-showcase-japanese')

layer(TestLayers)('per-deck limits over sqlite', (it) => {
  it.effect('counts one Card once no matter how often it was graded', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc))

      const queue = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      const target = queue.cards.find((card) => card.state !== 'new')
      assert.isDefined(target)
      if (target === undefined) return

      // Grade the same Card twice (the second lands after undo, so both
      // rows stay in the log): the day's review use still counts one Card.
      yield* client.reviewsGrade({ id: 'limit-again-1', cardId: target.cardId, grade: 'Again' })
      yield* client.reviewsUndo({ cardId: target.cardId })
      yield* client.reviewsGrade({ id: 'limit-good-1', cardId: target.cardId, grade: 'Good' })

      const after = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      expect(after.reviewedToday).toBe(1)
      expect(after.totalDue).toBe(3)

      const detail = yield* client.decksGetById({ deckId: showcaseDeck })
      // The graded Card left the due pool, so what remains is all reviewable.
      expect(detail.summary.dueCount).toBe(3)
      expect(detail.summary.dueToday).toBe(3)
    }).pipe(Effect.scoped),
  )

  it.effect('caps the queue at the deck override and names the remainder', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc))

      const limited = yield* client.decksSetLimits({
        deckId: showcaseDeck,
        limits: { newPerDay: 1, reviewsPerDay: 1, lapseMinutes: null },
      })
      expect(limited.summary.limits).toEqual({
        newPerDay: 1,
        reviewsPerDay: 1,
        lapseMinutes: null,
      })

      const queue = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      // Four due wait, one is served; two new wait, one is served.
      expect(queue.cards.filter((card) => card.state !== 'new').length).toBe(1)
      expect(queue.cards.filter((card) => card.state === 'new').length).toBe(1)
      expect(queue.totalDue).toBe(4)
      expect(queue.totalNew).toBe(2)
      expect(queue.dueCapped).toBe(true)
      expect(queue.newCapped).toBe(true)

      const detail = yield* client.decksGetById({ deckId: showcaseDeck })
      expect(detail.summary.dueCount).toBe(4)
      expect(detail.summary.dueToday).toBe(1)
      expect(detail.summary.newCount).toBe(2)
      expect(detail.summary.newToday).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('follows Settings again when an override is cleared', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc))

      yield* client.decksSetLimits({
        deckId: showcaseDeck,
        limits: { newPerDay: 1, reviewsPerDay: 1, lapseMinutes: 5 },
      })
      const cleared = yield* client.decksSetLimits({
        deckId: showcaseDeck,
        limits: { newPerDay: null, reviewsPerDay: null, lapseMinutes: null },
      })
      expect(cleared.summary.limits).toEqual({
        newPerDay: null,
        reviewsPerDay: null,
        lapseMinutes: null,
      })

      const queue = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      expect(queue.lapseMinutes).toBe(10)
      expect(queue.dueCapped).toBe(false)
      expect(queue.newCapped).toBe(false)
    }).pipe(Effect.scoped),
  )

  it.effect('rejects bad limit values before they reach SQL', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc))

      const fractional = yield* Effect.exit(
        client.decksSetLimits({
          deckId: showcaseDeck,
          limits: { newPerDay: 1.5, reviewsPerDay: null, lapseMinutes: null },
        }),
      )
      assert.strictEqual(fractional._tag, 'Failure')

      const missing = yield* Effect.exit(
        client.decksSetLimits({
          deckId: DeckId.make('deck-nope'),
          limits: { newPerDay: 1, reviewsPerDay: 1, lapseMinutes: 1 },
        }),
      )
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )

  it.effect('grades an Again Card on the deck lapse instead of the global one', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc))
      const sql = yield* Sql.SqlClient

      yield* client.decksSetLimits({
        deckId: showcaseDeck,
        limits: { newPerDay: null, reviewsPerDay: null, lapseMinutes: 1 },
      })
      const queue = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      const target = queue.cards.find((card) => card.state !== 'new')
      assert.isDefined(target)
      if (target === undefined) return

      const before = Date.now()
      yield* client.reviewsGrade({ id: 'limit-lapse-1', cardId: target.cardId, grade: 'Again' })
      const rows =
        yield* sql`SELECT buried_until AS "buried" FROM cards WHERE id = ${target.cardId}`
      const buried = (rows as ReadonlyArray<{ buried: string }>)[0]?.buried
      assert.isDefined(buried)
      if (buried === undefined) return
      const waitMs = new Date(`${buried}Z`.replace('ZZ', 'Z')).getTime() - before
      // One deck minute, not ten global minutes (with wide clock tolerance).
      expect(waitMs).toBeGreaterThan(0)
      expect(waitMs).toBeLessThan(5 * 60_000)
    }).pipe(Effect.scoped),
  )
})
