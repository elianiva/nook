import { assert, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, HomeRpc, SettingsRpc, DeckId } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Home, HomeHandlers } from '../src/home'
import { Settings, SettingsHandlers } from '../src/settings'
import { dayStartUtc, dayStartUtcForKey, reviewDayKey } from '../src/day-boundary'
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

      const decks = yield* client.decksList({})
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
      expect(overview.retention7d).toBe(75)
      expect(overview.activity14d.length).toBe(14)

      const settings = yield* client.settingsGet()
      expect(settings.fsrs.weights.length).toBe(21)
      const health = yield* client.settingsFsrsHealth()
      expect(health).toEqual({
        reviewCount: 4,
        ratings: { again: 1, hard: 0, good: 2, easy: 1 },
        completeHistoryCount: 0,
        incompleteHistoryCount: 4,
        possibleHardMisuse: false,
      })
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

  it.effect('flags possible Hard/Again misuse only after a few hundred reviews', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(SettingsRpc)
      const sql = yield* Sql.SqlClient
      yield* sql.unsafe(`DELETE FROM reviews WHERE grade = 'Again'`)
      yield* sql.unsafe(`WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200
      ) INSERT INTO reviews (id, card_id, grade, reviewed_at)
        SELECT 'health-' || n, 'card-showcase-01', 'Hard', datetime('now') FROM seq`)

      const health = yield* client.settingsFsrsHealth()
      expect(health.reviewCount).toBe(203)
      expect(health.ratings.again).toBe(0)
      expect(health.ratings.hard).toBe(200)
      expect(health.possibleHardMisuse).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect(
    'counts eligible due Cards, distinct Cards reviewed, learner-day activity, and an open streak',
    () =>
      Effect.gen(function* () {
        yield* migrate
        const client = yield* RpcTest.makeClient(HomeRpc)
        const sql = yield* Sql.SqlClient
        const now = new Date()
        const boundary = Date.parse(dayStartUtc('Asia/Jakarta', 4, now))
        // Older Review rows can use SQLite's `YYYY-MM-DD HH:MM:SS` format;
        // comparing that string with an ISO boundary sorts incorrectly.
        const todayReviewAt = new Date(boundary + 60 * 60_000)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
        const yesterdayReviewAt = new Date(boundary - 60_000).toISOString()

        yield* sql`UPDATE cards SET suspended = 1 WHERE id = 'card-showcase-01'`
        yield* sql`UPDATE cards SET note_id = NULL WHERE id = 'card-showcase-02'`
        yield* sql`DELETE FROM reviews`
        yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
        VALUES ('overview-today-a', 'card-showcase-01', 'Good', ${todayReviewAt})`
        yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
        VALUES ('overview-today-b', 'card-showcase-01', 'Again', ${todayReviewAt})`
        yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
        VALUES ('overview-yesterday', 'card-showcase-03', 'Good', ${yesterdayReviewAt})`

        const overview = yield* client.homeOverview({ timezone: 'Asia/Jakarta' })
        expect(overview.dueNow).toBe(2)
        expect(overview.reviewedToday).toBe(1)
        expect(overview.retention7d).toBe(67)
        expect(overview.activity14d.slice(-2)).toEqual([1, 2])
        expect(overview.streakDays).toBe(2)
      }).pipe(Effect.scoped),
  )

  it.effect('keeps yesterday’s streak alive before the learner has reviewed today', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(HomeRpc)
      const sql = yield* Sql.SqlClient
      const boundary = Date.parse(dayStartUtc('Asia/Jakarta', 4, new Date()))
      const yesterdayReviewAt = new Date(boundary - 60_000).toISOString()
      yield* sql`DELETE FROM reviews`
      yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
        VALUES ('overview-yesterday', 'card-showcase-03', 'Good', ${yesterdayReviewAt})`

      const overview = yield* client.homeOverview({ timezone: 'Asia/Jakarta' })
      expect(overview.reviewedToday).toBe(0)
      expect(overview.retention7d).toBe(100)
      expect(overview.activity14d.slice(-2)).toEqual([1, 0])
      expect(overview.streakDays).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect('counts streaks longer than the 14-day activity chart', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(HomeRpc)
      const sql = yield* Sql.SqlClient
      const now = new Date()
      const todayKey = reviewDayKey('UTC', 4, now)
      const today = new Date(`${todayKey}T00:00:00Z`)
      const dayKeys = Array.from({ length: 16 }, (_, index) => {
        const day = new Date(today)
        day.setUTCDate(day.getUTCDate() - (15 - index))
        return day.toISOString().slice(0, 10)
      })
      yield* sql`DELETE FROM reviews`
      for (const [index, day] of dayKeys.entries()) {
        const reviewedAt =
          index === dayKeys.length - 1
            ? now.toISOString()
            : new Date(Date.parse(dayStartUtcForKey('UTC', 4, day)) + 60_000).toISOString()
        yield* sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
          VALUES (${'overview-streak-' + index}, 'card-showcase-01', 'Good', ${reviewedAt})`
      }

      const overview = yield* client.homeOverview({ timezone: 'UTC' })
      expect(overview.activity14d).toEqual(Array.from({ length: 14 }, () => 1))
      expect(overview.streakDays).toBe(16)
    }).pipe(Effect.scoped),
  )
})
