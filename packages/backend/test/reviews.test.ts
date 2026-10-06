import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { ReviewsRpc, CardId, DeckId } from '@nook/api'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = ReviewsHandlers.pipe(
  Layer.provideMerge(Reviews.layer),
  Layer.provideMerge(SqlLive),
)

const showcaseDeck = DeckId.make('deck-showcase-japanese')

layer(TestLayers)('reviews over sqlite', (it) => {
  it.effect('serves a rendered queue and schedules a graded Card', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(ReviewsRpc)

      const queue = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      // Four due Cards plus two new ones.
      expect(queue.cards.length).toBe(6)

      const basic = queue.cards.find((card) => card.question === 'おはよう')
      assert.isDefined(basic)
      expect(basic?.answer).toContain('Good morning')
      expect(basic?.answer).toContain('<hr id=answer>')
      expect(basic?.css).toContain('#nook-card .card')

      // The cloze Card for ordinal 2 hides c2 and shows c1.
      const cloze = queue.cards.find((card) => card.noteId === 'showcase-note-8')
      assert.isDefined(cloze)
      expect(cloze?.question).toContain('日本')
      expect(cloze?.question).toContain('[.')
      expect(cloze?.question).not.toContain('一番高い')

      const fresh = queue.cards.find((card) => card.state === 'new')
      assert.isDefined(fresh)
      if (fresh === undefined) return

      const graded = yield* client.reviewsGrade({
        id: 'review-test-1',
        cardId: fresh.cardId,
        grade: 'Good',
      })
      expect(graded.cardId).toBe(fresh.cardId)
      expect(graded.state).toBe('review')
      expect(graded.intervalDays).toBeGreaterThanOrEqual(1)

      // The graded new Card leaves the queue.
      const after = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      expect(after.cards.length).toBe(5)
      expect(after.cards.some((card) => card.cardId === fresh.cardId)).toBe(false)

      // Replaying the same Review id changes nothing.
      const replayed = yield* client.reviewsGrade({
        id: 'review-test-1',
        cardId: fresh.cardId,
        grade: 'Again',
      })
      expect(replayed.state).toBe('review')
      const stillAfter = yield* client.reviewsQueue({ deckId: showcaseDeck, timezone: 'UTC' })
      expect(stillAfter.cards.length).toBe(5)

      const missing = yield* Effect.exit(
        client.reviewsGrade({
          id: 'review-test-2',
          cardId: CardId.make('card-nope'),
          grade: 'Good',
        }),
      )
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )
})
