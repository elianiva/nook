/**
 * Route loads and the lifted Queries: what each screen starts, and what revalidates when it returns.
 */

import { HashMap, Option } from 'effect'
import { Update } from 'foldkit'
import { AsyncData } from 'foldkit'
import type { DeckId } from '@nook/api'
import {
  FetchFsrsDiagnostics,
  FetchReviewQueue,
  FetchSettings,
  LoadCachedQueue,
} from '../api-commands'
import type { RestoredAnswer } from '../model'
import { Message, idleReview } from '../model'
import type { Model } from '../model'
import { deckDetailQuery, decksQuery, overviewQuery } from '../queries'
import { AppRoute } from '../routes'
import { deckDetailKey } from './deck-cache'

/**
 * The parent side of each Query: `lift` binds a Query's Model field and its
 * Messages to this app's Model and Message types.
 */
export const overview = overviewQuery.lift<Model, Message>({
  parentField: 'overview',
  toParentMessage: (message) => Message.GotOverviewMessage({ message }),
})

export const decks = decksQuery.lift<Model, Message>({
  parentField: 'decks',
  toParentMessage: (message) => Message.GotDecksMessage({ message }),
})

export const deckDetail = deckDetailQuery.lift<Model, Message>({
  parentField: 'deckDetail',
  toParentMessage: (message) => Message.GotDeckDetailMessage({ message }),
})

export const reviewRouteLoads = (
  model: Model,
  deckId: Option.Option<DeckId>,
): Update.Return<Model, Message> => {
  const sessionId = crypto.randomUUID()
  return {
    model: { ...model, review: { ...idleReview, queueSessionId: sessionId } },
    commands: [
      LoadCachedQueue({ deckId, sessionId }),
      FetchReviewQueue({ deckId, bypassDueLimit: false, sessionId }),
      FetchSettings(),
    ],
  }
}

/**
 * The reads a route starts. A Query loads when it is missing and refreshes when
 * it has data, so returning to a screen shows its last answer while a fresh one
 * arrives; the already-pending case starts nothing. Settings and the review
 * queue stay out of the Query cache: the settings form and the review session
 * own their own transitions.
 */
export const routeLoads = (model: Model): Update.Return<Model, Message> =>
  AppRoute.match<Update.Return<Model, Message>>(model.route, {
    Home: () =>
      Update.combine<Model, Message>(model, [overview.revalidateOrLoad, decks.revalidateOrLoad]),
    Decks: () => decks.revalidateOrLoad(model),
    DeckDetail: ({ deckId }) => deckDetail.revalidateOrLoad(model, { deckId }),
    Review: () => reviewRouteLoads(model, Option.none()),
    ReviewDeck: ({ deckId }) => reviewRouteLoads(model, Option.some(deckId)),
    Settings: () => ({
      model: {
        ...model,
        fsrsDiagnosticsLoading: true,
        fsrsDiagnosticsError: Option.none(),
      },
      commands: [FetchSettings(), FetchFsrsDiagnostics()],
    }),
    NotFound: () => ({ model }),
  })

/**
 * The queries the current route shows, refreshed. Review and settings own
 * their reads, so only the list and detail Queries revalidate here; the
 * grade flush in `RegainedNetwork` is untouched.
 */
export const revalidateVisible = (model: Model): Update.Return<Model, Message> =>
  AppRoute.match<Update.Return<Model, Message>>(model.route, {
    Home: () => Update.combine<Model, Message>(model, [overview.revalidate, decks.revalidate]),
    Decks: () => decks.revalidate(model),
    DeckDetail: ({ deckId }) => deckDetail.revalidate(model, { deckId }),
    Review: () => ({ model }),
    ReviewDeck: () => ({ model }),
    Settings: () => ({ model }),
    NotFound: () => ({ model }),
  })

/**
 * Folds restored answers into their Query Models as `Success`.
 *
 * Only `Idle` Queries take the seed: a fetch that already completed holds
 * fresher data, and a request in flight keeps its `Loading`/`Refreshing`
 * state so the generation guard still matches its answer. Deck-detail
 * entries key on the encoded args, the same key `read` resolves.
 */
export const seedCachedQueries = (model: Model, answers: ReadonlyArray<RestoredAnswer>): Model => {
  let next = model
  for (const answer of answers) {
    if (answer.kind === 'overview') {
      if (AsyncData.isIdle(overviewQuery.read(next.overview))) {
        next = { ...next, overview: { ...next.overview, data: AsyncData.succeed(answer.value) } }
      }
    } else if (answer.kind === 'decks') {
      if (AsyncData.isIdle(decksQuery.read(next.decks))) {
        next = { ...next, decks: { ...next.decks, data: AsyncData.succeed(answer.value) } }
      }
    } else {
      if (!AsyncData.isIdle(deckDetailQuery.read(next.deckDetail, { deckId: answer.deckId }))) {
        continue
      }
      // Single-field args encode to one JSON object with sorted keys, which
      // `JSON.stringify` matches: no key ordering to canonicalize.
      const key = deckDetailKey(answer.deckId)
      next = {
        ...next,
        deckDetail: {
          ...next.deckDetail,
          entries: HashMap.set(next.deckDetail.entries, key, {
            args: { deckId: answer.deckId },
            data: AsyncData.succeed(answer.value),
            generation: next.deckDetail.generation,
          }),
        },
      }
    }
  }
  return next
}
