import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { ReviewsRpc, DeckId } from '@nook/api'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

/**
 * The node sqlite driver is synchronous, so two grades never interleave on
 * their own. Yielding after every read lets a second request read the Card
 * between the first request's read and write, as two tabs do on D1. Writes
 * do not yield: D1 runs a batch atomically.
 */
const InterleavingSql = Layer.effect(
  Sql.SqlClient,
  Effect.gen(function* () {
    const client = yield* Sql.SqlClient
    return new Proxy(client, {
      apply: (target, _this, args: ReadonlyArray<unknown>) => {
        const statement = Reflect.apply(target, undefined, [...args]) as Effect.Effect<unknown>
        const [strings] = args as [ReadonlyArray<string>]
        return strings[0]?.trimStart().startsWith('SELECT')
          ? Effect.tap(statement, () => Effect.yieldNow)
          : statement
      },
    })
  }),
).pipe(Layer.provide(SqliteClient.layer({ filename: ':memory:' })))

const TestLayers = ReviewsHandlers.pipe(
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(InterleavingSql),
)

const query = { deckId: DeckId.make('deck-showcase-japanese'), timezone: 'UTC' } as const

layer(TestLayers)('concurrent grades', (it) => {
  it.effect('orders grades that arrive at the same time on one Card', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)
      const sql = yield* Sql.SqlClient
      const target = (yield* client.reviewsQueue(query)).cards.find(
        (card) => card.state === 'review',
      )
      assert.isDefined(target)
      if (target === undefined) return
      const before = yield* sql`SELECT reps FROM cards WHERE id = ${target.cardId}`
      const reps = Number(before[0]?.['reps'])

      // Two tabs grade the same prefetched Card at once.
      yield* Effect.all(
        [
          client.reviewsGrade({ id: 'race-a', cardId: target.cardId, grade: 'Good' }),
          client.reviewsGrade({ id: 'race-b', cardId: target.cardId, grade: 'Easy' }),
        ],
        { concurrency: 2 },
      )

      // Both Reviews land, and the second was scheduled from the first's
      // result rather than from the stale state both read.
      const cards = yield* sql`SELECT reps FROM cards WHERE id = ${target.cardId}`
      expect(cards[0]?.['reps']).toBe(reps + 2)
      const snapshots = yield* sql`SELECT s.reps FROM review_snapshots s
        JOIN reviews r ON r.id = s.review_id WHERE r.id LIKE 'race-%' ORDER BY s.reps`
      expect(snapshots.map((row) => row['reps'])).toEqual([reps, reps + 1])
    }).pipe(Effect.scoped),
  )
})
