/**
 * Deck page: one Deck's summary plus its scheduling-state table.
 *
 * The header carries the counts and a Start action; the table lists the
 * Deck's Cards as scheduling rows (state, due, stability, difficulty) —
 * never prompt/answer bodies. Unknown ids render an empty state.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, Play } from 'lucide'
import { badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Empty } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { separator } from '@/components/ui/separator'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { Card as CardData, DeckDetail } from '@nook/api'
import { Message } from './model'
import type { Model } from './model'
import { routeToUrl } from './routes'

type Child = Html | string

const stateVariant = (state: CardData['state']): 'default' | 'secondary' | 'outline' => {
  switch (state) {
    case 'new':
      return 'secondary'
    case 'learning':
    case 'relearning':
      return 'outline'
    case 'review':
      return 'default'
  }
}

const dueLabel = (dueInDays: number): string => {
  if (dueInDays <= 0) return dueInDays === 0 ? 'due now' : `${-dueInDays}d overdue`
  if (dueInDays === 1) return 'due tomorrow'
  return `in ${dueInDays}d`
}

const dueClass = (dueInDays: number): string =>
  dueInDays <= 0 ? 'text-destructive' : 'text-muted-foreground'

const cardRow = (card: CardData, index: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        cn(
          'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5',
          index > 0 && 'border-t border-border',
        ),
      ),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          badge<Message>({ variant: stateVariant(card.state) }, [card.state], h),
          h.span([h.Class('font-mono text-xs text-muted-foreground')], [`#${index + 1}`]),
        ],
      ),
      h.span(
        [h.Class(cn('text-right text-xs font-medium tabular-nums', dueClass(card.dueInDays)))],
        [dueLabel(card.dueInDays)],
      ),
      h.div(
        [
          h.Class(
            'col-span-2 flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground',
          ),
        ],
        [
          h.span([], [`stability ${card.stability.toFixed(1)}d`]),
          h.span([], ['·']),
          h.span([], [`difficulty ${card.difficulty}/10`]),
        ],
      ),
    ],
  )

const header = (detail: DeckDetail, h: HtmlBuilder<Message>): Html =>
  Card<Message>(
    { className: 'p-4' },
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.h1([h.Class('text-lg font-bold tracking-tight')], [detail.summary.name]),
          h.p([h.Class('text-xs text-muted-foreground')], [detail.summary.description]),
        ],
      ),
      h.div(
        [h.Class('mt-3 grid grid-cols-3 gap-2 text-center')],
        [
          h.div(
            [h.Class('rounded-lg bg-muted/60 px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none text-destructive')],
                [String(detail.summary.dueCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Due']),
            ],
          ),
          h.div(
            [h.Class('rounded-lg bg-muted/60 px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none')],
                [String(detail.summary.newCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['New']),
            ],
          ),
          h.div(
            [h.Class('rounded-lg bg-muted/60 px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none')],
                [String(detail.summary.totalCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Total']),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('mt-3 flex items-center gap-2')],
        [
          Progress<Message>({ value: detail.summary.retention7d, className: 'flex-1' }, h),
          h.span(
            [h.Class('text-xs tabular-nums text-muted-foreground')],
            [`${detail.summary.retention7d}% · 7d`],
          ),
        ],
      ),
      button<Message>(
        {
          onClick: Message.StartedReview({ deckId: Option.some(detail.summary.id) }),
          size: 'xl',
          className: 'mt-3 w-full',
          isDisabled: detail.summary.dueCount + detail.summary.newCount === 0,
        },
        [
          icon(h, Play, 'size-4', 'inline-start'),
          `Review ${detail.summary.dueCount + detail.summary.newCount} Cards`,
        ],
        h,
      ),
    ],
    h,
  )

export const deckDetailView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> =>
  Option.match(model.deckDetail, {
    onNone: () => [
      Empty<Message>(
        {},
        [
          Empty.media<Message>({ variant: 'icon' }, [icon(h, CircleAlert, 'size-4')], h),
          Empty.title<Message>({}, ['Deck not found'], h),
          Empty.description<Message>({}, ['This deck does not exist on this device.'], h),
          Empty.content<Message>(
            {},
            [
              h.a(
                [
                  h.Href(routeToUrl({ _tag: 'Decks' })),
                  h.Class('text-xs font-medium text-primary hover:underline'),
                ],
                ['Back to decks'],
              ),
            ],
            h,
          ),
        ],
        h,
      ),
    ],
    onSome: (detail) => [
      header(detail, h),
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.h2([h.Class('text-sm font-semibold')], [`Cards · ${detail.cards.length} shown`]),
          h.span([h.Class('text-[11px] text-muted-foreground')], ['scheduling state only']),
        ],
      ),
      Card<Message>(
        { className: 'py-0' },
        detail.cards.map((card, index) => cardRow(card, index, h)),
        h,
      ),
      h.div(
        [h.Class('px-1')],
        [
          separator<Message>({}, h),
          h.p(
            [h.Class('py-2 text-[11px] leading-relaxed text-muted-foreground')],
            [
              'Stability is the days a Card survives at your desired recall rate; difficulty runs 1–10. Both belong to FSRS — tune them through Settings, not here.',
            ],
          ),
        ],
      ),
    ],
  })
