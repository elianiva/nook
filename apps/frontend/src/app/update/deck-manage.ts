/**
 * Deck Manage: rename, reset, remove, and per-deck limits.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { DeckLimits } from '@nook/api'
import { FocusElement, NavigateToPath } from '../commands'
import { RemoveDeck, RenameDeck, ResetDeck, SaveDeckLimits } from '../api-commands'
import { Message } from '../model'
import type { Model } from '../model'
import { routeToUrl } from '../routes'
import { deckCacheSnapshot, restoreDeckCache, updateDeckCache } from './deck-cache'
import { focusAfter } from './focus'
import { deckDetail, decks } from './loads'
import { defineHandlers } from './handlers'

/** Parses a limit field: blank means `null` (follow Settings), else a whole number at least `min`. */
export const parseLimit = (value: string, min: number): number | null | undefined => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min ? parsed : undefined
}

export const deckManageHandlers = defineHandlers((model) => ({
  // The rename form opens seeded from the deck's summary, so the draft
  // starts as what the server holds. Opening for another deck reseeds.
  ClickedEditDeck: ({ deckId, name, description }) => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        deckId: Option.some(deckId),
        name,
        description,
        editing: true,
        confirming: Option.none(),
        saving: false,
        saved: false,
        error: Option.none(),
      }),
    }),
    commands: [FocusElement({ selector: '#deck-name' })],
  }),

  TypedDeckName: ({ value }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, name: value, saved: false }),
    }),
  }),

  TypedDeckDescription: ({ value }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, description: value, saved: false }),
    }),
  }),

  ClickedCancelDeckEdit: () => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, editing: false, error: Option.none() }),
    }),
    commands: [FocusElement({ selector: '#deck-rename' })],
  }),

  // A blank name would render as an empty row everywhere, so it never
  // leaves the device: the form keeps the error instead of sending.
  ClickedSaveDeck: ({ deckId }) => {
    if (model.deckManage.name.trim() === '') {
      return {
        model: modifyFields(model, {
          deckManage: () => ({
            ...model.deckManage,
            error: Option.some('Give the deck a name first.'),
          }),
        }),
      }
    }
    const rename = {
      name: model.deckManage.name.trim(),
      description: model.deckManage.description.trim(),
    }
    const snapshot = deckCacheSnapshot(model, deckId)
    const optimistic = updateDeckCache(model, deckId, (summary) => ({ ...summary, ...rename }))
    return {
      model: modifyFields(optimistic, {
        deckMutationRollback: () => Option.some(snapshot),
        deckManage: () => ({ ...model.deckManage, saving: true, error: Option.none() }),
      }),
      commands: [RenameDeck({ deckId, rename })],
    }
  },

  // The rename landed: close the form and refresh both reads, so the deck
  // page and every list show the new identity. The Queries keep their last
  // data while the fresh answer arrives.
  RenamedDeck: ({ deckId }) => {
    const next: Model = {
      ...model,
      deckManage: { ...model.deckManage, editing: false, saving: false, saved: true },
      deckMutationRollback: Option.none(),
    }
    return focusAfter(
      Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => deckDetail.revalidateOrLoad(current, { deckId }),
      ]),
      '#deck-rename',
    )
  },

  // Destructive confirms: only one is open at a time, and opening one
  // closes the rename form so the section shows a single decision.
  ClickedResetDeck: ({ deckId }) => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        deckId: Option.some(deckId),
        editing: false,
        confirming: Option.some('reset' as const),
        saved: false,
        error: Option.none(),
      }),
    }),
    commands: [FocusElement({ selector: '#deck-confirm-keep' })],
  }),

  ClickedRemoveDeck: ({ deckId }) => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        deckId: Option.some(deckId),
        editing: false,
        confirming: Option.some('remove' as const),
        saved: false,
        error: Option.none(),
      }),
    }),
    commands: [FocusElement({ selector: '#deck-confirm-keep' })],
  }),

  ClickedCancelDeckConfirm: () => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        confirming: Option.none(),
        error: Option.none(),
      }),
    }),
    // Back to the button that opened the confirm.
    commands: [
      FocusElement({
        selector: Option.contains(model.deckManage.confirming, 'remove')
          ? '#deck-remove'
          : '#deck-reset',
      }),
    ],
  }),

  ClickedConfirmResetDeck: ({ deckId }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, saving: true, error: Option.none() }),
    }),
    commands: [ResetDeck({ deckId })],
  }),

  ClickedConfirmRemoveDeck: ({ deckId }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, saving: true, error: Option.none() }),
    }),
    commands: [RemoveDeck({ deckId })],
  }),

  // The reset landed: the deck is all-new again, so both reads refresh.
  ResetDeckDone: ({ deckId }) => {
    const next: Model = {
      ...model,
      deckManage: { ...model.deckManage, confirming: Option.none(), saving: false },
    }
    return Update.combine<Model, Message>(next, [
      decks.revalidateOrLoad,
      (current) => deckDetail.revalidateOrLoad(current, { deckId }),
    ])
  },

  // The removal landed: the deck is gone, so the app leaves for the list,
  // whose load runs on navigation. The manage state resets with the route.
  RemovedDeck: () => ({
    model,
    commands: [NavigateToPath({ path: routeToUrl({ _tag: 'Decks' }) })],
  }),

  ToggledDeckCards: () => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, cardsOpen: !model.deckManage.cardsOpen }),
    }),
  }),

  // The limits form opens seeded from the deck's summary: overrides as
  // text, blank for "follow Settings". Typing keeps the text; only Save
  // parses it, so half-typed input never corrupts the draft.
  ClickedEditDeckLimits: ({ deckId, newPerDay, reviewsPerDay, lapseMinutes }) => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        deckId: Option.some(deckId),
        editingLimits: true,
        newPerDay,
        reviewsPerDay,
        lapseMinutes,
        limitsSaving: false,
        limitsSaved: false,
        limitsError: Option.none(),
      }),
    }),
    commands: [FocusElement({ selector: '#deck-new-per-day' })],
  }),

  TypedDeckNewPerDay: ({ value }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, newPerDay: value, limitsSaved: false }),
    }),
  }),

  TypedDeckReviewsPerDay: ({ value }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, reviewsPerDay: value, limitsSaved: false }),
    }),
  }),

  TypedDeckLapseMinutes: ({ value }) => ({
    model: modifyFields(model, {
      deckManage: () => ({ ...model.deckManage, lapseMinutes: value, limitsSaved: false }),
    }),
  }),

  ClickedResetDeckLimits: () => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        newPerDay: '',
        reviewsPerDay: '',
        lapseMinutes: '',
        limitsSaved: false,
        limitsError: Option.none(),
      }),
    }),
  }),

  ClickedCancelDeckLimits: () => ({
    model: modifyFields(model, {
      deckManage: () => ({
        ...model.deckManage,
        editingLimits: false,
        limitsError: Option.none(),
      }),
    }),
    commands: [FocusElement({ selector: '#deck-limits' })],
  }),

  // Save parses the text: blank means `null` (follow Settings), anything
  // else must be a whole number in range. Bad input stays on the device
  // with a sentence, like the blank deck name.
  ClickedSaveDeckLimits: ({ deckId }) => {
    const newPerDay = parseLimit(model.deckManage.newPerDay, 0)
    const reviewsPerDay = parseLimit(model.deckManage.reviewsPerDay, 0)
    const lapseMinutes = parseLimit(model.deckManage.lapseMinutes, 1)
    if (newPerDay === undefined || reviewsPerDay === undefined) {
      return {
        model: modifyFields(model, {
          deckManage: () => ({
            ...model.deckManage,
            limitsError: Option.some('Per-day counts must be whole numbers, 0 or more.'),
          }),
        }),
      }
    }
    if (lapseMinutes === undefined) {
      return {
        model: modifyFields(model, {
          deckManage: () => ({
            ...model.deckManage,
            limitsError: Option.some('Lapse minutes must be a whole number, at least 1.'),
          }),
        }),
      }
    }
    const limits: DeckLimits = { newPerDay, reviewsPerDay, lapseMinutes }
    const snapshot = deckCacheSnapshot(model, deckId)
    const optimistic = updateDeckCache(model, deckId, (summary) => ({ ...summary, limits }))
    return {
      model: modifyFields(optimistic, {
        deckMutationRollback: () => Option.some(snapshot),
        deckManage: () => ({
          ...model.deckManage,
          limitsSaving: true,
          limitsSaved: false,
          limitsError: Option.none(),
        }),
      }),
      commands: [SaveDeckLimits({ deckId, limits })],
    }
  },

  // The limits landed: both reads refresh, so the deck page and every
  // list show the new today-counts. The Queries keep their last data
  // while the fresh answer arrives.
  SavedDeckLimits: ({ deckId }) => {
    const next: Model = {
      ...model,
      deckManage: {
        ...model.deckManage,
        editingLimits: false,
        limitsSaving: false,
        limitsSaved: true,
      },
      deckMutationRollback: Option.none(),
    }
    return focusAfter(
      Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => deckDetail.revalidateOrLoad(current, { deckId }),
      ]),
      '#deck-limits',
    )
  },

  DeckManageFailed: ({ deckId, error }) => {
    const snapshot = Option.getOrNull(model.deckMutationRollback)
    const rolledBack =
      snapshot !== null && snapshot.deckId === deckId ? restoreDeckCache(model, snapshot) : model
    const next = modifyFields(rolledBack, {
      deckMutationRollback: () => Option.none(),
      deckManage: () => ({
        ...model.deckManage,
        saving: false,
        limitsSaving: false,
        error: Option.some(error),
      }),
    })
    return Update.combine<Model, Message>(next, [
      decks.revalidateOrLoad,
      (current) => deckDetail.revalidateOrLoad(current, { deckId }),
    ])
  },
}))
