/**
 * The writes and the session fetch: one request each, whose answer comes back
 * as a Message.
 *
 * The list and detail reads live in `queries`, which owns their `AsyncData`
 * state. What stays here is the review session's queue — it belongs to a
 * larger transition than "retain a resource" — plus the settings Save and the
 * Grade, which are mutations.
 *
 * Every Command decodes its answer with the same `@nook/api` Schema the backend
 * encodes with, and answers with a result Message on failure too. Failure is a
 * Message, never a thrown error — Commands must stay total.
 */

import { Effect, Option, Schema as S } from 'effect'
import { Command, Http } from 'foldkit'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  AppSettings,
  CardId,
  CollectionExport,
  DeckId,
  Grade,
  ReviewAccepted,
  ReviewCard,
  ReviewQueue,
  ReviewSubmission,
  UndoAccepted,
  UndoReview,
} from '@nook/api'
import { loadReviewQueue, saveReviewQueue } from '@/lib/review-queue-store'
import { Message as MessageConstructors } from './model'
import type { LoadRetry } from './model'

const loadFailed = (error: string, retry: LoadRetry) =>
  MessageConstructors.LoadFailed({ error, retry })

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
      const timezone =
        typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
      const params = new URLSearchParams({ timezone })
      const deck = Option.getOrNull(deckId)
      if (deck !== null) params.set('deckId', deck)
      const response = yield* client.get(`/api/reviews/queue?${params.toString()}`)
      const ok = yield* HttpClientResponse.filterStatusOk(response)
      const queue = yield* HttpClientResponse.schemaBodyJson(ReviewQueue)(ok)
      return MessageConstructors.GotReviewQueue({
        cards: queue.cards,
        dayStartUtc: queue.dayStartUtc,
        lapseMinutes: 10,
      })
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
          HttpClientRequest.schemaBodyJson(ReviewSubmission)({
            id,
            cardId,
            grade,
            timezone:
              typeof Intl !== 'undefined'
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : 'UTC',
          }),
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

export const UndoGrade = Command.define('UndoGrade', {
  args: { cardId: CardId },
  messages: [MessageConstructors.UndoneGrade, MessageConstructors.UndoFailed],
  execute: ({ cardId }) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) =>
        HttpClientRequest.post('/api/reviews/undo').pipe(
          HttpClientRequest.schemaBodyJson(UndoReview)({ cardId }),
          Effect.flatMap(client.execute),
        ),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UndoAccepted)),
      Effect.map(() => MessageConstructors.UndoneGrade({ cardId })),
      Effect.catch(() =>
        Effect.succeed(
          MessageConstructors.UndoFailed({
            error: 'Could not undo that grade. Check the connection and try again.',
          }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
})

export const FetchExport = Command.define('FetchExport', {
  messages: [MessageConstructors.GotExport, MessageConstructors.ExportFailed],
  execute: HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get('/api/reviews/export')),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CollectionExport)),
    Effect.map((collection) =>
      MessageConstructors.GotExport({
        filename: `nook-export-${collection.exportedAt.slice(0, 10)}.json`,
        json: JSON.stringify(collection, null, 2),
      }),
    ),
    Effect.catch(() =>
      Effect.succeed(
        MessageConstructors.ExportFailed({
          error: 'Could not export the collection. Check the connection and try again.',
        }),
      ),
    ),
    Effect.provide(Http.layer),
  ),
})

export const DownloadFile = Command.define('DownloadFile', {
  args: { filename: S.String, json: S.String },
  messages: [MessageConstructors.DownloadedExport],
  execute: ({ filename, json }) =>
    Effect.sync(() => {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      return MessageConstructors.DownloadedExport()
    }),
})

export const PersistReviewQueue = Command.define('PersistReviewQueue', {
  args: {
    deckId: S.Option(DeckId),
    cards: S.Array(ReviewCard),
    dayStartUtc: S.String,
    lapseMinutes: S.Number,
  },
  messages: [MessageConstructors.PersistedReviewQueue],
  execute: ({ deckId, cards, dayStartUtc, lapseMinutes }) =>
    saveReviewQueue(deckId, {
      cards: [...cards],
      dayStartUtc,
      lapseMinutes,
      cachedAt: Date.now(),
      grades: [],
    }).pipe(
      Effect.map(() => MessageConstructors.PersistedReviewQueue()),
      Effect.catch(() => Effect.succeed(MessageConstructors.PersistedReviewQueue())),
    ),
})

export const LoadCachedQueue = Command.define('LoadCachedQueue', {
  args: { deckId: S.Option(DeckId) },
  messages: [MessageConstructors.GotReviewQueue, MessageConstructors.LoadFailed],
  execute: ({ deckId }) =>
    loadReviewQueue(deckId).pipe(
      Effect.map((cached) =>
        Option.match(cached, {
          onNone: () =>
            loadFailed(
              'Could not load the review queue. Check the connection and try again.',
              'reviewQueue',
            ),
          onSome: (queue) =>
            MessageConstructors.GotReviewQueue({
              cards: [...queue.cards],
              dayStartUtc: queue.dayStartUtc,
              lapseMinutes: queue.lapseMinutes,
            }),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(
          loadFailed(
            'Could not load the review queue. Check the connection and try again.',
            'reviewQueue',
          ),
        ),
      ),
    ),
})
