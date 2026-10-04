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
import { NAV_TABS, routeTitle, routeToTab, routeToUrl, tabToRoute } from './routes'
import type { NavTab } from './routes'

type Child = Html | string

const tabIcon = { home: House, decks: Layers, settings: Settings } as const
const tabLabel = { home: 'Home', decks: 'Decks', settings: 'Settings' } as const

const showBack = (model: Model): boolean =>
  model.route._tag === 'DeckDetail' || model.route._tag === 'NotFound'

const backHref = (model: Model): string =>
  model.route._tag === 'DeckDetail' ? routeToUrl({ _tag: 'Decks' }) : routeToUrl({ _tag: 'Home' })

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
                    'flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground',
                  ),
                  h.AriaLabel('Back'),
                ],
                [icon(h, ArrowLeft, 'size-4')],
              )
            : h.div(
                [
                  h.Class(
                    'flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground',
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
          'flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium',
          active ? 'text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
        [h.Class('mx-auto flex w-full max-w-md items-stretch gap-1 px-3 py-1.5')],
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

/** The shell frame. `content` is the active screen. */
export const shell = (model: Model, content: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex min-h-svh flex-col bg-background text-foreground')],
    [
      topBar(model, h),
      h.main(
        [h.Class('mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 py-4')],
        [noticeBanner(model, h), ...content],
      ),
      bottomNav(model, h),
    ],
  )
