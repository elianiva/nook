/**
 * Shared shell: the mobile-first frame every screen renders inside.
 *
 * A narrow column (`max-w-md`) centres on larger screens, so the desktop
 * layout derives from the mobile design instead of the other way round.
 * The top bar names the screen; the bottom bar holds the three tabs
 * (Home, Decks, Settings) with the active tab marked.
 */

import type { Html, HtmlBuilder } from 'foldkit/html'
import { ArrowLeft, CircleAlert, House, Layers, RotateCcw, Settings } from 'lucide'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { button } from '@/components/ui/button'
import { Option } from 'effect'
import { Message } from './model'
import type { Model } from './model'
import { AppRoute, NAV_TABS, routeTitle, routeToTab, routeToUrl, tabToRoute } from './routes'
import type { NavTab } from './routes'

type Child = Html | string

const tabIcon = { home: House, decks: Layers, settings: Settings } as const
const tabLabel = { home: 'Home', decks: 'Decks', settings: 'Settings' } as const

const showBack = (model: Model): boolean =>
  model.route._tag === 'DeckDetail' ||
  model.route._tag === 'Review' ||
  model.route._tag === 'ReviewDeck' ||
  model.route._tag === 'NotFound'

const backHref = (model: Model): string =>
  AppRoute.match(model.route, {
    DeckDetail: () => routeToUrl({ _tag: 'Decks' }),
    ReviewDeck: ({ deckId }) => routeToUrl({ _tag: 'DeckDetail', deckId }),
    Review: () => routeToUrl({ _tag: 'Decks' }),
    Home: () => routeToUrl({ _tag: 'Home' }),
    Decks: () => routeToUrl({ _tag: 'Home' }),
    Settings: () => routeToUrl({ _tag: 'Home' }),
    NotFound: () => routeToUrl({ _tag: 'Home' }),
  })

const topBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur')],
    [
      h.div(
        [h.Class('mx-auto flex h-12 w-full max-w-md items-center gap-1 px-3')],
        [
          showBack(model)
            ? h.a(
                [
                  h.Href(backHref(model)),
                  h.Class(
                    'flex size-8 items-center justify-center rounded-lg text-[var(--theme-sub)] hover:bg-[var(--theme-block)]',
                  ),
                  h.AriaLabel('Back'),
                ],
                [icon(h, ArrowLeft, 'size-4')],
              )
            : h.div(
                [
                  h.Class(
                    'flex size-8 items-center justify-center rounded-lg bg-[var(--theme-ink)] text-white',
                  ),
                ],
                [icon(h, House, 'size-4')],
              ),
          h.div(
            [h.Class('flex flex-col leading-tight')],
            [
              h.span([h.Class('text-sm font-semibold')], [routeTitle(model.route)]),
              h.span([h.Class('text-[11px] text-muted-foreground')], ['nook']),
            ],
          ),
        ],
      ),
    ],
  )

const tabLink = (model: Model, tab: NavTab, h: HtmlBuilder<Message>): Html => {
  const active = routeToTab(model.route) === tab
  return h.a(
    [
      h.Href(routeToUrl(tabToRoute(tab))),
      h.Class(
        cn(
          'flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[11px] font-medium',
          active
            ? 'text-[var(--theme-strong)]'
            : 'text-[var(--theme-nav-idle)] hover:bg-[var(--theme-block)]',
        ),
      ),
      ...(active ? [h.AriaCurrent('page')] : []),
    ],
    [icon(h, tabIcon[tab], 'size-4'), tabLabel[tab]],
  )
}

const bottomNav = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.Class('sticky bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur'),
      h.AriaLabel('Sections'),
    ],
    [
      h.div(
        [h.Class('mx-auto flex w-full max-w-md items-stretch gap-1 px-3 pt-1.5 pb-nav')],
        NAV_TABS.map((tab) => tabLink(model, tab, h)),
      ),
    ],
  )

/** The last failed fetch or save, with a retry that runs it again. Clears on the next answer. */
const noticeBanner = (model: Model, h: HtmlBuilder<Message>): Child =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.Class(
            'flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2',
          ),
          h.Role('alert'),
        ],
        [
          icon(h, CircleAlert, 'size-4 shrink-0 text-destructive'),
          h.span([h.Class('min-w-0 flex-1 text-xs text-destructive')], [notice.message]),
          button<Message>(
            {
              onClick: Message.ClickedRetry(),
              variant: 'outline',
              size: 'sm',
              attributes: [h.AriaLabel('Retry')],
            },
            [icon(h, RotateCcw, 'size-3.5'), 'Retry'],
            h,
          ),
        ],
      ),
  })

/**
 * Review owns the whole screen: the tab bar and the page padding step aside so
 * the grade bar sits under the thumb, and the Card fills the space between.
 */
const isFocused = (model: Model): boolean =>
  model.route._tag === 'Review' || model.route._tag === 'ReviewDeck'

/** The shell frame. `content` is the active screen. */
export const shell = (
  model: Model,
  content: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html => {
  const focused = isFocused(model)
  return h.div(
    // A fixed viewport height, so the bars stay put and only the content
    // between them scrolls. On a phone that keeps the actions under the thumb
    // instead of below a long page.
    [h.Class('flex h-dvh flex-col bg-background text-foreground')],
    [
      topBar(model, h),
      h.main(
        [
          h.Class(
            cn(
              'mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col',
              // Every screen child keeps its own height: without `shrink-0`
              // a flex column squeezes its children below their content
              // height when the page is taller than the viewport, and cards
              // with `overflow-hidden` slice their text mid-line instead of
              // scrolling. (Review manages its own flex children, so it is
              // exempt.)
              focused ? 'gap-0 overflow-hidden' : 'gap-4 overflow-y-auto px-3 py-4 [&>*]:shrink-0',
            ),
          ),
        ],
        focused
          ? Option.isSome(model.notice)
            ? [h.div([h.Class('px-3 pt-3')], [noticeBanner(model, h)]), ...content]
            : [...content]
          : [noticeBanner(model, h), ...content],
      ),
      ...(focused ? [] : [bottomNav(model, h)]),
    ],
  )
}
