/**
 * Deck page Manage section: rename, reset, and remove.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Pencil, RotateCcw, Trash2 } from 'lucide'
import { button } from '@/components/ui/button'
import { input } from '@/components/ui/input'
import { textarea } from '@/components/ui/textarea'
import { icon } from '@/lib/icons'
import type { DeckDetail, DeckId } from '@nook/api'
import { fieldError } from '../load-state'
import { Message } from '../model'
import type { DeckManage } from '../model'
import { limitsForm, limitsRow } from './limits'
import type { Child } from './child'

/**
 * The Manage section: rename the Deck, reset its Schedule, or remove it.
 *
 * Rename edits a local draft until Save; the destructive actions each open
 * one inline confirm that names what goes away, and only the confirmed one
 * sends its request. `manage` is `null` when the Model's draft belongs to
 * another deck — the section then shows its resting actions only.
 */
export const manageSection = (
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
    editingLimits: false,
    newPerDay: '',
    reviewsPerDay: '',
    lapseMinutes: '',
    limitsSaving: false,
    limitsSaved: false,
    limitsError: Option.none(),
    cardsOpen: false,
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
                h.Role('status'),
              ],
              ['Deck renamed.'],
            ),
          ]
        : []),
      ...(state.limitsSaved
        ? [
            h.div(
              [
                h.Class(
                  'rounded-[10px] border-0 bg-white px-3 py-2 text-xs font-semibold text-[var(--theme-ink)]',
                ),
                h.Role('status'),
              ],
              ['Limits saved.'],
            ),
          ]
        : []),
      ...Option.match(state.error, {
        onNone: () => [] as ReadonlyArray<Child>,
        onSome: (error) => [fieldError(error, h)],
      }),
      ...(state.editing ? renameForm(id, state, h) : [renameRow(detail, state.saving, h)]),
      ...(state.editingLimits
        ? limitsForm(id, state, h)
        : [limitsRow(detail, state.saving || state.limitsSaving, h)]),
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
          attributes: [h.Id('deck-rename')],
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
          attributes: [h.Id('deck-reset')],
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
          attributes: [h.Id('deck-remove')],
        },
        [icon(h, Trash2, 'size-3.5'), 'Remove'],
        h,
      ),
    ],
  ),
]

const resetConfirm = (id: DeckId, saving: boolean, h: HtmlBuilder<Message>): Child =>
  h.div(
    [h.Class('flex flex-col gap-2 rounded-[10px] border-0 bg-white px-3 py-2.5'), h.Role('alert')],
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
              attributes: [h.Id('deck-confirm-keep')],
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
              attributes: [h.Id('deck-confirm-keep')],
            },
            ['Keep'],
            h,
          ),
        ],
      ),
    ],
  )
