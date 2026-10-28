import { CurrentUser, LEGACY_OWNER } from '../src/users'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { RpcTest } from 'effect/rpc'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { DecksRpc, DeckId, ReviewsRpc, StoriesRpc } from '@nook/api'
import { Decks, DecksHandlers } from '../src/decks'
import { Reviews, ReviewsHandlers } from '../src/reviews'
import { STORY_DAILY_LIMIT, Stories, StoriesHandlers } from '../src/stories'
import { StoryModel } from '../src/story-model'
import { migrate } from './migrate'

const SqlLive = SqliteClient.layer({ filename: ':memory:' })

const TestLayers = Layer.mergeAll(DecksHandlers, ReviewsHandlers, StoriesHandlers).pipe(
  Layer.provideMerge(
    Layer.mergeAll(Decks.layer, Reviews.layer, Stories.layer, StoryModel.unconfigured),
  ),
  Layer.provideMerge(CurrentUser.layer(LEGACY_OWNER)),
  Layer.provideMerge(SqlLive),
)

const story = {
  storyId: 'story-1',
  word: '余韻',
  reading: 'よいん',
  meaning: 'a feeling that lingers',
  passage: '雨がやんだ駅のホーム。音の余韻が残っていた。',
  translation: 'On the platform after the rain, an echo lingered.',
}
const storiesDeck = DeckId.make('deck-stories')

layer(TestLayers)('saving stories over sqlite', (it) => {
  it.effect('saves a story as a Card with the word on the front, once', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc, StoriesRpc))
      const sql = yield* Sql.SqlClient

      const first = yield* client.storiesSave(story)
      const replay = yield* client.storiesSave(story)
      expect(replay).toEqual(first)

      const detail = yield* client.decksGetById({ deckId: storiesDeck })
      expect(detail.summary.name).toBe('Stories')
      expect(detail.cards.map((card) => card.preview)).toEqual(['余韻'])

      const queue = yield* client.reviewsQueue({ deckId: storiesDeck, timezone: 'UTC' })
      const card = queue.cards[0]
      expect(queue.cards).toHaveLength(1)
      expect(card?.question).toContain('余韻')
      expect(card?.question).not.toContain('よいん')
      expect(card?.answer).toContain('よいん')
      expect(card?.answer).toContain('a feeling that lingers')
      expect(card?.answer).toContain('雨がやんだ駅のホーム')
      expect(card?.answer).toContain('an echo lingered')

      const notes = yield* sql`SELECT count(*) AS n FROM notes WHERE guid = 'story-1'`
      expect(notes).toEqual([{ n: 1 }])
    }).pipe(Effect.scoped),
  )

  it.effect('unsaves a Card nobody reviewed and keeps one that has history', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc, StoriesRpc))
      const sql = yield* Sql.SqlClient

      yield* client.storiesSave(story)
      yield* client.storiesSave({ ...story, storyId: 'story-2' })

      expect(yield* client.storiesUnsave({ storyId: 'story-1' })).toEqual({ removed: true })
      expect(yield* client.storiesUnsave({ storyId: 'story-1' })).toEqual({ removed: false })

      yield* sql`UPDATE cards SET reps = 1, state = 'review' WHERE id = 'story-card-story-2'`
      expect(yield* client.storiesUnsave({ storyId: 'story-2' })).toEqual({ removed: false })

      const detail = yield* client.decksGetById({ deckId: storiesDeck })
      expect(detail.cards).toHaveLength(1)
      const notes = yield* sql`SELECT guid FROM notes WHERE guid LIKE 'story-%'`
      expect(notes).toEqual([{ guid: 'story-2' }])
    }).pipe(Effect.scoped),
  )

  it.effect('says generation is not set up when the deploy has no key', () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DecksRpc.merge(ReviewsRpc, StoriesRpc))
      const failure = yield* Effect.flip(client.storiesGenerate({ word: '余韻' }))
      expect(failure._tag).toBe('StoryGenerationFailed')
    }).pipe(Effect.scoped),
  )

  it.effect('stops generating once the day\u2019s allowance is used', () =>
    Effect.gen(function* () {
      yield* migrate
      const client = yield* RpcTest.makeClient(StoriesRpc)
      for (let n = 0; n < STORY_DAILY_LIMIT; n += 1) {
        const error = yield* client.storiesGenerate({ word: '余韻' }).pipe(Effect.flip)
        expect(error.message).toBe('Story generation is not set up.')
      }
      const over = yield* client.storiesGenerate({ word: '余韻' }).pipe(Effect.flip)
      expect(over.message).toContain('Try again tomorrow')
    }),
  )
})
