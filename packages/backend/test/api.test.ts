import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { HttpApiTest } from 'effect/http-api'
import { HttpServer } from 'effect/http'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Api, DeckId } from '@nook/api'
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

const TestLayers = Layer.mergeAll(HandlersLive, HttpServer.layerServices)

const makeClient = HttpApiTest.groups(Api, ['decks', 'home', 'settings'])

layer(TestLayers)('backend over sqlite', (it) => {
  it.effect('serves the showcase deck, the overview, and the settings round-trip', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* makeClient

      const decks = yield* client.decks.list()
      assert.isAtLeast(decks.length, 1)
      const showcase = decks.find((deck) => deck.id === 'deck-showcase-japanese')
      assert.isDefined(showcase)
      expect(showcase?.dueCount).toBe(4)
      expect(showcase?.newCount).toBe(2)
      expect(showcase?.totalCount).toBe(8)

      const detail = yield* client.decks.getById({
        params: { deckId: DeckId.make('deck-showcase-japanese') },
      })
      expect(detail.cards.length).toBe(8)

      const exit = yield* Effect.exit(
        client.decks.getById({ params: { deckId: DeckId.make('deck-nope') } }),
      )
      assert.strictEqual(exit._tag, 'Failure')

      const overview = yield* client.home.overview()
      expect(overview.dueNow).toBe(4)
      expect(overview.activity14d.length).toBe(14)

      const settings = yield* client.settings.get()
      expect(settings.fsrs.weights.length).toBe(21)
      const saved = yield* client.settings.update({
        payload: {
          ...settings,
          fsrs: { ...settings.fsrs, desiredRetention: 0.85 },
          behaviour: { ...settings.behaviour, keepAwake: !settings.behaviour.keepAwake },
        },
      })
      expect(saved.fsrs.desiredRetention).toBe(0.85)
      const reread = yield* client.settings.get()
      expect(reread.fsrs.desiredRetention).toBe(0.85)
      expect(reread.behaviour.keepAwake).toBe(!settings.behaviour.keepAwake)
    }),
  )
})
