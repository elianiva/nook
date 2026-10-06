/**
 * Shared shell: the mobile-first frame every screen renders inside.
 *
 * A narrow column (`max-w-md`) centres on larger screens, so the desktop
 * layout derives from the mobile design instead of the other way round.
 * The top bar is a bare wordmark row — the `nook` mark, the screen name,
 * and a live tint chip — with no border, so it reads as part of the page
 * instead of browser chrome. The bottom bar holds the three tabs
 * (Home, Decks, Settings) as quiet uppercase labels; the active tab alone
 * wears the theme tint.
 */

import { AsyncData } from 'foldkit'
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
import { deckDetailQuery, decksQuery, overviewQuery } from './queries'

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

/**
 * The live chip in the top bar. On Home it names the due count; on a deck
 * page it names that deck's due-plus-new total; elsewhere it wears the
 * streak. Nothing renders until the Query backing the chip has data, so a
 * loading screen keeps a bare wordmark row instead of a wrong number.
 */
const topChip = (model: Model): string | undefined =>
  AppRoute.match(model.route, {
    Home: () =>
      Option.match(AsyncData.getData(overviewQuery.read(model.overview)), {
        onNone: () => undefined,
        onSome: (overview) => `${overview.dueNow} due`,
      }),
    Decks: () =>
      Option.match(AsyncData.getData(decksQuery.read(model.decks)), {
        onNone: () => undefined,
        onSome: (decks) => `${decks.reduce((sum, deck) => sum + deck.dueCount, 0)} due`,
      }),
    DeckDetail: ({ deckId }) =>
      Option.match(AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })), {
        onNone: () => undefined,
        onSome: (detail) => `${detail.summary.dueCount + detail.summary.newCount} to review`,
      }),
    Review: () =>
      Option.match(AsyncData.getData(overviewQuery.read(model.overview)), {
        onNone: () => undefined,
        onSome: (overview) => `${overview.dueNow} due`,
      }),
    ReviewDeck: ({ deckId }) => topChip({ ...model, route: AppRoute.DeckDetail({ deckId }) }),
    Settings: () =>
      Option.match(AsyncData.getData(overviewQuery.read(model.overview)), {
        onNone: () => undefined,
        onSome: (overview) =>
          overview.streakDays < 2 ? undefined : `${overview.streakDays}-day streak`,
      }),
    NotFound: () => undefined,
  })

/** The screen name in the top bar: the deck's name on its pages, the route name elsewhere. */
const topTitle = (model: Model): string =>
  AppRoute.match(model.route, {
    Home: () => routeTitle(model.route),
    Decks: () => routeTitle(model.route),
    DeckDetail: ({ deckId }) =>
      Option.match(AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })), {
        onNone: () => routeTitle(model.route),
        onSome: (detail) => detail.summary.name,
      }),
    Review: () => routeTitle(model.route),
    ReviewDeck: ({ deckId }) =>
      Option.match(AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })), {
        onNone: () => routeTitle(model.route),
        onSome: (detail) => detail.summary.name,
      }),
    Settings: () => routeTitle(model.route),
    NotFound: () => routeTitle(model.route),
  })

const topChrome = (model: Model, h: HtmlBuilder<Message>): Html => {
  const chip = topChip(model)
  return h.div(
    [h.Class('mx-auto flex w-full max-w-md items-center gap-2 px-3 pt-3')],
    [
      showBack(model)
        ? h.a(
            [
              h.Href(backHref(model)),
              h.Class(
                'flex size-9 items-center justify-center rounded-full bg-[var(--theme-block)] text-[var(--theme-ink)]',
              ),
              h.AriaLabel('Back'),
            ],
            [icon(h, ArrowLeft, 'size-4')],
          )
        : h.div(
            [
              h.Class(
                'flex h-9 items-center rounded-lg bg-[var(--theme-ink)] px-2.5 text-[13px] font-extrabold tracking-tight text-white',
              ),
            ],
            ['nook'],
          ),
      h.div(
        [h.Class('flex min-w-0 flex-1 flex-col leading-tight')],
        [
          h.span(
            [h.Class('truncate text-[17px] font-extrabold tracking-tight')],
            [topTitle(model)],
          ),
          h.span([h.Class('text-[11px] font-medium text-[var(--theme-sub)]')], [topSub(model)]),
        ],
      ),
      ...(chip === undefined
        ? []
        : [
            h.span(
              [
                h.Class(
                  'shrink-0 rounded-lg bg-[var(--theme-hero)] px-2.5 py-1.5 text-[11px] font-extrabold text-[var(--theme-ink)] tabular-nums',
                ),
              ],
              [chip],
            ),
          ]),
    ],
  )
}

