/**
 * Route definitions. One Route per screen, parsed from the URL and built
 * back into URLs from the same definition (bidirectional).
 *
 * Screens:
 * - `/` — Home: overview plus the deck list
 * - `/decks` — Decks: the full deck list as its own page
 * - `/decks/:deckId` — one Deck: summary plus scheduling-state table
 * - `/settings` — Settings: FSRS, deck defaults, behaviour
 * - anything else — NotFound
 */

import { Schema as S, pipe } from 'effect'
import { defineRouteUnion, int, literal, root, slash, string } from 'foldkit/route'
import * as Route from 'foldkit/route'
import { DeckId } from '@nook/api'
import { Url } from 'foldkit/url'

export const AppRoute = defineRouteUnion({
  Home: {},
  Decks: {},
  DeckDetail: { deckId: DeckId },
  Settings: {},
  NotFound: { path: S.String },
})
export type AppRoute = typeof AppRoute.Type

const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))

const decksRouter = pipe(Route.literal('decks'), Route.mapTo(AppRoute.Decks))

const deckDetailRouter = pipe(
  Route.literal('decks'),
  Route.slash(Route.schemaSegment('deckId', DeckId)),
  Route.mapTo(AppRoute.DeckDetail),
)

const settingsRouter = pipe(Route.literal('settings'), Route.mapTo(AppRoute.Settings))

const routeParser = Route.oneOf(deckDetailRouter, decksRouter, settingsRouter, homeRouter)

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)

/** Build a URL string for a Route. Used for links and post-save redirects. */
export const routeToUrl = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: () => homeRouter.build({}),
    Decks: () => decksRouter.build({}),
    DeckDetail: ({ deckId }) => deckDetailRouter.build({ deckId }),
    Settings: () => settingsRouter.build({}),
    NotFound: ({ path }) => path,
  })

export const routeTitle = (route: AppRoute): string =>
  AppRoute.match(route, {
    Home: () => 'Home',
    Decks: () => 'Decks',
    DeckDetail: () => 'Deck',
    Settings: () => 'Settings',
    NotFound: () => 'Not found',
  })

/** Tabs that appear in the bottom navigation. Home, Decks, Settings. */
export const NAV_TABS = ['home', 'decks', 'settings'] as const
export type NavTab = (typeof NAV_TABS)[number]

export const routeToTab = (route: AppRoute): NavTab =>
  AppRoute.match(route, {
    Home: () => 'home' as NavTab,
    Decks: () => 'decks' as NavTab,
    DeckDetail: () => 'decks' as NavTab,
    Settings: () => 'settings' as NavTab,
    NotFound: () => 'home' as NavTab,
  })

export const tabToRoute = (tab: NavTab): AppRoute =>
  tab === 'decks'
    ? AppRoute.Decks({})
    : tab === 'settings'
      ? AppRoute.Settings({})
      : AppRoute.Home({})

export { Url }
export { root, literal, slash, string, int }
