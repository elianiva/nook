/**
 * The page-slide view transition: direction between tab pages, and which
 * renders the runtime wraps in `document.startViewTransition`.
 */

import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import type { Url } from 'foldkit/url'
import { DeckId } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import { AppRoute } from '../src/app/routes'
import { transitionDirection, viewTransition } from '../src/app/view-transition'

const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const deckDetail = (id: string) => AppRoute.DeckDetail({ deckId: DeckId.make(id) })

describe('transitionDirection', () => {
  it('slides forward across home, decks, settings', () => {
    expect(transitionDirection(AppRoute.Home({}), AppRoute.Decks({}))).toBe('forward')
    expect(transitionDirection(AppRoute.Decks({}), AppRoute.Settings({}))).toBe('forward')
    expect(transitionDirection(AppRoute.Home({}), AppRoute.Settings({}))).toBe('forward')
  })

  it('slides backward down the tab order', () => {
    expect(transitionDirection(AppRoute.Settings({}), AppRoute.Decks({}))).toBe('backward')
    expect(transitionDirection(AppRoute.Decks({}), AppRoute.Home({}))).toBe('backward')
    expect(transitionDirection(AppRoute.Settings({}), AppRoute.Home({}))).toBe('backward')
  })

  it('stays plain inside one tab', () => {
    expect(transitionDirection(AppRoute.Home({}), AppRoute.Home({}))).toBeUndefined()
    // DeckDetail and Review map to the decks tab, like Decks itself.
    expect(transitionDirection(AppRoute.Decks({}), deckDetail('deck-a'))).toBeUndefined()
    expect(
      transitionDirection(AppRoute.Review({}), AppRoute.ReviewDeck({ deckId: DeckId.make('d') })),
    ).toBeUndefined()
  })
})

describe('viewTransition', () => {
  it('tags cross-tab renders with the slide direction', () => {
    const previous = seedModel(url('/'))
    const next = seedModel(url('/decks'))
    expect(
      viewTransition({
        previousModel: previous,
        model: next,
        message: Message.ChangedUrl({ url: url('/decks') }),
      }),
    ).toEqual({ types: ['slide-forward'] })

    const back = seedModel(url('/settings'))
    const home = seedModel(url('/'))
    expect(
      viewTransition({
        previousModel: back,
        model: home,
        message: Message.ChangedUrl({ url: url('/') }),
      }),
    ).toEqual({ types: ['slide-backward'] })
  })

  it('renders same-tab updates plainly', () => {
    const model = seedModel(url('/decks'))
    expect(
      viewTransition({
        previousModel: model,
        model,
        message: Message.ChangedUrl({ url: url('/decks') }),
      }),
    ).toBe(false)
  })
})
