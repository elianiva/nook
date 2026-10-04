/**
 * Home screen: the day's overview plus the deck list.
 *
 * Sections, top to bottom:
 * 1. Due-now hero with a Start action and today's progress
 * 2. Stat row: reviewed today, streak, retention signal
 * 3. 14-day activity strip
 * 4. Deck list (same rows as the Decks page, without search)
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronRight, Flame, Inbox, Play } from 'lucide'
import { badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Empty } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DeckSummary } from '@nook/api'
import { Message } from './model'
import type { Model } from './model'
import { routeToUrl } from './routes'

type Child = Html | string

const dueTone = (due: number): string =>
  due === 0 ? 'text-muted-foreground' : due >= 100 ? 'text-destructive' : 'text-foreground'

const deltaBadge = (delta: number, h: HtmlBuilder<Message>): Html | null => {
  if (delta === 0) return null
  const up = delta > 0
  return badge<Message>(
    { variant: up ? 'destructive' : 'secondary' },
    [`${up ? '+' : ''}${delta} vs yesterday`],
    h,
  )
}

const lastStudied = (deck: DeckSummary): string =>
  Option.match(deck.lastStudiedAt, {
    onNone: () => 'Not studied yet',
    onSome: (at) => {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return 'Not studied yet'
      return `Studied ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    },
  })

export const deckRow = (deck: DeckSummary, h: HtmlBuilder<Message>): Html =>
  h.a(
    [h.Href(routeToUrl({ _tag: 'DeckDetail', deckId: deck.id }))],
    [
      Card<Message>(
        { className: 'p-3 transition-colors hover:border-ring' },
        [
          h.div(
            [h.Class('flex items-center gap-3')],
            [
              h.div(
                [h.Class('flex min-w-0 flex-1 flex-col gap-1')],
                [
                  h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      h.span([h.Class('truncate text-sm font-semibold')], [deck.name]),
                      deltaBadge(deck.dueDelta, h) ?? h.empty,
                    ],
                  ),
                  h.div(
                    [h.Class('text-xs text-muted-foreground')],
                    [`${deck.dueCount} due · ${deck.newCount} new · ${lastStudied(deck)}`],
                  ),
                  Progress<Message>({ value: deck.retention7d, className: 'mt-1' }, h),
                ],
              ),
              h.div(
                [h.Class('flex shrink-0 flex-col items-end gap-1')],
                [
                  h.span(
                    [
                      h.Class(
                        cn('text-xl font-bold tabular-nums leading-none', dueTone(deck.dueCount)),
                      ),
                    ],
                    [String(deck.dueCount)],
                  ),
                  h.span([h.Class('text-[11px] text-muted-foreground')], ['due']),
                  icon(h, ChevronRight, 'size-4 text-muted-foreground'),
                ],
              ),
            ],
          ),
        ],
        h,
      ),
    ],
  )

const hero = (model: Model, h: HtmlBuilder<Message>): Html =>
  Card<Message>(
    { className: 'border-primary/30 bg-gradient-to-b from-primary/10 to-transparent p-4' },
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.span([h.Class('text-xs font-medium text-muted-foreground')], ['Due now']),
          h.div(
            [h.Class('flex items-baseline gap-2')],
            [
              h.span(
                [h.Class('text-4xl font-bold tabular-nums tracking-tight')],
                [String(model.overview.dueNow)],
              ),
              h.span([h.Class('text-sm text-muted-foreground')], ['waiting']),
            ],
          ),
          h.div(
            [h.Class('mt-2 flex items-center gap-2')],
            [
              Progress<Message>({ value: model.overview.todayProgress, className: 'flex-1' }, h),
              h.span(
                [h.Class('text-xs tabular-nums text-muted-foreground')],
                [`${model.overview.todayProgress}%`],
              ),
            ],
          ),
          h.div(
            [h.Class('mt-3 flex gap-2')],
            [
              button<Message>(
                {
                  onClick: Message.StartedDeckReview({ deckId: '' }),
                  size: 'lg',
                  className: 'flex-1',
                },
                [icon(h, Play, 'size-4', 'inline-start'), 'Start reviewing'],
                h,
              ),
            ],
          ),
          h.p(
            [h.Class('text-[11px] text-muted-foreground')],
            ['Review flow is out of scope for this pass — the button is inert.'],
          ),
        ],
      ),
    ],
    h,
  )

const statCell = (label: string, value: string, sub: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex flex-1 flex-col items-center gap-0.5 rounded-lg bg-muted/60 px-2 py-2.5 text-center',
      ),
    ],
    [
      h.span([h.Class('text-lg font-bold tabular-nums leading-none')], [value]),
      h.span([h.Class('text-[11px] font-medium')], [label]),
      h.span([h.Class('text-[10px] text-muted-foreground')], [sub]),
    ],
  )

const stats = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex gap-2')],
    [
      statCell('Reviewed', String(model.overview.reviewedToday), 'today', h),
      statCell('Streak', `${model.overview.streakDays}d`, 'in a row', h),
      statCell(
        'Retention',
        `${model.decks.length === 0 ? 0 : Math.round(model.decks.reduce((sum, deck) => sum + deck.retention7d, 0) / model.decks.length)}%`,
        '7-day avg',
        h,
      ),
    ],
  )

const activity = (model: Model, h: HtmlBuilder<Message>): Html => {
  const max = Math.max(1, ...model.overview.activity14d)
  return Card<Message>(
    {},
    [
      Card.header<Message>(
        {},
        [
          Card.title<Message>({}, ['Activity'], h),
          Card.description<Message>({}, ['Reviews per day, last 14 days'], h),
        ],
        h,
      ),
      Card.content<Message>(
        {},
        [
          h.div(
            [h.Class('flex h-16 items-end gap-1')],
            model.overview.activity14d.map((count, index) =>
              h.div(
                [
                  h.Class(
                    cn(
                      'min-w-0 flex-1 rounded-sm',
                      index === model.overview.activity14d.length - 1
                        ? 'bg-primary'
                        : 'bg-primary/30',
                    ),
                  ),
                  h.Style({ height: `${Math.max(8, Math.round((count / max) * 100))}%` }),
                  h.Title(`${count} reviews`),
                ],
                [],
              ),
            ),
          ),
        ],
        h,
      ),
    ],
    h,
  )
}

const streakNote = (model: Model, h: HtmlBuilder<Message>): Child =>
  model.overview.streakDays >= 7
    ? h.div(
        [
          h.Class(
            'flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs',
          ),
        ],
        [
          icon(h, Flame, 'size-4 text-orange-500'),
          `${model.overview.streakDays}-day streak. Keep it burning.`,
        ],
      )
    : h.empty

export const homeView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => [
  hero(model, h),
  stats(model, h),
  activity(model, h),
  streakNote(model, h),
  h.div(
    [h.Class('flex items-center justify-between')],
    [
      h.h2([h.Class('text-sm font-semibold')], ['Decks']),
      h.a(
        [
          h.Href(routeToUrl({ _tag: 'Decks' })),
          h.Class('text-xs font-medium text-primary hover:underline'),
        ],
        ['View all'],
      ),
    ],
  ),
  ...(model.decks.length === 0
    ? [
        Empty<Message>(
          {},
          [
            Empty.media<Message>({ variant: 'icon' }, [icon(h, Inbox, 'size-4')], h),
            Empty.title<Message>({}, ['No decks yet'], h),
            Empty.description<Message>({}, ['Import an .apkg archive to start reviewing.'], h),
          ],
          h,
        ),
      ]
    : model.decks.map((deck) => deckRow(deck, h))),
]
