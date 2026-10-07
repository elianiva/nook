/**
 * Deck page: one Deck's summary plus its Card list.
 *
 * The header carries the counts and a Start action; the list shows each
 * Card's prompt preview with its scheduling state underneath. The read is
 * the deck-detail KeyedQuery, so an unknown id renders its not-found state
 * and a known Deck keeps its last answer while a refresh runs.
 */

import { AsyncData } from 'foldkit'
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, Pencil, Play, RotateCcw, Trash2 } from 'lucide'
import { badge } from '@/components/ui/badge'
import { Empty } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { button } from '@/components/ui/button'
import { input } from '@/components/ui/input'
import { textarea } from '@/components/ui/textarea'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { Card as CardData, DeckDetail, DeckId } from '@nook/api'
import { errorPanel, loadingHero, loadingRows } from './load-state'
import { Message } from './model'
import type { DeckManage, Model } from './model'
import { deckDetailQuery } from './queries'
import { routeToUrl } from './routes'

type Child = Html | string

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

const cardRow = (card: CardData, index: number, h: HtmlBuilder<Message>): Html => {
  // `preview` is optional on the wire for older caches; the decoder defaults it to `''`.
  const preview = card.preview ?? ''
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
            cn('shrink-0 text-right text-xs font-medium tabular-nums', dueClass(card.dueInDays)),
          ),
        ],
        [dueLabel(card)],
      ),
      h.div(
        [
          h.Class(
            'col-span-2 flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground',
          ),
        ],
        [
          badge<Message>({ variant: stateVariant(card.state) }, [card.state], h),
          h.span([], [`stability ${card.stability.toFixed(1)}d`]),
          h.span([], ['·']),
          h.span([], [`difficulty ${card.difficulty.toFixed(1)}/10`]),
        ],
      ),
    ],
  )
}

const header = (detail: DeckDetail, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('rounded-[20px] border-0 bg-[var(--theme-block)] p-4')],
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
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none text-destructive')],
                [String(detail.summary.dueCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Due']),
            ],
          ),
          h.div(
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none')],
                [String(detail.summary.newCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['New']),
            ],
          ),
          h.div(
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
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
  )

/** A deck id that names no Deck. This is an answer, not a failure to retry. */
const deckNotFound = (h: HtmlBuilder<Message>): ReadonlyArray<Child> => [
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
]

const deckBody = (
  detail: DeckDetail,
  manage: DeckManage,
  forDeck: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => [
  header(detail, h),
  h.h2([h.Class('text-sm font-semibold')], [`Cards · ${detail.cards.length} shown`]),
  h.div(
    [h.Class('flex flex-col gap-1.5')],
    detail.cards.map((card, index) => cardRow(card, index, h)),
  ),
  h.h2([h.Class('text-sm font-semibold')], ['Manage']),
  manageSection(detail, forDeck ? manage : null, h),
]

/**
 * The Manage section: rename the Deck, reset its Schedule, or remove it.
 *
 * Rename edits a local draft until Save; the destructive actions each open
 * one inline confirm that names what goes away, and only the confirmed one
 * sends its request. `manage` is `null` when the Model's draft belongs to
 * another deck — the section then shows its resting actions only.
 */
const manageSection = (
  detail: DeckDetail,
  manage: DeckManage | null,
  h: HtmlBuilder<Message>,
): Html => {
  const state: DeckManage = manage ?? {
    deckId: Option.none(),
    name: detail.summary.name,
    description: detail.summary.description,
    editing: false,
    confirming: Option.none(),
    saving: false,
    saved: false,
    error: Option.none(),
  }
  const id = detail.summary.id
  return h.div(
    [h.Class('flex flex-col gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] p-3')],
    [
      ...(state.saved
        ? [
            h.div(
              [
                h.Class(
                  'rounded-[10px] border-0 bg-white px-3 py-2 text-xs font-semibold text-[var(--theme-ink)]',
                ),
              ],
              ['Deck renamed.'],
            ),
          ]
        : []),
      ...Option.match(state.error, {
        onNone: () => [] as ReadonlyArray<Child>,
        onSome: (error) => [
          h.div(
            [
              h.Class(
                'flex items-start gap-2 rounded-[10px] border-0 bg-white px-3 py-2 text-xs text-destructive',
              ),
              h.Role('alert'),
            ],
            [icon(h, CircleAlert, 'size-4 shrink-0'), h.span([], [error])],
          ),
        ],
      }),
      ...(state.editing ? renameForm(id, state, h) : [renameRow(detail, state.saving, h)]),
      ...Option.match(state.confirming, {
        onNone: () => destructiveRows(id, state.saving, h),
        onSome: (confirm) =>
          confirm === 'reset'
            ? [resetConfirm(id, state.saving, h)]
            : [removeConfirm(id, state.saving, detail.summary.totalCount, h)],
      }),
    ],
  )
}

const renameRow = (detail: DeckDetail, saving: boolean, h: HtmlBuilder<Message>): Child =>
  h.div(
    [h.Class('flex items-center gap-3 py-1')],
    [
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          h.div([h.Class('truncate text-[13px] font-semibold')], [detail.summary.name]),
          h.div(
            [h.Class('truncate text-xs text-muted-foreground')],
            [detail.summary.description === '' ? 'No description' : detail.summary.description],
          ),
        ],
      ),
      button<Message>(
        {
          onClick: Message.ClickedEditDeck({
            deckId: detail.summary.id,
            name: detail.summary.name,
            description: detail.summary.description,
          }),
          size: 'sm',
          isDisabled: saving,
        },
        [icon(h, Pencil, 'size-3.5'), 'Rename'],
        h,
      ),
    ],
  )

