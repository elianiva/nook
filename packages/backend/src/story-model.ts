/**
 * `StoryModel` — where story passages come from.
 *
 * The Worker holds one provider key and calls the provider itself, so the
 * browser sends a word and gets passages back. The key is a deploy secret, never
 * a Learner setting. Everything provider-specific stays in `openRouter`; the
 * handler only sees `generate`.
 */

import { OpenRouterClient, OpenRouterLanguageModel } from '@effect/ai-openrouter'
import { Context, Effect, Layer, Redacted } from 'effect'
import { LanguageModel } from 'effect/ai'
import { FetchHttpClient } from 'effect/http'
import { StoryBatch, StoryGenerationFailed } from '@nook/api'

export const STORIES_PER_BATCH = 10

const prompt = (word: string) =>
  [
    `Write ${STORIES_PER_BATCH} short, self-contained Japanese passages for a learner who is studying the word 「${word}」.`,
    'Each passage is one to three sentences of natural Japanese about a different everyday scene or piece of general knowledge, and it uses the word exactly as written.',
    'Return the word’s hiragana reading and a short English meaning once, then for each passage:',
    '- title: a short English title',
    '- tag: two or three English words in capitals, like a mood or place',
    '- caption: one English sentence that frames the scene without translating it',
    '- passage: the Japanese text',
    '- translation: a faithful English translation',
  ].join('\n')

export class StoryModel extends Context.Service<
  StoryModel,
  { generate(word: string): Effect.Effect<StoryBatch, StoryGenerationFailed> }
>()('nook/backend/StoryModel') {
  /** Generation through OpenRouter, which fronts many providers behind one key. */
  static openRouter = (apiKey: string, model: string) =>
    Layer.succeed(
      StoryModel,
      StoryModel.of({
        generate: (word) =>
          word === ''
            ? Effect.fail(new StoryGenerationFailed({ message: 'Enter a Japanese word.' }))
            : LanguageModel.generateObject({
                objectName: 'story_batch',
                prompt: prompt(word),
                schema: StoryBatch,
              }).pipe(
                Effect.map((response) => response.value),
                Effect.provide(OpenRouterLanguageModel.model(model)),
                Effect.provide(
                  OpenRouterClient.layer({ apiKey: Redacted.make(apiKey) }).pipe(
                    Layer.provide(FetchHttpClient.layer),
                  ),
                ),
                Effect.tapError((error) =>
                  Effect.logError('story generation failed').pipe(
                    Effect.annotateLogs({ errorTag: error._tag }),
                  ),
                ),
                Effect.mapError(
                  () =>
                    new StoryGenerationFailed({
                      message: 'The story provider failed. Try again in a moment.',
                    }),
                ),
              ),
      }),
    )

  /** Used when the deploy has no key: every request says so instead of crashing. */
  static unconfigured = Layer.succeed(
    StoryModel,
    StoryModel.of({
      generate: () =>
        Effect.fail(new StoryGenerationFailed({ message: 'Story generation is not set up.' })),
    }),
  )
}
