/**
 * Review: queue, grading, undo, and the durable grade queue.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Grade, ReviewCard } from '@nook/api'
import { FocusElement, NavigateToPath } from '../commands'
import {
  FetchReviewQueue,
  PersistReviewQueue,
  SaveQueuedGrade,
  SubmitGrade,
  UndoGrade,
} from '../api-commands'
import { Message, idleReview } from '../model'
import type { Model } from '../model'
import { AppRoute, routeToUrl } from '../routes'
import { focusAfter } from './focus'
import { revalidateVisible } from './loads'
import { clearNotice } from './notice'
import { defineHandlers } from './handlers'

/** Submit only the durable queue head; a failed head must never be overtaken.
 * This serializes one tab. The backend still needs a per-Card guard for races
 * between separate tabs.
 */
export const runQueuedGrade = (model: Model): Update.Return<Model, Message> => {
  const head = model.queuedGrades[0]
  if (head === undefined || Option.isSome(model.gradeInFlight) || model.gradeBlocked) {
    return { model }
  }

  const review = {
    ...model.review,
    pending: model.review.pending.some((entry) => entry.id === head.id)
      ? model.review.pending
      : [...model.review.pending, head],
    offline: model.review.offline.filter((entry) => entry.id !== head.id),
  }
  if (!head.persisted) {
    return {
      model: { ...model, review },
      commands: [
        SaveQueuedGrade({ id: head.id, cardId: head.cardId, grade: head.grade, seq: head.seq }),
      ],
    }
  }

  return {
    model: { ...model, review, gradeInFlight: Option.some(head.id) },
    commands: [SubmitGrade({ id: head.id, cardId: head.cardId, grade: head.grade })],
  }
}

/** Keep the unreviewed tail available if this tab reloads while offline. */
export const persistReviewProgress = (
  model: Model,
  cards: ReadonlyArray<ReviewCard>,
  warmMedia = false,
) =>
  Option.match(model.review.dayStartUtc, {
    onNone: () => [],
    onSome: (dayStartUtc) => [
      PersistReviewQueue({
        deckId: model.route._tag === 'ReviewDeck' ? Option.some(model.route.deckId) : Option.none(),
        cards: [...cards],
        dayStartUtc,
        lapseMinutes: model.review.lapseMinutes,
        warmMedia,
      }),
    ],
  })

/**
 * Applies a Grade on screen and queues it for durable, ordered submission.
 *
 * The screen advances before the request lands, so grading never waits for the
 * network. The Grade rides in `pending` until the server confirms it, and a
 * Retry reuses the same id, so a Grade that landed but was not acknowledged is
 * not applied twice (ADR 0002). An `Again` grade re-queues its Card later this
 * session; the queue grows by one and the session ends only when both the
 * queue and the re-queue are walked. The grade is also the undo point until
 * the next grade lands.
 */
export const gradeCurrent = (model: Model, grade: Grade): Update.Return<Model, Message> => {
  const review = model.review
  const card = review.cards[review.index]
  if (
    card === undefined ||
    !review.revealed ||
    review.queueStatus === 'loading' ||
    !model.queuedGradesRestored ||
    Option.isSome(review.suspensionPending)
  ) {
    return { model }
  }
  const seq = Math.max(-1, ...model.queuedGrades.map((entry) => entry.seq)) + 1
  const entry = { id: crypto.randomUUID(), cardId: card.cardId, grade, seq, persisted: false }
  const requeue = grade === 'Again' ? [...review.requeue, card] : review.requeue
  const cards = grade === 'Again' ? [...review.cards, card] : review.cards
  const index = review.index + 1
  const done = index >= cards.length
  return {
    model: clearNotice(
      modifyFields(model, {
        review: () => ({
          ...review,
          cards,
          index,
          revealed: false,
          pending: [...review.pending, entry],
          graded: review.graded + 1,
          requeue,
          lastGrade: Option.some(entry),
          undone: false,
          phase: done ? 'done' : 'reviewing',
          error: Option.none(),
        }),
        queuedGrades: () => [...model.queuedGrades, entry],
      }),
    ),
    commands: [
      SaveQueuedGrade({ id: entry.id, cardId: entry.cardId, grade: entry.grade, seq: entry.seq }),
      ...persistReviewProgress(model, cards.slice(index)),
      // The grade bar that held focus is gone: land on the next Card's reveal
      // button, or on the page when the session just ended.
      FocusElement({ selector: done ? '#main-content' : '#review-reveal' }),
    ],
  }
}

