import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, HomeRpc, SettingsRpc, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Home, HomeHandlers } from '../src/home'
import { Settings, SettingsHandlers } from '../src/settings'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

// Handlers need SqlClient at runtime. `provideMerge` wires the single SqlLive
// instance into them (merge alone would leave it an open requirement) while
// still exposing SqlClient, so `migrate` above reads the same :memory: share.
const HandlersLive = Layer.mergeAll(DecksHandlers, HomeHandlers, SettingsHandlers).pipe(
  Layer.provideMerge(Decks.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(SqlLive),
)

layer(HandlersLive)('backend over sqlite', (it) => {
  it.effect('serves the showcase deck, the overview, and the settings round-trip', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(HomeRpc, SettingsRpc))

      const decks = yield* client.decksList()
      assert.isAtLeast(decks.length, 1)
      const showcase = decks.find((deck) => deck.id === 'deck-showcase-japanese')
      assert.isDefined(showcase)
      expect(showcase?.dueCount).toBe(4)
      expect(showcase?.newCount).toBe(2)
      expect(showcase?.totalCount).toBe(8)

      const detail = yield* client.decksGetById({
        deckId: DeckId.make('deck-showcase-japanese'),
      })
      expect(detail.cards.length).toBe(8)

      const exit = yield* Effect.exit(client.decksGetById({ deckId: DeckId.make('deck-nope') }))
      assert.strictEqual(exit._tag, 'Failure')

      const overview = yield* client.homeOverview({})
      expect(overview.dueNow).toBe(4)
      expect(overview.activity14d.length).toBe(14)

      const settings = yield* client.settingsGet()
      expect(settings.fsrs.weights.length).toBe(21)
      const saved = yield* client.settingsUpdate({
        ...settings,
        fsrs: { ...settings.fsrs, desiredRetention: 0.85 },
      })
      expect(saved.fsrs.desiredRetention).toBe(0.85)
      const reread = yield* client.settingsGet()
      expect(reread.fsrs.desiredRetention).toBe(0.85)
      expect(reread.behaviour.tapToReveal).toBe(settings.behaviour.tapToReveal)
    }).pipe(Effect.scoped),
  )
})
