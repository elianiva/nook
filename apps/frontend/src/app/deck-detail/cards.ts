/**
 * Deck page Card list: a folded section of Card rows, each with its history panel.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronDown } from 'lucide'
import { badge } from '@/components/ui/badge'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { LEECH_LAPSE_THRESHOLD } from '@nook/api'
import type { Card as CardData, CardReviewEvent, DeckDetail, CardId } from '@nook/api'
import { Message } from '../model'
import type { DeckManage, Model } from '../model'

const stateVariant = (state: CardData['state']): 'default' | 'secondary' => {
  switch (state) {
    case 'new':
      return 'secondary'
    case 'learning':
    case 'relearning':
    case 'review':
      return 'default'
  }
}

const dueLabel = (card: CardData): string => {
  if (card.dueInDays <= 0) {
    // An intraday due shows its clock time; an overdue one shows days.
    if (card.dueInDays === 0) {
      const at = Option.getOrNull(card.dueAt)
      if (at !== null) {
        const date = new Date(at)
        if (!Number.isNaN(date.getTime())) {
          return `due ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        }
      }
      return 'due now'
    }
    return `${-card.dueInDays}d overdue`
  }
  if (card.dueInDays === 1) return 'due tomorrow'
  return `in ${card.dueInDays}d`
}

const dueClass = (dueInDays: number): string =>
  dueInDays <= 0 ? 'text-destructive' : 'text-muted-foreground'

const scheduleText = (schedule: CardReviewEvent['before']): string => {
  if (schedule === null) return 'Schedule snapshot unavailable.'
  const at = schedule.dueAt === null ? null : new Date(schedule.dueAt)
  const due =
    at === null
      ? 'not scheduled'
      : Number.isNaN(at.getTime())
        ? schedule.dueAt
        : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `${schedule.state} · due ${due} · stability ${schedule.stability.toFixed(1)}d · difficulty ${schedule.difficulty.toFixed(1)}`
}

const historyEventRow = (event: CardReviewEvent, h: HtmlBuilder<Message>): Html => {
  const at = new Date(event.reviewedAt)
  const date = Number.isNaN(at.getTime())
    ? event.reviewedAt
    : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return h.div(
    [h.Class('flex flex-col gap-1 rounded-[10px] bg-white px-3 py-2')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          badge<Message>(
            { variant: event.grade === 'Again' ? 'destructive' : 'secondary' },
            [event.grade],
            h,
          ),
          h.span([h.Class('text-[11px] text-muted-foreground')], [date]),
          ...(event.leechSuspended
            ? [badge<Message>({ variant: 'destructive' }, ['Leech suspended'], h)]
            : []),
        ],
      ),
      h.p(
        [h.Class('text-[11px] text-muted-foreground')],
        [`Before · ${scheduleText(event.before)}`],
      ),
      h.p(
        [h.Class('text-[11px] text-[var(--theme-ink)]')],
        [`After · ${scheduleText(event.after)}`],
      ),
    ],
  )
}

const cardHistoryPanel = (cardId: CardId, model: Model, h: HtmlBuilder<Message>): Html => {
  const error = Option.getOrNull(model.cardHistoryError)
  return h.div(
    [
      h.Class(
        'col-span-2 flex max-h-72 flex-col gap-2 overflow-y-auto rounded-[10px] bg-white/70 p-2',
      ),
      h.Role('region'),
      h.AriaLabel('Card review history'),
    ],
    [
      ...(model.cardHistoryLoading && model.cardHistory.length === 0
        ? [
            h.p(
              [h.Class('text-xs text-muted-foreground'), h.Role('status')],
              ['Loading review history…'],
            ),
          ]
        : []),
      ...(error === null
        ? []
        : [
            h.div(
              [h.Class('flex items-center gap-2'), h.Role('alert')],
              [
                h.p([h.Class('min-w-0 flex-1 text-xs text-destructive')], [error]),
                button<Message>(
                  {
                    onClick: Message.ClickedRetryCardHistory({ cardId }),
                    size: 'sm',
                    isDisabled: model.cardHistoryLoading,
                  },
                  ['Retry'],
                  h,
                ),
              ],
            ),
          ]),
      ...(!model.cardHistoryLoading && model.cardHistory.length === 0 && error === null
        ? [h.p([h.Class('text-xs text-muted-foreground')], ['No saved reviews for this Card yet.'])]
        : []),
      ...(model.cardHistoryTotal > model.cardHistory.length
        ? [
            h.p(
              [h.Class('text-[10px] text-muted-foreground')],
              [
                `Showing the latest ${model.cardHistory.length} of ${model.cardHistoryTotal} reviews.`,
              ],
            ),
          ]
        : []),
      ...model.cardHistory.map((event) => historyEventRow(event, h)),
    ],
  )
}

const cardRow = (card: CardData, index: number, model: Model, h: HtmlBuilder<Message>): Html => {
  // `preview` is optional on the wire for older caches; the decoder defaults it to `''`.
  const preview = card.preview ?? ''
  const pending = Option.match(model.cardSuspensionPending, {
    onNone: () => false,
    onSome: (cardId) => cardId === card.id,
  })
  const actionError = Option.match(model.cardSuspensionError, {
    onNone: () => null,
    onSome: ({ cardId, message }) => (cardId === card.id ? message : null),
  })
  const leech = card.reviewLapses >= LEECH_LAPSE_THRESHOLD
  const historyOpen = Option.getOrNull(model.cardHistoryCard) === card.id
  return h.div(
    [
      h.Class(
        'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-[14px] border-0 bg-[var(--theme-block)] px-3 py-2.5',
      ),
    ],
    [
      h.span(
        [h.Class('min-w-0 flex-1 truncate text-sm font-semibold')],
        [preview === '' ? `Card ${index + 1}` : preview],
      ),
      h.span(
        [
          h.Class(
            cn(
              'shrink-0 text-right text-xs font-medium tabular-nums',
              card.suspended ? 'text-muted-foreground' : dueClass(card.dueInDays),
            ),
          ),
        ],
        [card.suspended ? 'suspended' : dueLabel(card)],
      ),
      h.div(
        [
          h.Class(
            'col-span-2 flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground',
          ),
        ],
        [
          badge<Message>({ variant: stateVariant(card.state) }, [card.state], h),
          ...(leech ? [badge<Message>({ variant: 'destructive' }, ['Leech'], h)] : []),
          ...(card.suspended && !leech
            ? [badge<Message>({ variant: 'secondary' }, ['paused'], h)]
            : []),
          h.span([], [`stability ${card.stability.toFixed(1)}d`]),
          h.span([], ['·']),
          h.span([], [`difficulty ${card.difficulty.toFixed(1)}/10`]),
          button<Message>(
            {
              onClick: Message.ClickedCardHistory({ cardId: card.id }),
              size: 'sm',
              className: 'h-7 px-2',
              attributes: [h.AriaExpanded(historyOpen)],
            },
            [historyOpen ? 'Hide history' : 'History'],
            h,
          ),
          ...(card.suspended
            ? [
                button<Message>(
                  {
                    onClick: Message.ClickedRestoreCard({ cardId: card.id }),
                    size: 'sm',
                    isDisabled: pending,
                    className: 'ml-auto h-7 px-2',
                  },
                  [pending ? 'Restoring…' : 'Restore'],
                  h,
                ),
              ]
            : []),
        ],
      ),
      ...(actionError === null
        ? []
        : [
            h.p(
              [h.Class('col-span-2 text-[11px] text-destructive'), h.Role('alert')],
              [actionError],
            ),
          ]),
      ...(historyOpen ? [cardHistoryPanel(card.id, model, h)] : []),
    ],
  )
}

/**
 * The Card list, folded by default: a Deck with hundreds of Cards used to
 * bury its own Manage section. The block reads like the page's other grey
 * sections — a thick toggle with the list inside — so it never looks like a
 * stray dropdown, and the count stays visible either way.
 */
