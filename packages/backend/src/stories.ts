/**
 * `Stories` — saving a story from the feed as a Card.
 *
 * A saved story is a Note of the built-in "Nook story" Note Type and one Card
 * in the "Stories" deck, with the word on the front. All three rows the save
 * needs besides the Note and Card (the deck, the Note Type, and the source
 * `imports` row that `notes.import_id` requires) are fixed-id inserts that
 * ignore a conflict, so the first save creates them and later saves find them.
 * Every statement is idempotent (ADR 0003), and a repeated `storyId` lands on
 * the same ids, so a retried save changes nothing.
 */

import { Context, Effect, Layer, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { CardId, StoriesRpc } from '@nook/api'
import { StoryGenerationFailed } from '@nook/api'
import type { StorageUnavailable, StoryCard } from '@nook/api'
import { runStatements } from './batch'
import { StoryModel } from './story-model'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'
import { CurrentUser } from './users'

/** Generations one user may start per UTC day. Each one costs the deploy's provider key. */
export const STORY_DAILY_LIMIT = 30

const NOTE_TYPE_ID = 'nook-story'
const DECK_ID = 'deck-stories'
const SOURCE_ID = 'stories'

const FIELDS = ['Word', 'Reading', 'Meaning', 'Passage', 'Translation'].map((name, ord) => ({
  ord,
  name,
  rightToLeft: false,
  fontName: null,
  fontSize: null,
  plainText: false,
  description: '',
  sticky: false,
}))

const TEMPLATES = [
  {
    ord: 0,
    name: 'Word',
    questionFormat: '<div class=word>{{Word}}</div>',
    answerFormat:
      '{{FrontSide}}\n\n<hr id=answer>\n\n<div class=reading>{{Reading}}</div>\n<div class=meaning>{{Meaning}}</div>\n<div class=passage lang=ja>{{Passage}}</div>\n<div class=translation>{{Translation}}</div>',
    deckId: 0,
  },
]

const CSS = `.card { font-family: system-ui, -apple-system, sans-serif; font-size: 20px; text-align: center; }
.word { font-size: 44px; }
.reading, .translation { color: #64748b; }
.meaning { font-size: 24px; margin: 8px 0 20px; }
.passage { font-size: 22px; line-height: 1.7; }
hr#answer { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }`

const cardIdFor = (storyId: string) => CardId.make(`story-card-${storyId}`)
const noteIdFor = (storyId: string) => `story-note-${storyId}`

const RemovedRow = Schema.Struct({ id: Schema.String })

export class Stories extends Context.Service<
  Stories,
  {
    /** Counts one generation against today's allowance, or fails when it is used up. */
    claimGeneration(): Effect.Effect<void, StoryGenerationFailed>
    save(story: StoryCard): Effect.Effect<{ cardId: CardId }, StorageUnavailable>
    unsave(storyId: string): Effect.Effect<{ removed: boolean }, StorageUnavailable>
  }
>()('nook/backend/Stories') {
  static readonly layer = Layer.effect(
    Stories,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient
      const { id: userId } = yield* CurrentUser

      const claimGeneration = () =>
        Effect.gen(function* () {
          const day = new Date().toISOString().slice(0, 10)
          // One statement: the increment only happens while under the limit, so
          // two requests cannot both take the last slot.
          const claimed = yield* sql`INSERT INTO story_usage (user_id, day, count)
            VALUES (${userId}, ${day}, 1)
            ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1
            WHERE story_usage.count < ${STORY_DAILY_LIMIT}
            RETURNING count`
          if (claimed.length === 0) {
            return yield* new StoryGenerationFailed({
              message: `You have used today's ${STORY_DAILY_LIMIT} story generations. Try again tomorrow.`,
            })
          }
        }).pipe(
          Effect.catchTag('SqlError', () =>
            Effect.fail(
              new StoryGenerationFailed({ message: 'Could not check your story allowance.' }),
            ),
          ),
          Effect.withSpan('Stories.claimGeneration'),
        )

      const save = (story: StoryCard) =>
        Effect.gen(function* () {
          const noteId = noteIdFor(story.storyId)
          const cardId = cardIdFor(story.storyId)
          const fields = JSON.stringify([
            story.word,
            story.reading,
            story.meaning,
            story.passage,
            story.translation,
          ])
          yield* runStatements([
            sql`INSERT OR IGNORE INTO decks (user_id, id, name, description)
              VALUES (${userId}, ${DECK_ID}, 'Stories', 'Passages saved from the story feed')`,
            sql`INSERT OR IGNORE INTO note_types
              (user_id, id, name, kind, sort_field_ord, css, fields, templates)
              VALUES (${userId}, ${NOTE_TYPE_ID}, 'Nook story', 'normal', 0, ${CSS},
                ${JSON.stringify(FIELDS)}, ${JSON.stringify(TEMPLATES)})`,
            sql`INSERT OR IGNORE INTO imports (user_id, id, filename, status)
              VALUES (${userId}, ${SOURCE_ID}, 'Saved from the story feed', 'done')`,
            sql`INSERT OR IGNORE INTO notes
              (user_id, id, note_type_id, guid, fields, tags, modified, import_id)
              VALUES (${userId}, ${noteId}, ${NOTE_TYPE_ID}, ${story.storyId}, ${fields}, '[]',
                CAST(strftime('%s', 'now') AS INTEGER), ${SOURCE_ID})`,
            // Last: the Card is what the Learner sees, so it is the commit point.
            sql`INSERT OR IGNORE INTO cards (user_id, id, deck_id, note_id, template_ord, state)
              VALUES (${userId}, ${cardId}, ${DECK_ID}, ${noteId}, 0, 'new')`,
          ])
          return { cardId }
        }).pipe(Effect.withSpan('Stories.save'), (self) =>
          withStorageErrorPassThrough(self, 'save the story'),
        )

      const unsave = (storyId: string) =>
        Effect.gen(function* () {
          // Only a Card nobody has reviewed: the Review log is append-only (ADR 0002).
          const rows = yield* sql`SELECT id FROM cards
            WHERE user_id = ${userId} AND id = ${cardIdFor(storyId)} AND state = 'new' AND reps = 0`
          const removable = yield* decodeRows(RemovedRow, rows)
          if (removable.length === 0) return { removed: false }
          yield* runStatements([
            sql`DELETE FROM cards WHERE user_id = ${userId} AND id = ${cardIdFor(storyId)} AND state = 'new' AND reps = 0`,
            sql`DELETE FROM notes WHERE user_id = ${userId} AND id = ${noteIdFor(storyId)}
              AND NOT EXISTS (SELECT 1 FROM cards WHERE user_id = ${userId} AND note_id = ${noteIdFor(storyId)})`,
          ])
          return { removed: true }
        }).pipe(Effect.withSpan('Stories.unsave'), (self) =>
          withStorageErrorPassThrough(self, 'remove the story'),
        )

      return Stories.of({ claimGeneration, save, unsave })
    }),
  )
}

export const StoriesHandlers = StoriesRpc.toLayer(
  Effect.gen(function* () {
    const stories = yield* Stories
    const model = yield* StoryModel
    return StoriesRpc.of({
      storiesGenerate: ({ word }) =>
        Effect.flatMap(stories.claimGeneration(), () => model.generate(word.trim())),
      storiesSave: (story) => stories.save(story),
      storiesUnsave: ({ storyId }) => stories.unsave(storyId),
    })
  }),
)
