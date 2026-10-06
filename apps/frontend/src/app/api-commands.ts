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

/**
 * Encodes queue cards to plain JSON before they reach IndexedDB. `ReviewCard`
 * carries `dueAt` as an `Option`, whose tag fields are non-enumerable and do
 * not survive the structured clone — a stored `None` reads back as `{}`, so
 * the list-cache fix in `app/queries` applies here too. An unencodable card
 * drops the whole persist: a partial queue would review the wrong cards.
 */
const toCachedCards = (cards: ReadonlyArray<ReviewCard>): Option.Option<S.Json> => {
  const json = S.toCodecJson(S.Array(ReviewCard))
  return S.encodeUnknownOption(json)([...cards])
}

/**
 * Decodes stored queue JSON back into domain cards. Anything misshapen reads
 * as absent, so a stale shape boots empty instead of reviewing wrong cards.
 */
const fromCachedCards = (cards: unknown): Option.Option<ReadonlyArray<ReviewCard>> => {
  const json = S.toCodecJson(S.Array(ReviewCard))
  return S.decodeUnknownOption(json)(cards)
}

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

/**
 * Reloads into the waiting shell. The banner offers this outside review
 * only; the command itself never fires unprompted.
 */
export const ReloadApp = Command.define('ReloadApp', {
  messages: [MessageConstructors.AppliedSwUpdate],
  execute: Effect.sync(() => {
    window.location.reload()
    return MessageConstructors.AppliedSwUpdate()
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
    Option.match(toCachedCards(cards), {
      onNone: () => Effect.succeed(MessageConstructors.PersistedReviewQueue()),
      onSome: (cachedCards) =>
        saveReviewQueue(deckId, {
          cards: cachedCards,
          dayStartUtc,
          lapseMinutes,
          cachedAt: Date.now(),
          grades: [],
        }).pipe(
          // Warm the media cache with the queued cards' images and audio, so a
          // reload mid-queue offline still renders them. Best-effort: a missing
          // Cache API or a failed add leaves the queue itself intact.
          Effect.tap(() => warmMediaCache(cards).pipe(Effect.ignore)),
          Effect.map(() => MessageConstructors.PersistedReviewQueue()),
          Effect.catch(() => Effect.succeed(MessageConstructors.PersistedReviewQueue())),
        ),
    }),
})

/** Media URLs named in the queued cards' rendered HTML. */
export const mediaUrlsIn = (cards: ReadonlyArray<ReviewCard>): ReadonlyArray<string> => {
  const found = new Set<string>()
  const pattern = /\/api\/media\/[^\s"'<>)]+/g
  for (const card of cards) {
    for (const html of [card.question, card.answer]) {
      for (const match of html.matchAll(pattern)) {
        try {
          found.add(decodeURIComponent(match[0]))
        } catch {
          found.add(match[0])
        }
      }
    }
  }
  return [...found]
}

/**
 * Adds the queued cards' media to the worker's media cache. `Cache.addAll`
 * fetches through the worker's own routes, so the entries land under the
 * cache-first strategy `src/sw.ts` serves offline.
 */
const warmMediaCache = (cards: ReadonlyArray<ReviewCard>): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async () => {
      if (typeof caches === 'undefined') return
      const urls = mediaUrlsIn(cards)
      if (urls.length === 0) return
      const cache = await caches.open('nook-media')
      await cache.addAll(urls)
    },
    catch: (error) => error,
  })

export const LoadCachedQueue = Command.define('LoadCachedQueue', {
  args: { deckId: S.Option(DeckId) },
  messages: [MessageConstructors.GotReviewQueue, MessageConstructors.LoadFailed],
  execute: ({ deckId }) =>
    loadReviewQueue(deckId).pipe(
      Effect.map((cached) =>
        Option.flatMap(cached, (queue) =>
          Option.map(fromCachedCards(queue.cards), (cards) =>
            MessageConstructors.GotReviewQueue({
              cards: [...cards],
              dayStartUtc: queue.dayStartUtc,
              lapseMinutes: queue.lapseMinutes,
            }),
          ),
        ),
      ),
      Effect.map((restored) =>
        Option.match(restored, {
          onNone: () =>
            loadFailed(
              'Could not load the review queue. Check the connection and try again.',
              'reviewQueue',
            ),
          onSome: (message) => message,
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
