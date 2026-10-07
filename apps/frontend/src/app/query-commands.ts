/**
 * Query Commands: the parts of a list read that touch storage, not the
 * network.
 *
 * Each Query's `execute` already saves its fresh answers and falls back to
 * the cache on failure. What stays here is the boot read: `RestoreQueries`
 * loads every cached list answer in one Command, following the
 * `RestoreImportJob` pattern, so `init` can seed each Query as `Success`
 * before the route's own loads revalidate in the background.
 *
 * Failure is a Message, never a thrown error. An unreadable store boots the
 * app empty; the route loads fetch fresh.
 */

import { Effect, Option, Schema as S } from 'effect'
import { Command } from 'foldkit'
import { DeckId } from '@nook/api'
import { loadQuery } from '@/lib/query-cache'
import {
  DECK_DETAIL_CACHE_LIMIT,
  DECK_DETAIL_INDEX_KEY,
  DECK_DETAIL_INDEX_TTL_MS,
  deckDetailPersistFor,
  decodeIndex,
  decksPersist,
  overviewPersist,
} from './queries'
import { Message, RestoredAnswer } from './model'

/**
 * Reads every cached list answer: the overview, the decks, and the last 20
 * deck details. A deck id that no longer decodes is skipped, so a stale
 * index entry can never poison the seed.
 */
export const RestoreQueries = Command.define('RestoreQueries', {
  messages: [Message.RestoredCachedQueries],
  execute: Effect.gen(function* () {
    const answers: Array<RestoredAnswer> = []
    const overview = yield* loadQuery(
      overviewPersist.cacheKey,
      overviewPersist.maxAgeMs,
      overviewPersist.fromCache,
    ).pipe(Effect.catch(() => Effect.succeed(Option.none())))
    if (Option.isSome(overview)) {
      answers.push({ kind: 'overview', value: overview.value.data.data })
    }
    const decks = yield* loadQuery(
      decksPersist.cacheKey,
      decksPersist.maxAgeMs,
      decksPersist.fromCache,
    ).pipe(Effect.catch(() => Effect.succeed(Option.none())))
    if (Option.isSome(decks)) {
      answers.push({ kind: 'decks', value: decks.value.data.data })
    }
    const index = yield* loadQuery(
      DECK_DETAIL_INDEX_KEY,
      DECK_DETAIL_INDEX_TTL_MS,
      decodeIndex,
    ).pipe(Effect.catch(() => Effect.succeed(Option.none())))
    const keys = Option.match(index, {
      onNone: () => [] as ReadonlyArray<string>,
      onSome: (answer) => answer.data,
    })
    for (const key of keys.slice(-DECK_DETAIL_CACHE_LIMIT)) {
      const rawId = key.slice('query:deck-detail:'.length)
      const deckId = S.decodeUnknownOption(DeckId)(rawId)
      if (Option.isNone(deckId)) continue
      const persist = deckDetailPersistFor(deckId.value)
      const detail = yield* loadQuery(key, persist.maxAgeMs, persist.fromCache).pipe(
        Effect.catch(() => Effect.succeed(Option.none())),
      )
      if (Option.isSome(detail)) {
        answers.push({ kind: 'deckDetail', deckId: deckId.value, value: detail.value.data.data })
      }
    }
    return Message.RestoredCachedQueries({ answers: [...answers] })
  }),
})