export const cardsSection = (
  detail: DeckDetail,
  manage: DeckManage | null,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const open = manage?.cardsOpen ?? false
  const suspendedCount = detail.cards.filter((card) => card.suspended).length
  const leechCount = detail.cards.filter(
    (card) => card.reviewLapses >= LEECH_LAPSE_THRESHOLD,
  ).length
  return h.div(
    [h.Class('flex flex-col gap-2 rounded-[20px] border-0 bg-[var(--theme-block)] p-4')],
    [
      h.button(
        [
          h.OnClick(Message.ToggledDeckCards()),
          h.Class(
            'flex w-full items-center justify-between gap-3 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-block)]',
          ),
          h.AriaExpanded(open),
        ],
        [
          h.div(
            [h.Class('flex flex-col gap-0.5')],
            [
              h.span([h.Class('text-sm font-bold')], ['Cards']),
              h.span(
                [h.Class('text-xs text-muted-foreground')],
                [
                  `${detail.cards.length} ${detail.cards.length === 1 ? 'Card' : 'Cards'}${suspendedCount === 0 ? '' : ` · ${suspendedCount} suspended`}${leechCount === 0 ? '' : ` · ${leechCount} leeches`}${open ? '' : ' · hidden'}`,
                ],
              ),
            ],
          ),
          icon(h, ChevronDown, open ? 'size-5 rotate-180' : 'size-5'),
        ],
      ),
      ...(open
        ? [
            h.div(
              [h.Class('flex flex-col gap-1.5')],
              detail.cards.map((card, index) => cardRow(card, index, model, h)),
            ),
          ]
        : []),
    ],
  )
}