/** The muted line under the screen name: the date on Home, the deck totals elsewhere. */
const topSub = (model: Model): string =>
  AppRoute.match(model.route, {
    Home: () => {
      const date = new Date().toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
      return Option.match(AsyncData.getData(overviewQuery.read(model.overview)), {
        onNone: () => date,
        onSome: (overview) => `${date} · ${overview.reviewedToday} reviewed`,
      })
    },
    Decks: () =>
      Option.match(AsyncData.getData(decksQuery.read(model.decks)), {
        onNone: () => 'Every deck in one place',
        onSome: (decks) => `${decks.length} ${decks.length === 1 ? 'deck' : 'decks'} in one place`,
      }),
    DeckDetail: ({ deckId }) =>
      Option.match(AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })), {
        onNone: () => 'Deck',
        onSome: (detail) =>
          `${detail.summary.dueCount} due · ${detail.summary.newCount} new · ${detail.summary.totalCount} total`,
      }),
    Review: () => 'Grade honestly — FSRS does the rest',
    ReviewDeck: ({ deckId }) =>
      Option.match(AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })), {
        onNone: () => 'Grade honestly — FSRS does the rest',
        onSome: (detail) => detail.summary.name,
      }),
    Settings: () => 'FSRS, deck defaults, behaviour',
    NotFound: () => 'Nothing lives here',
  })

const tabLink = (model: Model, tab: NavTab, h: HtmlBuilder<Message>): Html => {
  const active = routeToTab(model.route) === tab
  return h.a(
    [
      h.Href(routeToUrl(tabToRoute(tab))),
      h.Class(
        cn(
          'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-full py-2.5 text-[11px] font-extrabold tracking-[1.2px] uppercase transition-colors duration-200',
          active ? 'text-[var(--theme-strong)]' : 'text-[var(--theme-nav-idle)]',
        ),
      ),
      ...(active ? [h.AriaCurrent('page')] : []),
    ],
    [icon(h, tabIcon[tab], 'size-5'), tabLabel[tab].toUpperCase()],
  )
}

/**
 * Floating segmented tab bar: a solid `--theme-block` track with one shared
 * white pill that slides under the active tab (`transition-[left]`), floating
 * over a soft bottom fade so content melts underneath instead of ending at a
 * block. Tabs are transparent icon-plus-label rows above the pill; only their
 * colour marks the active one.
 */
const bottomNav = (model: Model, h: HtmlBuilder<Message>): Html => {
  const activeIndex = NAV_TABS.indexOf(routeToTab(model.route))
  return h.nav(
    [
      h.AriaLabel('Sections'),
      h.Class(
        'pointer-events-none absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-background via-background/85 to-transparent px-4 pt-8 pb-safe',
      ),
    ],
    [
      h.div(
        [
          h.Class(
            'pointer-events-auto relative mx-auto flex w-full max-w-md items-center rounded-[24px] bg-[var(--theme-block)] p-1.5',
          ),
        ],
        [
          h.span(
            [
              h.Class(
                'absolute top-1.5 bottom-1.5 rounded-full bg-white transition-[left] duration-300 ease-out motion-reduce:transition-none',
              ),
              h.Style({
                left: `calc(6px + ${activeIndex} * (100% - 12px) / 3)`,
                width: 'calc((100% - 12px) / 3)',
              }),
              h.AriaHidden(true),
            ],
            [],
          ),
          ...NAV_TABS.map((tab) => tabLink(model, tab, h)),
        ],
      ),
    ],
  )
}

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
    // instead of below a long page. The bottom tab bar floats over the
    // content, so the main column carries extra bottom padding and the last
    // card can scroll clear of the pill.
    [h.Class('relative flex h-dvh flex-col bg-background text-foreground')],
    [
      topChrome(model, h),
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
              focused
                ? 'gap-0 overflow-hidden'
                : 'gap-4 overflow-y-auto px-3 pt-4 pb-28 [&>*]:shrink-0',
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
