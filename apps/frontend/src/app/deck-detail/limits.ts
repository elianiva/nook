/**
 * Deck page limits: the per-deck limits row and its override form.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Settings2 } from 'lucide'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import type { DeckDetail, DeckId } from '@nook/api'
import { fieldError } from '../load-state'
import { Message } from '../model'
import { limitsTextFromSummary } from '../model'
import type { DeckManage } from '../model'
import type { Child } from './child'

/** One limits override row: label on the left, narrow control on the right. */
const limitField = (
  id: string,
  labelText: string,
  value: string,
  toMessage: (value: string) => Message,
  placeholder: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3 py-1')],
    [
      h.label([h.For(id), h.Class('flex-1 text-[13px] font-semibold')], [labelText]),
      h.input([
        h.Id(id),
        h.Type('number'),
        h.Value(value),
        h.OnInput(toMessage),
        h.Min('0'),
        h.Step('1'),
        h.Placeholder(placeholder),
        h.Class(
          'w-24 rounded-[10px] border-0 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums outline-none',
        ),
      ]),
    ],
  )

/** The per-deck limits form: blank follows Settings, Save parses the text. */
export const limitsForm = (
  id: DeckId,
  state: DeckManage,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => [
  ...Option.match(state.limitsError, {
    onNone: () => [] as ReadonlyArray<Child>,
    onSome: (error) => [fieldError(error, h)],
  }),
  limitField(
    'deck-new-per-day',
    'New Cards per day',
    state.newPerDay,
    (value) => Message.TypedDeckNewPerDay({ value }),
    'Default',
    h,
  ),
  limitField(
    'deck-reviews-per-day',
    'Reviews per day',
    state.reviewsPerDay,
    (value) => Message.TypedDeckReviewsPerDay({ value }),
    'Default',
    h,
  ),
  limitField(
    'deck-lapse-minutes',
    'Lapse minutes',
    state.lapseMinutes,
    (value) => Message.TypedDeckLapseMinutes({ value }),
    'Default',
    h,
  ),
  h.p(
    [h.Class('text-[11px] text-muted-foreground')],
    ['Blank follows Settings. 0 pauses that queue for this deck.'],
  ),
  h.div(
    [h.Class('flex gap-2')],
    [
      button<Message>(
        {
          onClick: Message.ClickedSaveDeckLimits({ deckId: id }),
          size: 'sm',
          isDisabled: state.limitsSaving,
          className: 'flex-1',
        },
        [state.limitsSaving ? 'Saving…' : 'Save limits'],
        h,
      ),
      button<Message>(
        {
          onClick: Message.ClickedResetDeckLimits(),
          size: 'sm',
          isDisabled: state.limitsSaving,
        },
        ['Use defaults'],
        h,
      ),
      button<Message>(
        {
          onClick: Message.ClickedCancelDeckLimits(),
          size: 'sm',
          isDisabled: state.limitsSaving,
        },
        ['Cancel'],
        h,
      ),
    ],
  ),
]

const limitsSummaryText = (detail: DeckDetail): string => {
  const parts = [
    detail.summary.limits.newPerDay === null ? null : `${detail.summary.limits.newPerDay} new/d`,
    detail.summary.limits.reviewsPerDay === null
      ? null
      : `${detail.summary.limits.reviewsPerDay} rev/d`,
    detail.summary.limits.lapseMinutes === null
      ? null
      : `${detail.summary.limits.lapseMinutes}m lapse`,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? 'Follows Settings' : parts.join(' · ')
}

export const limitsRow = (detail: DeckDetail, saving: boolean, h: HtmlBuilder<Message>): Child =>
  h.div(
    [h.Class('flex items-center gap-3 py-1 pt-3')],
    [
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          h.div([h.Class('text-[13px] font-semibold')], ['Daily limits']),
          h.div([h.Class('truncate text-xs text-muted-foreground')], [limitsSummaryText(detail)]),
        ],
      ),
      button<Message>(
        {
          onClick: Message.ClickedEditDeckLimits({
            deckId: detail.summary.id,
            ...limitsTextFromSummary(detail.summary),
          }),
          size: 'sm',
          isDisabled: saving,
          attributes: [h.Id('deck-limits')],
        },
        [icon(h, Settings2, 'size-3.5'), 'Limits'],
        h,
      ),
    ],
  )