export const reviewHandlers = defineHandlers((model) => ({
  RestoredQueuedGrades: ({ grades }) => {
    const known = new Set(model.queuedGrades.map((entry) => entry.id))
    const restored = grades
      .filter((entry) => !known.has(entry.id))
      .map((entry) => ({ ...entry, persisted: true }))
    const queuedGrades = [...model.queuedGrades, ...restored].toSorted(
      (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
    )
    const pendingIds = new Set(model.review.pending.map((entry) => entry.id))
    const offline = queuedGrades.filter((entry) => !pendingIds.has(entry.id))
    const queuedCardIds = new Set(queuedGrades.map((entry) => entry.cardId))
    const cards = model.review.cards.filter((card) => !queuedCardIds.has(card.cardId))
    const index = Math.min(model.review.index, cards.length)
    const phase =
      model.review.queueStatus === 'loading' && cards.length === 0
        ? 'loading'
        : cards.length === 0
          ? 'done'
          : 'reviewing'
    const next: Model = {
      ...model,
      queuedGrades,
      queuedGradesRestored: true,
      review: {
        ...model.review,
        cards,
        index,
        phase,
        queueServedDue: cards.filter((card) => card.state !== 'new').length,
        queueServedNew: cards.filter((card) => card.state === 'new').length,
        offline,
      },
    }
    const draining = runQueuedGrade(next)
    return {
      model: draining.model,
      commands: [
        ...(draining.commands ?? []),
        ...persistReviewProgress(model, cards.slice(index), true),
      ],
    }
  },

  QueuedGradeSaved: ({ id }) => {
    const queuedGrades = model.queuedGrades.map((entry) =>
      entry.id === id ? { ...entry, persisted: true } : entry,
    )
    if (queuedGrades.every((entry) => entry.id !== id)) return { model }
    return runQueuedGrade({ ...model, queuedGrades })
  },

  // A Start action is a navigation: the review route fetches its own queue.
  StartedReview: ({ deckId }) => {
    const path = Option.match(deckId, {
      onNone: (): AppRoute => ({ _tag: 'Review' }),
      onSome: (id): AppRoute => ({ _tag: 'ReviewDeck', deckId: id }),
    })
    return { model, commands: [NavigateToPath({ path: routeToUrl(path) })] }
  },

  GotReviewQueue: ({
    source,
    sessionId,
    cards,
    dayStartUtc,
    lapseMinutes,
    reviewedToday,
    newToday,
    totalNew,
    totalDue,
    newCapped,
    dueCapped,
    beyondLimit,
  }) => {
    if (sessionId !== model.review.queueSessionId) return { model }
    // Do not let a late cache response replace a fresh answer. Controls stay
    // locked while the initial server check runs, so a fresh answer cannot
    // reset a session that has already started.
    if (source === 'cache' && (model.review.queueStatus === 'ready' || model.review.graded > 0)) {
      return { model }
    }
    if (source === 'server' && !beyondLimit && model.review.queueStatus === 'ready') {
      return { model }
    }
    const route = model.route
    const deckId = route._tag === 'ReviewDeck' ? Option.some(route.deckId) : Option.none()
    if (source === 'cache') {
      return {
        model: modifyFields(model, {
          review: () => ({
            ...idleReview,
            queueSessionId: sessionId,
            queueStatus: model.review.queueStatus,
            offline: model.queuedGrades,
            phase: cards.length === 0 ? 'done' : 'reviewing',
            cards: [...cards],
            dayStartUtc: Option.some(dayStartUtc),
            lapseMinutes,
            queueServedDue: cards.filter((card) => card.state !== 'new').length,
            queueServedNew: cards.filter((card) => card.state === 'new').length,
          }),
        }),
      }
    }
    // The queue is empty for two reasons: nothing waits, or a limit
    // stopped everything. Only a capped empty queue is a limit stop — a
    // short fetch (fewer Cards than the limit allows) is just empty.
    const limitStopped = cards.length === 0 && (newCapped || dueCapped || totalNew + totalDue > 0)
    const queuedGradeCardIds = new Set(model.queuedGrades.map((entry) => entry.cardId))
    const seenCardIds = new Set(beyondLimit ? model.review.cards.map((card) => card.cardId) : [])
    const currentCards = cards.filter((card) => {
      if (queuedGradeCardIds.has(card.cardId) || seenCardIds.has(card.cardId)) return false
      seenCardIds.add(card.cardId)
      return true
    })
    const queueCounts = {
      queueTotalDue: totalDue,
      queueTotalNew: totalNew,
      queueReviewedToday: reviewedToday,
      queueNewToday: newToday,
      queueNewCapped: newCapped,
      queueDueCapped: dueCapped,
      queueServedDue: currentCards.filter((card) => card.state !== 'new').length,
      queueServedNew: currentCards.filter((card) => card.state === 'new').length,
    }
    return {
      model: clearNotice(
        modifyFields(model, {
          review: () =>
            beyondLimit
              ? {
                  ...model.review,
                  queueStatus: 'ready',
                  cards: [...model.review.cards, ...currentCards],
                  index: model.review.cards.length,
                  revealed: false,
                  phase: currentCards.length === 0 ? 'done' : 'reviewing',
                  dayStartUtc: Option.some(dayStartUtc),
                  lapseMinutes,
                  doneKind:
                    currentCards.length === 0 && (newCapped || dueCapped) ? 'limits' : 'empty',
                  bypassDueLimit: true,
                  queueTotalDue: totalDue,
                  queueTotalNew: 0,
                  queueReviewedToday: reviewedToday,
                  queueNewToday: newToday,
                  queueNewCapped: false,
                  queueDueCapped: dueCapped,
                  queueServedDue:
                    model.review.queueServedDue +
                    currentCards.filter((card) => card.state !== 'new').length,
                  queueServedNew: model.review.queueServedNew,
                }
              : {
                  ...idleReview,
                  queueSessionId: sessionId,
                  queueStatus: 'ready',
                  offline: model.queuedGrades,
                  phase: currentCards.length === 0 ? 'done' : 'reviewing',
                  cards: [...currentCards],
                  dayStartUtc: Option.some(dayStartUtc),
                  lapseMinutes,
                  doneKind: limitStopped ? 'limits' : 'empty',
                  bypassDueLimit: false,
                  ...queueCounts,
                },
        }),
      ),
      commands: model.queuedGradesRestored
        ? [
            PersistReviewQueue({
              deckId,
              cards: beyondLimit
                ? [...model.review.cards.slice(model.review.index), ...currentCards]
                : [...currentCards],
              dayStartUtc,
              lapseMinutes,
              warmMedia: true,
            }),
          ]
        : [],
    }
  },

  CachedReviewQueueMiss: () => ({ model }),

  RevealedAnswer: () =>
    model.review.queueStatus === 'loading' || !model.queuedGradesRestored
      ? { model }
      : {
          model: modifyFields(model, { review: () => ({ ...model.review, revealed: true }) }),
          // The reveal button turns into the grade bar; keep focus inside it.
          commands: [FocusElement({ selector: '#review-grade-Good' })],
        },

  ClickedGrade: ({ grade }) => gradeCurrent(model, grade),

  PressedGrade: ({ grade }) => gradeCurrent(model, grade),

  // Space reveals, then grades Good: the one-hand rhythm.
  PressedSpace: () => {
    const review = model.review
    if (
      review.phase !== 'reviewing' ||
      review.queueStatus === 'loading' ||
      !model.queuedGradesRestored
    ) {
      return { model }
    }
    if (!review.revealed) {
      return focusAfter(
        { model: modifyFields(model, { review: () => ({ ...review, revealed: true }) }) },
        '#review-grade-Good',
      )
    }
    return gradeCurrent(model, 'Good')
  },

  GradeAccepted: ({ id, accepted }) => {
    const review = model.review
    const queuedGrades = model.queuedGrades.filter((entry) => entry.id !== id)
    const entry =
      review.pending.find((pending) => pending.id === id) ??
      review.offline.find((pending) => pending.id === id) ??
      model.queuedGrades.find((pending) => pending.id === id)
    const wasInFlight = Option.getOrNull(model.gradeInFlight) === id
    const base = {
      ...model,
      queuedGrades,
      gradeInFlight: wasInFlight ? Option.none<string>() : model.gradeInFlight,
      gradeBlocked: wasInFlight ? false : model.gradeBlocked,
    }
    if (entry === undefined) return runQueuedGrade(base)
    const leechCard = accepted.leechSuspended
      ? (review.cards.find((card) => card.cardId === accepted.cardId) ??
        review.requeue.find((card) => card.cardId === accepted.cardId))
      : undefined
    const removedBefore = accepted.leechSuspended
      ? review.cards.slice(0, review.index).filter((card) => card.cardId === accepted.cardId).length
      : 0
    const cards = accepted.leechSuspended
      ? review.cards.filter((card) => card.cardId !== accepted.cardId)
      : review.cards
    const index = Math.max(0, review.index - removedBefore)
    const nextReview = {
      ...review,
      cards,
      index,
      phase:
        review.phase === 'reviewing' && index >= cards.length ? ('done' as const) : review.phase,
      requeue: accepted.leechSuspended
        ? review.requeue.filter((card) => card.cardId !== accepted.cardId)
        : review.requeue,
      pending: review.pending.filter((pending) => pending.id !== id),
      offline: review.offline.filter((pending) => pending.id !== id),
      leechSuspendedCard:
        leechCard === undefined ? review.leechSuspendedCard : Option.some(leechCard),
      leechSuspendedReviewLapses: accepted.leechSuspended
        ? accepted.reviewLapses
        : review.leechSuspendedReviewLapses,
    }
    const next = modifyFields(base, {
      review: () => nextReview,
    })
    const draining = runQueuedGrade(next)
    return {
      model: draining.model,
      commands: [
        ...(accepted.leechSuspended && Option.isSome(review.dayStartUtc)
          ? persistReviewProgress(model, cards.slice(index))
          : []),
        ...(draining.commands ?? []),
      ],
    }
  },

  ClickedUndoGrade: () => {
    const last = model.review.lastGrade
    if (
      Option.isNone(last) ||
      model.queuedGrades.length > 0 ||
      Option.isSome(model.gradeInFlight)
    ) {
      return { model }
    }
    return {
      model,
      commands: [UndoGrade({ cardId: last.value.cardId, reviewId: last.value.id })],
    }
  },

  UndoneGrade: ({ cardId }) => {
    const review = model.review
    const last = review.lastGrade
    if (
      Option.isNone(last) ||
      last.value.cardId !== cardId ||
      model.queuedGrades.length > 0 ||
      Option.isSome(model.gradeInFlight)
    ) {
      return { model }
    }
    const restoredLeech = Option.match(review.leechSuspendedCard, {
      onNone: () => undefined,
      onSome: (card) => (card.cardId === cardId ? card : undefined),
    })
    // The undone Card steps back to the front: drop its re-queued copy
    // when `Again` appended one, and show it again unrevealed.
    const cards =
      restoredLeech !== undefined
        ? [
            ...review.cards.slice(0, review.index),
            restoredLeech,
            ...review.cards.slice(review.index),
          ]
        : last.value.grade === 'Again'
          ? review.cards.filter((card, index) => index !== review.cards.length - 1)
          : review.cards
    const index = restoredLeech === undefined ? Math.max(0, review.index - 1) : review.index
    return {
      model: modifyFields(model, {
        review: () => ({
          ...review,
          cards,
          index,
          revealed: false,
          requeue: review.requeue.filter((card) => card.cardId !== cardId),
          pending: review.pending.filter((entry) => entry.cardId !== cardId),
          graded: Math.max(0, review.graded - 1),
          lastGrade: Option.none(),
          leechSuspendedCard: Option.none(),
          leechSuspendedReviewLapses: 0,
          undone: true,
          phase: 'reviewing' as const,
          error: Option.none(),
        }),
      }),
      commands: persistReviewProgress(model, cards.slice(index)),
    }
  },

  UndoFailed: ({ error }) => ({
    model: modifyFields(model, {
      review: () => ({ ...model.review, error: Option.some(error) }),
    }),
  }),

  ClickedRetryUndo: () => {
    const last = model.review.lastGrade
    if (
      Option.isNone(last) ||
      model.queuedGrades.length > 0 ||
      Option.isSome(model.gradeInFlight)
    ) {
      return { model }
    }
    return {
      model,
      commands: [UndoGrade({ cardId: last.value.cardId, reviewId: last.value.id })],
    }
  },

  PersistedReviewQueue: () => ({ model }),

  GradeFailed: ({ id, error, durable }) => {
    const queued = model.queuedGrades.find((entry) => entry.id === id)
    if (queued === undefined) return { model }
    const alreadyOffline = model.review.offline.some((entry) => entry.id === id)
    const persisted = durable || queued.persisted
    const offlineEntry = { ...queued, persisted }
    const queuedGrades = model.queuedGrades.map((entry) => (entry.id === id ? offlineEntry : entry))
    return {
      model: {
        ...model,
        queuedGrades,
        gradeInFlight:
          Option.getOrNull(model.gradeInFlight) === id ? Option.none() : model.gradeInFlight,
        gradeBlocked: true,
        review: {
          ...model.review,
          pending: model.review.pending.filter((entry) => entry.id !== id),
          offline: persisted
            ? alreadyOffline
              ? model.review.offline.map((entry) => (entry.id === id ? offlineEntry : entry))
              : [...model.review.offline, offlineEntry]
            : model.review.offline.filter((entry) => entry.id !== id),
          error: Option.some(error),
        },
      },
    }
  },

  ClickedRetryGrades: () =>
    runQueuedGrade({
      ...model,
      gradeBlocked: false,
      review: { ...model.review, error: Option.none() },
    }),

  ClickedContinuePastDueLimit: () => {
    if (
      model.review.phase !== 'done' ||
      !model.review.queueDueCapped ||
      model.review.queueTotalDue === 0
    ) {
      return { model }
    }
    const deckId =
      model.route._tag === 'ReviewDeck' ? Option.some(model.route.deckId) : Option.none()
    return {
      model: modifyFields(model, {
        review: () => ({
          ...model.review,
          phase: 'loading',
          bypassDueLimit: true,
          error: Option.none(),
        }),
      }),
      commands: [
        FetchReviewQueue({
          deckId,
          bypassDueLimit: true,
          sessionId: model.review.queueSessionId,
        }),
      ],
    }
  },

  RegainedNetwork: () => {
    const refreshed = revalidateVisible({
      ...model,
      gradeBlocked: false,
      review: { ...model.review, error: Option.none() },
    })
    const draining = runQueuedGrade(refreshed.model)
    return {
      model: draining.model,
      commands: [...(refreshed.commands ?? []), ...(draining.commands ?? [])],
    }
  },
}))
