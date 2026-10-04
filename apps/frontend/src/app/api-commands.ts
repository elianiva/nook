/**
 * Fetch/save Commands: one request each, whose answer comes back as a Message.
 *
 * Each Command calls its RPC endpoint, decodes the JSON body with the same
 * `@nook/api` Schema the backend encodes with, and answers with a `Got*` /
 * `SavedSettings` Message. Any failure (network, status, decode) answers
 * with `LoadFailed` instead, so `update` keeps rendering the seeded Model
 * rather than crashing.
 *
 * Failure is a Message, never a thrown error — Commands must stay total.
 */

import { Effect, Schema as S } from 'effect'
import { Command, Http } from 'foldkit'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { AppSettings, DeckDetail, DeckSummary, Overview } from '@nook/api'
import { Message } from './model'

const loadFailed = (error: string) => Message.LoadFailed({ error })

export const FetchOverview = Command.define('FetchOverview', {
  messages: [Message.GotOverview, Message.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/home')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Overview)),
    Effect.map((overview) => Message.GotOverview({ overview })),
    Effect.catch(() => Effect.succeed(loadFailed('Could not load the overview.'))),
    Effect.provide(Http.layer),
  ),
})

export const FetchDecks = Command.define('FetchDecks', {
  messages: [Message.GotDecks, Message.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/decks')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(S.Array(DeckSummary))),
    Effect.map((decks) => Message.GotDecks({ decks })),
    Effect.catch(() => Effect.succeed(loadFailed('Could not load the decks.'))),
    Effect.provide(Http.layer),
  ),
})

export const FetchDeckDetail = Command.define('FetchDeckDetail', {
  args: { deckId: S.String },
  messages: [Message.GotDeckDetail, Message.LoadFailed],
  execute: ({ deckId }) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) => client.get(`/api/decks/${encodeURIComponent(deckId)}`)),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DeckDetail)),
      Effect.map((detail) => Message.GotDeckDetail({ detail })),
      Effect.catch(() => Effect.succeed(loadFailed('Could not load this deck.'))),
      Effect.provide(Http.layer),
    ),
})

export const FetchSettings = Command.define('FetchSettings', {
  messages: [Message.GotSettings, Message.LoadFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/settings')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AppSettings)),
    Effect.map((settings) => Message.GotSettings({ settings })),
    Effect.catch(() => Effect.succeed(loadFailed('Could not load the settings.'))),
    Effect.provide(Http.layer),
  ),
})

export const SaveSettings = Command.define('SaveSettings', {
  args: { settings: AppSettings },
  messages: [Message.SavedSettings, Message.LoadFailed],
  execute: ({ settings }) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        HttpClientRequest.put('/api/settings').pipe(
          HttpClientRequest.bodyJsonUnsafe(S.encodeSync(AppSettings)(settings)),
          client.execute,
        ),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AppSettings)),
      Effect.map((saved) => Message.SavedSettings({ settings: saved })),
      Effect.catch(() => Effect.succeed(loadFailed('Could not save the settings.'))),
      Effect.provide(Http.layer),
    ),
})