const renameForm = (
  id: DeckId,
  state: DeckManage,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => [
  input<Message>(
    {
      id: 'deck-name',
      label: 'Deck name',
      value: state.name,
      onInput: (value) => Message.TypedDeckName({ value }),
      isDisabled: state.saving,
      className: 'border-0 bg-white shadow-none outline-none',
    },
    h,
  ),
  textarea<Message>(
    {
      id: 'deck-description',
      label: 'Description',
      value: state.description,
      onInput: (value) => Message.TypedDeckDescription({ value }),
      rows: 2,
      isDisabled: state.saving,
      className: 'border-0 bg-white shadow-none outline-none',
    },
    h,
  ),
  h.div(
    [h.Class('flex gap-2')],
    [
      button<Message>(
        {
          onClick: Message.ClickedSaveDeck({ deckId: id }),
          size: 'sm',
          isDisabled: state.saving,
          className: 'flex-1',
        },
        [state.saving ? 'Saving…' : 'Save'],
        h,
      ),
      button<Message>(
        {
          onClick: Message.ClickedCancelDeckEdit(),
          size: 'sm',
          isDisabled: state.saving,
        },
        ['Cancel'],
        h,
      ),
    ],
  ),
]

const destructiveRows = (
  id: DeckId,
  saving: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => [
  h.div(
    [h.Class('flex items-center gap-3 py-1 pt-3')],
    [
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          h.div([h.Class('text-[13px] font-semibold')], ['Reset progress']),
          h.div(
            [h.Class('text-xs text-muted-foreground')],
            ['Every Card returns to new; the Review history goes.'],
          ),
        ],
      ),
      button<Message>(
        {
          onClick: Message.ClickedResetDeck({ deckId: id }),
          size: 'sm',
          isDisabled: saving,
        },
        [icon(h, RotateCcw, 'size-3.5'), 'Reset'],
        h,
      ),
    ],
  ),
  h.div(
    [h.Class('flex items-center gap-3 py-1')],
    [
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          h.div([h.Class('text-[13px] font-semibold text-destructive')], ['Remove deck']),
          h.div(
            [h.Class('text-xs text-muted-foreground')],
            ['Deletes the deck, its Cards, and its history.'],
          ),
        ],
      ),
      button<Message>(
        {
          onClick: Message.ClickedRemoveDeck({ deckId: id }),
          size: 'sm',
          isDisabled: saving,
        },
        [icon(h, Trash2, 'size-3.5'), 'Remove'],
        h,
      ),
    ],
  ),
]

const resetConfirm = (id: DeckId, saving: boolean, h: HtmlBuilder<Message>): Child =>
  h.div(
    [h.Class('flex flex-col gap-2 rounded-[10px] border-0 bg-white px-3 py-2.5')],
    [
      h.p(
        [h.Class('text-xs')],
        [
          'Reset this deck? Every Card returns to new and its Review history is deleted. The Notes stay.',
        ],
      ),
      h.div(
        [h.Class('flex gap-2')],
        [
          button<Message>(
            {
              onClick: Message.ClickedConfirmResetDeck({ deckId: id }),
              size: 'sm',
              isDisabled: saving,
              className: 'flex-1',
            },
            [saving ? 'Resetting…' : 'Reset progress'],
            h,
          ),
          button<Message>(
            {
              onClick: Message.ClickedCancelDeckConfirm(),
              size: 'sm',
              isDisabled: saving,
            },
            ['Keep'],
            h,
          ),
        ],
      ),
    ],
  )

const removeConfirm = (
  id: DeckId,
  saving: boolean,
  cardCount: number,
  h: HtmlBuilder<Message>,
): Child =>
  h.div(
    [h.Class('flex flex-col gap-2 rounded-[10px] border-0 bg-white px-3 py-2.5'), h.Role('alert')],
    [
      h.p(
        [h.Class('text-xs text-destructive')],
        [
          `Remove this deck? Its ${cardCount} ${cardCount === 1 ? 'Card' : 'Cards'} and all Review history are deleted. There is no undo.`,
        ],
      ),
      h.div(
        [h.Class('flex gap-2')],
        [
          button<Message>(
            {
              onClick: Message.ClickedConfirmRemoveDeck({ deckId: id }),
              size: 'sm',
              isDisabled: saving,
              className: 'flex-1',
            },
            [saving ? 'Removing…' : 'Remove deck'],
            h,
          ),
          button<Message>(
            {
              onClick: Message.ClickedCancelDeckConfirm(),
              size: 'sm',
              isDisabled: saving,
            },
            ['Keep'],
            h,
          ),
        ],
      ),
    ],
  )

export const deckDetailView = (
  model: Model,
  deckId: DeckId,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> =>
  AsyncData.matchData(deckDetailQuery.read(model.deckDetail, { deckId }), {
    onEmpty: () => [loadingHero('Loading this deck…', h), loadingRows('Loading Cards…', h, 4)],
    onFailure: (error) =>
      error === 'notFound'
        ? deckNotFound(h)
        : [
            errorPanel(
              'Could not load this deck. Check the connection and try again.',
              Message.ClickedRetryDeckDetail({ deckId }),
              h,
            ),
          ],
    // The manage draft belongs to one deck; only hand it over when it names
    // this page's deck, so a stale draft never renders under another deck.
    onData: (detail) =>
      deckBody(
        detail,
        model.deckManage,
        Option.match(model.deckManage.deckId, {
          onNone: () => false,
          onSome: (id) => id === deckId,
        }),
        h,
      ),
  })
