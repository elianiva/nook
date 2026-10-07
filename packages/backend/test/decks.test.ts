import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import * as Sql from 'effect/sql/SqlClient'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, CardId, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = DecksHandlers.pipe(Layer.provideMerge(Decks.layer), Layer.provideMerge(SqlLive))

const showcaseDeck = DeckId.make('deck-showcase-japanese')

layer(TestLayers)('deck management over sqlite', (it) => {
  it.effect('serves a plain-text prompt preview per card', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc)

      const detail = yield* client.decksGetById({ deckId: showcaseDeck })
      expect(detail.cards.length).toBe(8)
      const previews = new Map(detail.cards.map((card) => [card.id, card.preview]))
      // Basic note: the prompt side only, never the answer.
      expect(previews.get(CardId.make('card-showcase-01'))).toBe('おはよう')
      // Cloze note: surrounding text with the hidden answer replaced by its hint.
      expect(previews.get(CardId.make('card-showcase-07'))).toContain('東京は')
      expect(previews.get(CardId.make('card-showcase-07'))).not.toContain('日本の首都')
    }).pipe(Effect.scoped),
  )

  it.effect('renames a deck and trims the fields', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc)

      const renamed = yield* client.decksRename({
        deckId: showcaseDeck,
        rename: { name: '  New Name  ', description: '  Fresh words  ' },
      })
      expect(renamed.summary.name).toBe('New Name')
      expect(renamed.summary.description).toBe('Fresh words')
      expect(renamed.summary.totalCount).toBe(8)

      const reread = yield* client.decksGetById({ deckId: showcaseDeck })
      expect(reread.summary.name).toBe('New Name')

      const missing = yield* Effect.exit(
        client.decksRename({
          deckId: DeckId.make('deck-nope'),
          rename: { name: 'Ghost', description: '' },
        }),
      )
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )

  it.effect('suspends and restores a Card without changing its schedule or history', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc)
      const sql = yield* Sql.SqlClient
      const cardId = CardId.make('card-showcase-01')
      const before = yield* client.decksGetById({ deckId: showcaseDeck })
      const beforeCard = before.cards.find((card) => card.id === cardId)
      assert.isDefined(beforeCard)
      if (beforeCard === undefined) return
      const reviewRows = yield* sql`SELECT COUNT(*) AS n FROM reviews WHERE card_id = ${cardId}`
      const historyCount = (reviewRows as ReadonlyArray<{ n: number }>)[0]?.n
      assert.isDefined(historyCount)

      const suspended = yield* client.cardsSetSuspended({ cardId, suspended: true })
      expect(suspended).toEqual({ cardId, suspended: true })
      const paused = yield* client.decksGetById({ deckId: showcaseDeck })
      const pausedCard = paused.cards.find((card) => card.id === cardId)
      expect(pausedCard?.suspended).toBe(true)
      expect(paused.summary.dueCount).toBe(before.summary.dueCount - 1)
      expect(paused.summary.totalCount).toBe(before.summary.totalCount)
      expect(pausedCard).toMatchObject({
        state: beforeCard.state,
        dueAt: beforeCard.dueAt,
        stability: beforeCard.stability,
        difficulty: beforeCard.difficulty,
        lapses: beforeCard.lapses,
      })
      const afterRows = yield* sql`SELECT COUNT(*) AS n FROM reviews WHERE card_id = ${cardId}`
      expect((afterRows as ReadonlyArray<{ n: number }>)[0]?.n).toBe(historyCount)

      yield* client.cardsSetSuspended({ cardId, suspended: false })
      const restored = yield* client.decksGetById({ deckId: showcaseDeck })
      expect(restored.cards.find((card) => card.id === cardId)?.suspended).toBe(false)
      expect(restored.summary.dueCount).toBe(before.summary.dueCount)

      const missing = yield* Effect.exit(
        client.cardsSetSuspended({ cardId: CardId.make('card-nope'), suspended: false }),
      )
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )

  it.effect('resets a deck back to new and clears its reviews', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc)

      const before = yield* client.decksGetById({ deckId: showcaseDeck })
      expect(before.summary.dueCount).toBe(4)
      expect(before.summary.newCount).toBe(2)

      const reset = yield* client.decksReset({ deckId: showcaseDeck })
      expect(reset.summary.totalCount).toBe(8)
      expect(reset.summary.dueCount).toBe(0)
      expect(reset.summary.newCount).toBe(8)
      expect(reset.summary.lastStudiedAt._tag).toBe('None')
      expect(reset.cards.every((card) => card.state === 'new')).toBe(true)

      const missing = yield* Effect.exit(client.decksReset({ deckId: DeckId.make('deck-nope') }))
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )

  it.effect('removes a deck with its cards and reviews', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc)

      yield* client.decksRemove({ deckId: showcaseDeck })

      const decks = yield* client.decksList({})
      expect(decks.some((deck) => deck.id === showcaseDeck)).toBe(false)

      const gone = yield* Effect.exit(client.decksGetById({ deckId: showcaseDeck }))
      assert.strictEqual(gone._tag, 'Failure')

      const missing = yield* Effect.exit(client.decksRemove({ deckId: DeckId.make('deck-nope') }))
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )
})
