/**
 * App-level Messages: navigation, Query folds, hints, and the service worker.
 */

import { Option } from 'effect'
import { Navigation } from 'foldkit'
import { LoadAccountPage, NavigateInternal } from '../commands'
import { ReloadApp } from '../api-commands'
import { foldHintMessage } from '../hints'
import { idleDeckManage, idleReview } from '../model'
import { urlToAppRoute } from '../routes'
import { focusAfter } from './focus'
import {
  deckDetail,
  decks,
  overview,
  revalidateVisible,
  routeLoads,
  seedCachedQueries,
} from './loads'
import { clearNotice } from './notice'
import { defineHandlers } from './handlers'

export const appHandlers = defineHandlers((model) => ({
  ClickedLink: ({ request }) =>
    Navigation.UrlRequest.match(request, {
      Internal: ({ url }) =>
        // The account page is not a Foldkit route: load it as a full page.
        url.pathname === '/account'
          ? { model, commands: [LoadAccountPage({ path: '/account' })] }
          : { model, commands: [NavigateInternal({ url })] },
      External: () => ({ model }),
    }),

  ChangedUrl: ({ url }) => {
    const route = urlToAppRoute(url)
    // A new screen means new loads; the old notice and the old review session
    // belong to the old screen. The Manage draft belongs to one Deck, so it
    // resets too — a stale name must never leak onto another deck's page.
    return focusAfter(
      routeLoads({
        ...clearNotice(model),
        route,
        review: idleReview,
        deckManage: idleDeckManage,
        cardSuspensionPending: Option.none(),
        cardSuspensionError: Option.none(),
        cardHistoryCard: Option.none(),
        cardHistoryLoading: false,
        cardHistory: [],
        cardHistoryTotal: 0,
        cardHistoryError: Option.none(),
      }),
      // A new screen starts at its top: keyboard focus and the screen reader
      // follow the route change instead of staying on the link that is gone.
      '#main-content',
    )
  },

  CompletedNavigate: () => ({ model }),

  GotOverviewMessage: ({ message }) => overview.fold(model, message),

  GotDecksMessage: ({ message }) => decks.fold(model, message),

  GotDeckDetailMessage: ({ message }) => deckDetail.fold(model, message),

  ClickedRetryOverview: () => overview.revalidateOrLoad(model),

  ClickedRetryDecks: () => decks.revalidateOrLoad(model),

  ClickedRetryDeckDetail: ({ deckId }) => deckDetail.revalidateOrLoad(model, { deckId }),

  // Hover or focus on a deck link: warm the detail Query while it is still
  // missing. `loadIfMissing` starts nothing when data or a request is there.
  PrefetchedDeckDetail: ({ deckId }) => deckDetail.loadIfMissing(model, { deckId }),

  CompletedFocus: () => ({ model }),

  // Cached list answers reseed their Queries as `Success`, so a cold boot
  // offline shows the last data at once. The route loads already started
  // move each Query to `Refreshing` when they run; a seed that arrives
  // after a fetch completed only fills Queries still `Idle`, so a fresh
  // answer never loses to an older cache.
  RestoredCachedQueries: ({ answers }) => ({ model: seedCachedQueries(model, answers) }),

  // The tab became visible, or the entry above fired: refresh what is shown.
  RevalidateVisible: () => revalidateVisible(model),

  AppliedSwUpdate: () => ({ model }),

  ClickedReloadApp: () => ({ model, commands: [ReloadApp()] }),

  // A newer shell waits in the worker. The banner offers the reload; the
  // learner takes it when no review is in flight — never forced.
  ServiceWorkerAvailable: () => ({ model: { ...model, swUpdateReady: true } }),

  GotHintMessage: ({ slot, message }) => foldHintMessage(model, slot, message),
}))
