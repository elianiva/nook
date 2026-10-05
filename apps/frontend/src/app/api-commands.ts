/**
 * Fetch/save Commands: one request each, whose answer comes back as a Message.
 *
 * Each Command calls its endpoint, decodes the JSON body with the same
 * `@nook/api` Schema the backend encodes with, and answers with a `Got*` /
 * `SavedSettings` Message. A 404 on the deck endpoint answers with
 * `GotDeckDetail` cleared to `None` through `DeckMissing`, so the deck page
 * renders its not-found state. Any other failure (network, 503, decode)
 * answers with `LoadFailed` instead, so `update` keeps rendering the seeded
 * Model with a retry banner rather than crashing.
 *
 * Failure is a Message, never a thrown error — Commands must stay total.
 */

import { Effect, Option, Schema as S } from 'effect'
import { Command, Http } from 'foldkit'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  AppSettings,
  CardId,
  DeckId,
  DeckDetail,
  DeckSummary,
  Grade,
  Overview,
  ReviewAccepted,
  ReviewQueue,
  ReviewSubmission,
} from '@nook/api'
import { Message as MessageConstructors } from './model'
import type { LoadRetry } from './model'

const loadFailed = (error: string, retry: LoadRetry) =>
  MessageConstructors.LoadFailed({ error, retry })

export const FetchOverview = Command.define('FetchOverview', {
  messages: [MessageConstructors.GotOverview, MessageConstructors.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/home')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Overview)),
    Effect.map((overview) => MessageConstructors.GotOverview({ overview })),
    Effect.catch(() =>
      Effect.succeed(
        loadFailed('Could not load the overview. Check the connection and try again.', 'overview'),
      ),
    ),
    Effect.provide(Http.layer),
  ),
})

export const FetchDecks = Command.define('FetchDecks', {
  messages: [MessageConstructors.GotDecks, MessageConstructors.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/decks')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(S.Array(DeckSummary))),
    Effect.map((decks) => MessageConstructors.GotDecks({ decks })),
    Effect.catch(() =>
      Effect.succeed(
        loadFailed('Could not load the decks. Check the connection and try again.', 'decks'),
      ),
    ),
    Effect.provide(Http.layer),
  ),
})

export const FetchDeckDetail = Command.define('FetchDeckDetail', {
  args: { deckId: S.String },
  messages: [
    MessageConstructors.GotDeckDetail,
    MessageConstructors.DeckMissing,
    MessageConstructors.LoadFailed,
  ],
  execute: ({ deckId }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(`/api/decks/${encodeURIComponent(deckId)}`)
      if (response.status === 404) return MessageConstructors.DeckMissing()
      const ok = yield* HttpClientResponse.filterStatusOk(response)
      const detail = yield* HttpClientResponse.schemaBodyJson(DeckDetail)(ok)
      return MessageConstructors.GotDeckDetail({ detail })
    }).pipe(
      Effect.orElseSucceed(() =>
        loadFailed('Could not load this deck. Check the connection and try again.', 'deckDetail'),
      ),
      Effect.provide(Http.layer),
    ),
})

export const FetchSettings = Command.define('FetchSettings', {
  messages: [MessageConstructors.GotSettings, MessageConstructors.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/settings')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AppSettings)),
    Effect.map((settings) => MessageConstructors.GotSettings({ settings })),
    Effect.catch(() =>
      Effect.succeed(
        loadFailed('Could not load the settings. Check the connection and try again.', 'settings'),
      ),
    ),
    Effect.provide(Http.layer),
  ),
})

export const SaveSettings = Command.define('SaveSettings', {
  args: { settings: AppSettings },
  messages: [MessageConstructors.SavedSettings, MessageConstructors.LoadFailed],
  execute: ({ settings }) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        HttpClientRequest.put('/api/settings').pipe(
          HttpClientRequest.schemaBodyJson(AppSettings)(settings),
          Effect.flatMap(client.execute),
        ),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AppSettings)),
      Effect.map((saved) => MessageConstructors.SavedSettings({ settings: saved })),
      Effect.catch(() =>
        Effect.succeed(
          loadFailed(
            'Could not save the settings. The form is intact — try again.',
            'saveSettings',
          ),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const FetchReviewQueue = Command.define('FetchReviewQueue', {
  args: { deckId: S.Option(DeckId) },
  messages: [MessageConstructors.GotReviewQueue, MessageConstructors.LoadFailed],
  execute: ({ deckId }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const query = Option.match(deckId, {
        onNone: () => '',
        onSome: (id) => `?deckId=${encodeURIComponent(id)}`,
      })
      const response = yield* client.get(`/api/reviews/queue${query}`)
      const ok = yield* HttpClientResponse.filterStatusOk(response)
      const queue = yield* HttpClientResponse.schemaBodyJson(ReviewQueue)(ok)
      return MessageConstructors.GotReviewQueue({ cards: queue.cards })
    }).pipe(
      Effect.orElseSucceed(() =>
        loadFailed(
          'Could not load the review queue. Check the connection and try again.',
          'reviewQueue',
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const SubmitGrade = Command.define('SubmitGrade', {
  args: { id: S.String, cardId: CardId, grade: Grade },
  messages: [MessageConstructors.GradeAccepted, MessageConstructors.GradeFailed],
  execute: ({ id, cardId, grade }) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        HttpClientRequest.post('/api/reviews/grade').pipe(
          HttpClientRequest.schemaBodyJson(ReviewSubmission)({ id, cardId, grade }),
          Effect.flatMap(client.execute),
        ),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ReviewAccepted)),
      Effect.map((accepted) => MessageConstructors.GradeAccepted({ id, accepted })),
      Effect.catch(() =>
        Effect.succeed(
          MessageConstructors.GradeFailed({
            error: 'Could not save that grade. It is waiting — try again.',
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})
