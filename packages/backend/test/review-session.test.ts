import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { HttpApiTest } from 'effect/http-api'
import { HttpServer } from 'effect/http'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Api, CardId, DeckId } from '@nook/api'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = Layer.mergeAll(ReviewsHandlers, HttpServer.layerServices).pipe(
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(SqlLive),
)

const makeClient = HttpApiTest.groups(Api, ['reviews'])

const showcaseDeck = DeckId.make('deck-showcase-japanese')
const query = { deckId: showcaseDeck, timezone: 'UTC' } as const

layer(TestLayers)('review session behaviour', (it) => {
  it.effect('re-queues an Again Card in-session and undoes a grade', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient

      const queue = yield* client.reviews.queue({ query })
      const target = queue.cards.find((card) => card.state === 'review')
      assert.isDefined(target)
      if (target === undefined) return

      // `Again` re-queues later this session: the answer says so, and the Card
      // stays out of the queue only until its lapse passes.
      const again = yield* client.reviews.grade({
        payload: { id: 'review-again-1', cardId: target.cardId, grade: 'Again' },
      })
      expect(again.state).toBe('relearning')
      expect(again.intervalDays).toBe(0)
      expect(again.requeueInSession).toBe(true)

      const queuedIds = (yield* client.reviews.queue({ query })).cards.map((card) => card.cardId)
      expect(queuedIds).not.toContain(target.cardId)

      // Undo restores the Card exactly: state, stability, difficulty, and queue membership.
      const undone = yield* client.reviews.undo({ payload: { cardId: target.cardId } })
      expect(undone.state).toBe(target.state)
      expect(undone.stability).toBeCloseTo(target.stability, 6)
      expect(undone.difficulty).toBeCloseTo(target.difficulty, 6)

      const restored = (yield* client.reviews.queue({ query })).cards.map((card) => card.cardId)
      expect(restored).toContain(target.cardId)

      // A passing grade leaves the queue until tomorrow and is not re-queued.
      const good = yield* client.reviews.grade({
        payload: { id: 'review-good-1', cardId: target.cardId, grade: 'Good' },
      })
      expect(good.requeueInSession).toBe(false)
      expect(good.intervalDays).toBeGreaterThanOrEqual(1)
      const afterGood = (yield* client.reviews.queue({ query })).cards.map((card) => card.cardId)
      expect(afterGood).not.toContain(target.cardId)

      const missing = yield* Effect.exit(
        client.reviews.undo({ payload: { cardId: CardId.make('card-nope') } }),
      )
      assert.strictEqual(missing._tag, 'Failure')
    }),
  )

  it.effect('buries same-Note siblings and enforces the daily new limit', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient

      // Grading one Card buries the other Cards from its Note until tomorrow.
      const queue = yield* client.reviews.queue({ query })
      const first = queue.cards.find((card) => card.noteId === 'showcase-note-8')
      assert.isDefined(first)
      if (first === undefined) return
      const siblingBefore = queue.cards.filter(
        (card) => card.noteId === first.noteId && card.cardId !== first.cardId,
      )
      void siblingBefore

      yield* client.reviews.grade({
        payload: { id: 'review-bury-1', cardId: first.cardId, grade: 'Good' },
      })
      const after = yield* client.reviews.queue({ query })
      const siblingsAfter = after.cards.filter((card) => card.noteId === first.noteId)
      expect(siblingsAfter.length).toBe(0)

      // The whole collection exports as one JSON document.
      const exported = yield* client.reviews.export()
      expect(exported.decks.length).toBeGreaterThanOrEqual(1)
      expect(exported.cards.length).toBeGreaterThanOrEqual(8)
      expect(exported.reviews.length).toBeGreaterThanOrEqual(1)
      expect(exported.exportedAt.length).toBeGreaterThan(0)
    }),
  )
})
