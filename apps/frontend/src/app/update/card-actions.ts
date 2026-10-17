/**
 * Card actions during Review: suspend, restore, and history.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import { FetchCardHistory, SetCardSuspended } from '../api-commands'
import { Message } from '../model'
import type { Model } from '../model'
import { deckDetail, decks } from './loads'
import { persistReviewProgress } from './review'
import { defineHandlers } from './handlers'

export const cardActionsHandlers = defineHandlers((model) => ({
  ClickedSuspendCurrentCard: () => {
    const card = model.review.cards[model.review.index]
    if (
      model.review.phase !== 'reviewing' ||
      model.review.queueStatus === 'loading' ||
      !model.queuedGradesRestored ||
      card === undefined ||
      Option.isSome(model.review.suspensionPending)
    ) {
      return { model }
    }
    return {
      model: modifyFields(model, {
        review: () => ({
          ...model.review,
          suspensionPending: Option.some(card.cardId),
          suspensionError: Option.none(),
        }),
      }),
      commands: [SetCardSuspended({ cardId: card.cardId, suspended: true, origin: 'review' })],
    }
  },

  ClickedRestoreCard: ({ cardId }) => ({
    model: modifyFields(model, {
      cardSuspensionPending: () => Option.some(cardId),
      cardSuspensionError: () => Option.none(),
    }),
    commands: [SetCardSuspended({ cardId, suspended: false, origin: 'deck' })],
  }),

  ClickedCardHistory: ({ cardId }) => {
    const selected = Option.getOrNull(model.cardHistoryCard)
    if (selected === cardId) {
      return {
        model: {
          ...model,
          cardHistoryCard: Option.none(),
          cardHistoryLoading: false,
          cardHistory: [],
          cardHistoryTotal: 0,
          cardHistoryError: Option.none(),
        },
      }
    }
    return {
      model: {
        ...model,
        cardHistoryCard: Option.some(cardId),
        cardHistoryLoading: true,
        cardHistory: [],
        cardHistoryTotal: 0,
        cardHistoryError: Option.none(),
      },
      commands: [FetchCardHistory({ cardId })],
    }
  },

  ClickedRetryCardHistory: ({ cardId }) =>
    Option.getOrNull(model.cardHistoryCard) !== cardId
      ? { model }
      : {
          model: { ...model, cardHistoryLoading: true, cardHistoryError: Option.none() },
          commands: [FetchCardHistory({ cardId })],
        },

  GotCardHistory: ({ cardId, history }) =>
    Option.getOrNull(model.cardHistoryCard) !== cardId
      ? { model }
      : {
          model: {
            ...model,
            cardHistoryLoading: false,
            cardHistory: history.events,
            cardHistoryTotal: history.total,
            cardHistoryError: Option.none(),
          },
        },

  CardHistoryFailed: ({ cardId, error }) =>
    Option.getOrNull(model.cardHistoryCard) !== cardId
      ? { model }
      : {
          model: {
            ...model,
            cardHistoryLoading: false,
            cardHistoryError: Option.some(error),
          },
        },

  CardSuspensionSaved: ({ cardId, suspended, origin }) => {
    if (origin === 'review') {
      const pending = model.review.suspensionPending
      if (Option.isNone(pending) || pending.value !== cardId || !suspended) return { model }
      const cards = model.review.cards.filter((card) => card.cardId !== cardId)
      const requeue = model.review.requeue.filter((card) => card.cardId !== cardId)
      const index = Math.min(model.review.index, cards.length)
      return {
        model: modifyFields(model, {
          review: () => ({
            ...model.review,
            cards,
            index,
            requeue,
            revealed: false,
            phase: index >= cards.length ? 'done' : 'reviewing',
            suspensionPending: Option.none(),
            suspensionError: Option.none(),
          }),
        }),
        commands: persistReviewProgress(model, cards.slice(index)),
      }
    }
    if (origin === 'deck' && model.route._tag === 'DeckDetail') {
      const deckId = model.route.deckId
      const next = modifyFields(model, {
        cardSuspensionPending: () => Option.none(),
        cardSuspensionError: () => Option.none(),
      })
      return Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => deckDetail.revalidateOrLoad(current, { deckId }),
      ])
    }
    return { model }
  },

  CardSuspensionFailed: ({ error, origin }) =>
    origin === 'review'
      ? {
          model: modifyFields(model, {
            review: () => ({
              ...model.review,
              suspensionPending: Option.none(),
              suspensionError: Option.some(error),
            }),
          }),
        }
      : {
          model: modifyFields(model, {
            cardSuspensionPending: () => Option.none(),
            cardSuspensionError: () =>
              Option.isSome(model.cardSuspensionPending)
                ? Option.some({ cardId: model.cardSuspensionPending.value, message: error })
                : Option.none(),
          }),
        },
}))
