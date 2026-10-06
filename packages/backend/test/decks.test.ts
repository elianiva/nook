import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = DecksHandlers.pipe(Layer.provideMerge(Decks.layer), Layer.provideMerge(SqlLive))

const showcaseDeck = DeckId.make('deck-showcase-japanese')

layer(TestLayers)('deck management over sqlite', (it) => {
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

      const decks = yield* client.decksList()
      expect(decks.some((deck) => deck.id === showcaseDeck)).toBe(false)

      const gone = yield* Effect.exit(client.decksGetById({ deckId: showcaseDeck }))
      assert.strictEqual(gone._tag, 'Failure')

      const missing = yield* Effect.exit(client.decksRemove({ deckId: DeckId.make('deck-nope') }))
      assert.strictEqual(missing._tag, 'Failure')
    }).pipe(Effect.scoped),
  )
})
