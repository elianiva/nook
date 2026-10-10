/**
 * Home screen: the day's overview plus the deck list.
 *
 * Sections, top to bottom:
 * 1. Due-now hero with a Start action and today's progress
 * 2. Stat row: reviewed today, streak, retention signal
 * 3. 14-day activity strip
 * 4. Deck list (same rows as the Decks page, without search)
 */

import { AsyncData } from 'foldkit'
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronRight, Flame, Inbox, Play } from 'lucide'
import { Empty } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DeckSummary, Overview } from '@nook/api'
import { errorPanel, loadingHero, loadingRows } from './load-state'
import { Message } from './model'
import type { Model } from './model'
import { decksQuery, overviewQuery } from './queries'
import { routeToUrl } from './routes'

type Child = Html | string

const dueTone = (due: number): string =>
  due === 0 ? 'text-muted-foreground' : due >= 100 ? 'text-destructive' : 'text-foreground'

export const lastStudied = (deck: DeckSummary): string =>
  Option.match(deck.lastStudiedAt, {
    onNone: () => 'Not studied yet',
    onSome: (at) => {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return 'Not studied yet'
      return `Studied ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    },
  })

export const deckRow = (deck: DeckSummary, h: HtmlBuilder<Message>): Html => {
  const initial = deck.name.trim().charAt(0) || '?'
  return h.a(
    [
      h.Href(routeToUrl({ _tag: 'DeckDetail', deckId: deck.id })),
      // Hover and keyboard focus warm the detail Query, so the deck page
      // opens with data while its refresh runs.
      h.OnMouseEnter(Message.PrefetchedDeckDetail({ deckId: deck.id })),
      h.OnFocus(Message.PrefetchedDeckDetail({ deckId: deck.id })),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-3 rounded-[14px] border-0 bg-[var(--theme-block)] p-3')],
        [
          h.div(
            [
              h.Class(
                'flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-[17px] font-bold text-[var(--theme-ink)]',
              ),
            ],
            [initial],
          ),
          h.div(
            [h.Class('flex min-w-0 flex-1 flex-col gap-1')],
            [
              h.div(
                [h.Class('flex items-center gap-2')],
                [h.span([h.Class('truncate text-sm font-semibold')], [deck.name])],
              ),
              h.div(
                [h.Class('text-xs text-[var(--theme-sub)]')],
                [`${deck.dueToday} due today · ${deck.newToday} new today · ${lastStudied(deck)}`],
              ),
              Progress<Message>(
                {
                  value: deck.retention7d,
                  className: 'mt-1 [&_[data-slot=progress-track]]:bg-[var(--theme-bar-idle)]',
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('flex shrink-0 flex-col items-end gap-1')],
            [
              h.span(
                [
                  h.Class(
                    cn('text-xl font-bold tabular-nums leading-none', dueTone(deck.dueToday)),
                  ),
                ],
                [String(deck.dueToday)],
              ),
              h.span([h.Class('text-[11px] text-[var(--theme-sub)]')], ['due today']),
              icon(h, ChevronRight, 'size-4 text-[var(--theme-sub)]'),
            ],
          ),
        ],
      ),
    ],
  )
}

const hero = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('rounded-[20px] border-0 bg-[var(--theme-hero)] p-[18px] text-[var(--theme-ink)]')],
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.span(
            [h.Class('text-xs font-bold tracking-[1.6px] text-[var(--theme-kicker)] uppercase')],
            ['To study · All decks'],
          ),
          h.div(
            [h.Class('flex items-baseline gap-2')],
            [
              h.span(
                [h.Class('text-[52px] leading-[1.05] font-bold tabular-nums tracking-tight')],
                [String(overview.dueNow + overview.newToday)],
              ),
              h.span([h.Class('text-sm')], [`${overview.dueNow} due · ${overview.newToday} new`]),
            ],
          ),
          h.div(
            [h.Class('mt-2 flex items-center gap-2')],
            [
              Progress<Message>(
                {
                  value: overview.todayProgress,
                  className:
                    'flex-1 [&_[data-slot=progress-indicator]]:bg-[var(--theme-ink)] [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-[var(--theme-track)]',
                },
                h,
              ),
              h.span([h.Class('text-xs tabular-nums')], [`${overview.todayProgress}%`]),
            ],
          ),
          h.div(
            [h.Class('mt-3 flex gap-2')],
            [
              button<Message>(
                {
                  onClick: Message.StartedReview({ deckId: Option.none() }),
                  size: 'xl',
                  className:
                    'flex-1 border-0 bg-[var(--theme-ink)] text-[15px] font-bold text-white',
                },
                [icon(h, Play, 'size-4', 'inline-start'), 'Start reviewing'],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  )

const statCell = (label: string, value: string, sub: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex flex-1 flex-col items-center gap-0.5 rounded-[14px] border-0 bg-[var(--theme-block)] px-2 py-2.5 text-center',
      ),
    ],
    [
      h.span([h.Class('text-lg font-bold tabular-nums leading-none')], [value]),
      h.span([h.Class('text-[11px] font-medium')], [label]),
      h.span([h.Class('text-[10px] text-[var(--theme-sub)]')], [sub]),
    ],
  )

const stats = (overview: Overview, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex gap-2')],
    [
      statCell('Reviewed', String(overview.reviewedToday), 'today', h),
      statCell('Streak', `${overview.streakDays}d`, 'in a row', h),
      statCell('Retention', `${overview.retention7d}%`, '7-day avg', h),
    ],
  )

const activity = (overview: Overview, h: HtmlBuilder<Message>): Html => {
  const max = Math.max(1, ...overview.activity14d)
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.span(
        [h.Class('text-[11px] font-bold tracking-[1.8px] text-[var(--theme-sub)] uppercase')],
        ['Activity · Last 14 days'],
      ),
      h.div(
        [h.Class('rounded-[14px] border-0 bg-[var(--theme-block)] p-[14px]')],
        [
          h.div(
            [h.Class('flex h-16 items-end gap-1')],
            overview.activity14d.map((count, index) =>
              h.div(
                [
                  h.Class('min-w-0 flex-1 rounded-full'),
                  h.Style({
                    height: `${Math.max(8, Math.round((count / max) * 100))}%`,
                    backgroundColor:
                      index === overview.activity14d.length - 1
                        ? 'var(--theme-tint)'
                        : 'var(--theme-bar-idle)',
                    minHeight: '5px',
                  }),
                  h.Title(`${count} reviews`),
                ],
                [],
              ),
            ),
          ),
        ],
        // h.div children: the bar strip only
      ),
    ],
  )
}

const streakNote = (overview: Overview, h: HtmlBuilder<Message>): Child =>
  overview.streakDays >= 7
    ? h.div(
        [
          h.Class(
            'flex items-center gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] px-3 py-2 text-xs font-semibold',
          ),
        ],
        [
          icon(h, Flame, 'size-4 text-[var(--theme-strong)]'),
          h.span(
            [],
            [
              h.span(
                [h.Class('font-bold text-[var(--theme-strong)]')],
                [`${overview.streakDays}-day streak`],
              ),
              '. Keep it burning.',
            ],
          ),
        ],
      )
    : h.empty

const emptyDecks = (h: HtmlBuilder<Message>): Html =>
  Empty<Message>(
    {},
    [
      Empty.media<Message>({ variant: 'icon' }, [icon(h, Inbox, 'size-4')], h),
      Empty.title<Message>({}, ['No decks yet'], h),
      Empty.description<Message>({}, ['Import an .apkg archive to start reviewing.'], h),
    ],
    h,
  )

const deckList = (
  decks: ReadonlyArray<DeckSummary>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> =>
  decks.length === 0 ? [emptyDecks(h)] : decks.map((deck) => deckRow(deck, h))

export const homeView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const overviewAsync = overviewQuery.read(model.overview)
  const decksAsync = decksQuery.read(model.decks)
  return [
    ...AsyncData.matchData(overviewAsync, {
      onEmpty: () => [loadingHero('Loading the overview…', h)],
      onFailure: (error) => [errorPanel(error, Message.ClickedRetryOverview(), h)],
      onData: (overview) => [
        hero(overview, h),
        stats(overview, h),
        activity(overview, h),
        streakNote(overview, h),
      ],
    }),
    h.div(
      [h.Class('flex items-center justify-between')],
      [
        h.h2([h.Class('text-sm font-semibold')], ['Decks']),
        h.a(
          [
            h.Href(routeToUrl({ _tag: 'Decks' })),
            h.Class('text-xs font-medium text-[var(--theme-strong)] hover:underline'),
          ],
          ['View all'],
        ),
      ],
    ),
    ...AsyncData.matchData(decksAsync, {
      onEmpty: () => [loadingRows('Loading decks…', h)],
      onFailure: (error) => [errorPanel(error, Message.ClickedRetryDecks(), h)],
      onData: (list) => deckList(list, h),
    }),
  ]
}
