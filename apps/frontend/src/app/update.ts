/**
 * Update: message → model transition, plus `init`.
 *
 * `init` parses the boot URL into the starting Route and seeds the Model;
 * `routeLoads` starts each screen's reads. The list and detail reads are
 * Queries, so `update` folds their Messages through a lifted fold and starts
 * them with `revalidateOrLoad`. A Query shows its own failure and Retry;
 * a `LoadFailed` answer — settings and the review queue — sets the notice.
 *
 * Settings edits write into `settingsDraft`; Save validates and applies that
 * draft optimistically, with the prior server value retained for rollback.
 */

import { HashMap, Option } from 'effect'
import { Navigation, Update } from 'foldkit'
import { AsyncData } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import type { DeckDetail, DeckId, DeckLimits, DeckSummary, Grade } from '@nook/api'
import { NavigateInternal, NavigateToPath } from './commands'
import {
  DownloadFile,
  FetchExport,
  FetchReviewQueue,
  FetchSettings,
  LoadCachedQueue,
  PersistReviewQueue,
  ReloadApp,
  RestoreQueuedGrades,
  RemoveDeck,
  RenameDeck,
  ResetDeck,
  SaveDeckLimits,
  SaveSettings,
  SetCardSuspended,
  SubmitGrade,
  UndoGrade,
} from './api-commands'
import { ClearImportJob, PrepareImport, RestoreImportJob } from './import-commands'
import { RestoreQueries } from './query-commands'
import { ApplyTheme } from './theme-commands'
import { foldHintMessage } from './hints'
import type { LoadRetry } from './model'
import type { RestoredAnswer } from './model'
import type { DeckCacheSnapshot } from './model'
import {
  Message,
  draftFromSettings,
  idleDeckManage,
  idleImport,
  idleReview,
  seedModel,
  validateDraft,
} from './model'
import type { Model } from './model'
import { deckDetailQuery, decksQuery, overviewQuery } from './queries'
import { AppRoute, routeToUrl, urlToAppRoute } from './routes'

/**
 * The parent side of each Query: `lift` binds a Query's Model field and its
 * Messages to this app's Model and Message types.
 */
const overview = overviewQuery.lift<Model, Message>({
  parentField: 'overview',
  toParentMessage: (message) => Message.GotOverviewMessage({ message }),
})

const decks = decksQuery.lift<Model, Message>({
  parentField: 'decks',
  toParentMessage: (message) => Message.GotDecksMessage({ message }),
})

const deckDetail = deckDetailQuery.lift<Model, Message>({
  parentField: 'deckDetail',
  toParentMessage: (message) => Message.GotDeckDetailMessage({ message }),
})

/**
 * The reads a route starts. A Query loads when it is missing and refreshes when
 * it has data, so returning to a screen shows its last answer while a fresh one
 * arrives; the already-pending case starts nothing. Settings and the review
 * queue stay out of the Query cache: the settings form and the review session
 * own their own transitions.
 */
const routeLoads = (model: Model): Update.Return<Model, Message> =>
  AppRoute.match<Update.Return<Model, Message>>(model.route, {
    Home: () =>
      Update.combine<Model, Message>(model, [overview.revalidateOrLoad, decks.revalidateOrLoad]),
    Decks: () => decks.revalidateOrLoad(model),
    DeckDetail: ({ deckId }) => deckDetail.revalidateOrLoad(model, { deckId }),
    Review: () => ({
      model,
      commands: [
        LoadCachedQueue({ deckId: Option.none() }),
        FetchReviewQueue({ deckId: Option.none(), bypassDueLimit: false }),
        FetchSettings(),
      ],
    }),
    ReviewDeck: ({ deckId }) => ({
      model,
      commands: [
        LoadCachedQueue({ deckId: Option.some(deckId) }),
        FetchReviewQueue({ deckId: Option.some(deckId), bypassDueLimit: false }),
        FetchSettings(),
      ],
    }),
    Settings: () => ({ model, commands: [FetchSettings()] }),
    NotFound: () => ({ model }),
  })

export const init = (url: Url): Update.Return<Model, Message> => {
  const loads = routeLoads(seedModel(url))
  return {
    model: loads.model,
    // An Import interrupted by a reload is still in IndexedDB; restore it so the
    // worker can pick it up again. Cached list answers reseed the Queries, so
    // a cold boot offline still shows the last data while the route loads run.
    commands: [
      ...(loads.commands ?? []),
      RestoreImportJob(),
      RestoreQueries(),
      RestoreQueuedGrades(),
    ],
  }
}

/**
 * The queries the current route shows, refreshed. Review and settings own
 * their reads, so only the list and detail Queries revalidate here; the
 * grade flush in `RegainedNetwork` is untouched.
 */
const revalidateVisible = (model: Model): Update.Return<Model, Message> =>
  AppRoute.match<Update.Return<Model, Message>>(model.route, {
    Home: () => Update.combine<Model, Message>(model, [overview.revalidate, decks.revalidate]),
    Decks: () => decks.revalidate(model),
    DeckDetail: ({ deckId }) => deckDetail.revalidate(model, { deckId }),
    Review: () => ({ model }),
    ReviewDeck: () => ({ model }),
    Settings: () => ({ model }),
    NotFound: () => ({ model }),
  })

/** The fetch or save the notice retry runs, rebuilt from the current route and draft. */
const retryCommandsFor = (model: Model, retry: LoadRetry) => {
  switch (retry) {
    case 'reviewQueue': {
      const route = model.route
      if (route._tag === 'ReviewDeck') {
        return [
          LoadCachedQueue({ deckId: Option.some(route.deckId) }),
          FetchReviewQueue({
            deckId: Option.some(route.deckId),
            bypassDueLimit: model.review.bypassDueLimit,
          }),
        ]
      }
      return [
        LoadCachedQueue({ deckId: Option.none() }),
        FetchReviewQueue({ deckId: Option.none(), bypassDueLimit: model.review.bypassDueLimit }),
      ]
    }
    case 'settings':
      return [FetchSettings()]
    case 'saveSettings':
      return [SaveSettings({ settings: settingsFromDraft(model) })]
    case 'queuedGrades':
      return [RestoreQueuedGrades()]
    case 'undoReview': {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return []
      return [UndoGrade({ cardId: last.value.cardId })]
    }
    case 'collectionExport':
      return [FetchExport()]
  }
}

const beginSettingsSave = (model: Model): Model => {
  const settings = settingsFromDraft(model)
  return {
    ...model,
    settings,
    settingsRollback: Option.some(model.settings),
    settingsDraft: {
      ...model.settingsDraft,
      weightsError: Option.none(),
      saved: false,
      saving: true,
    },
    notice: Option.none(),
  }
}

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? fallback : parsed
}

const toInt = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isInteger(parsed) ? fallback : parsed
}

/** Parses a limit field: blank means `null` (follow Settings), else a whole number at least `min`. */
const parseLimit = (value: string, min: number): number | null | undefined => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min ? parsed : undefined
}

const settingsFromDraft = (model: Model) => {
  const weights = model.settingsDraft.weightsText.split(',').map((part) => Number(part.trim()))
  return {
    fsrs: {
      desiredRetention: model.settingsDraft.desiredRetention,
      weights,
      maximumInterval: model.settingsDraft.maximumInterval,
      newPerDay: model.settingsDraft.newPerDay,
      reviewsPerDay: model.settingsDraft.reviewsPerDay,
      lapseMinutes: model.settingsDraft.lapseMinutes,
    },
    behaviour: {
      tapToReveal: model.settingsDraft.tapToReveal,
      dayRolloverHour: model.settingsDraft.dayRolloverHour,
    },
  }
}

const clearNotice = (model: Model): Model => ({ ...model, notice: Option.none() })

/**
 * Folds restored answers into their Query Models as `Success`.
 *
 * Only `Idle` Queries take the seed: a fetch that already completed holds
 * fresher data, and a request in flight keeps its `Loading`/`Refreshing`
 * state so the generation guard still matches its answer. Deck-detail
 * entries key on the encoded args, the same key `read` resolves.
 */
const seedCachedQueries = (model: Model, answers: ReadonlyArray<RestoredAnswer>): Model => {
  let next = model
  for (const answer of answers) {
    if (answer.kind === 'overview') {
      if (AsyncData.isIdle(overviewQuery.read(next.overview))) {
        next = { ...next, overview: { ...next.overview, data: AsyncData.succeed(answer.value) } }
      }
    } else if (answer.kind === 'decks') {
      if (AsyncData.isIdle(decksQuery.read(next.decks))) {
        next = { ...next, decks: { ...next.decks, data: AsyncData.succeed(answer.value) } }
      }
    } else {
      if (!AsyncData.isIdle(deckDetailQuery.read(next.deckDetail, { deckId: answer.deckId }))) {
        continue
      }
      // Single-field args encode to one JSON object with sorted keys, which
      // `JSON.stringify` matches: no key ordering to canonicalize.
      const key = deckDetailKey(answer.deckId)
      next = {
        ...next,
        deckDetail: {
          ...next.deckDetail,
          entries: HashMap.set(next.deckDetail.entries, key, {
            args: { deckId: answer.deckId },
            data: AsyncData.succeed(answer.value),
            generation: next.deckDetail.generation,
          }),
        },
      }
    }
  }
  return next
}

const deckDetailKey = (deckId: DeckId): string => JSON.stringify({ deckId })

const deckCacheSnapshot = (model: Model, deckId: DeckId) => ({
  deckId,
  summaries: AsyncData.getData(decksQuery.read(model.decks)),
  detail: AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })),
})

/** Applies one optimistic summary edit to every loaded cache for this deck. */
const updateDeckCache = (
  model: Model,
  deckId: DeckId,
  updateSummary: (summary: DeckSummary) => DeckSummary,
): Model => {
  const summaryMatches = (summary: DeckSummary): DeckSummary =>
    summary.id === deckId ? updateSummary(summary) : summary
  const summaries = AsyncData.map(model.decks.data, (rows) => rows.map(summaryMatches))
  const key = deckDetailKey(deckId)
  const entry = HashMap.get(model.deckDetail.entries, key)
  const detailModel = Option.match(entry, {
    onNone: () => model.deckDetail,
    onSome: (cached) => ({
      ...model.deckDetail,
      entries: HashMap.set(model.deckDetail.entries, key, {
        ...cached,
        data: AsyncData.map(cached.data, (detail: DeckDetail) => ({
          ...detail,
          summary: updateSummary(detail.summary),
        })),
      }),
    }),
  })
  return {
    ...model,
    decks: { ...model.decks, data: summaries },
    deckDetail: detailModel,
  }
}

/** Rolls an optimistic cache edit back to its server values after failure. */
const restoreDeckCache = (model: Model, snapshot: DeckCacheSnapshot): Model => {
  let restored = model
  if (Option.isSome(snapshot.summaries)) {
    restored = {
      ...restored,
      decks: { ...restored.decks, data: AsyncData.succeed(snapshot.summaries.value) },
    }
  }
  if (Option.isSome(snapshot.detail)) {
    const key = deckDetailKey(snapshot.deckId)
    const entry = HashMap.get(restored.deckDetail.entries, key)
    if (Option.isSome(entry)) {
      restored = {
        ...restored,
        deckDetail: {
          ...restored.deckDetail,
          entries: HashMap.set(restored.deckDetail.entries, key, {
            ...entry.value,
            data: AsyncData.succeed(snapshot.detail.value),
          }),
        },
      }
    }
  }
  return restored
}

/**
 * Applies a Grade on screen and sends it.
 *
 * The screen advances before the request lands, so grading never waits for the
 * network. The Grade rides in `pending` until the server confirms it, and a
 * Retry reuses the same id, so a Grade that landed but was not acknowledged is
 * not applied twice (ADR 0002). An `Again` grade re-queues its Card later this
 * session; the queue grows by one and the session ends only when both the
 * queue and the re-queue are walked. The grade is also the undo point until
 * the next grade lands.
 */
const gradeCurrent = (model: Model, grade: Grade): Update.Return<Model, Message> => {
  const review = model.review
  const card = review.cards[review.index]
  if (card === undefined || !review.revealed || Option.isSome(review.suspensionPending)) {
    return { model }
  }
  const entry = { id: crypto.randomUUID(), cardId: card.cardId, grade }
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
    commands: [SubmitGrade(entry)],
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedLink: ({ request }) =>
      Navigation.UrlRequest.match(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url })] }),
        External: () => ({ model }),
      }),

    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url)
      // A new screen means new loads; the old notice and the old review session
      // belong to the old screen. The Manage draft belongs to one Deck, so it
      // resets too — a stale name must never leak onto another deck's page.
      return routeLoads({
        ...clearNotice(model),
        route,
        review: idleReview,
        deckManage: idleDeckManage,
        cardSuspensionPending: Option.none(),
        cardSuspensionError: Option.none(),
      })
    },

    CompletedNavigate: () => ({ model }),

    GotOverviewMessage: ({ message }) => overview.fold(model, message),

    GotDecksMessage: ({ message }) => decks.fold(model, message),

    GotDeckDetailMessage: ({ message }) => deckDetail.fold(model, message),

    ClickedRetryOverview: () => overview.revalidateOrLoad(model),

    ClickedRetryDecks: () => decks.revalidateOrLoad(model),

    ClickedRetryDeckDetail: ({ deckId }) => deckDetail.revalidateOrLoad(model, { deckId }),

    // Hover or focus on a deck link: warm the detail Query while it is still
    // missing. `loadIfMissing` starts nothing when data or a request is there.
    PrefetchedDeckDetail: ({ deckId }) => deckDetail.loadIfMissing(model, { deckId }),

    GotSettings: ({ settings }) => ({
      model: Option.isSome(model.settingsRollback)
        ? model
        : clearNotice({
            ...modifyFields(model, { settings: () => settings }),
            settingsDraft: draftFromSettings(settings),
          }),
    }),

    SavedSettings: ({ settings }) => {
      const draft = model.settingsDraft.saving
        ? { ...draftFromSettings(settings), saved: true }
        : model.settingsDraft
      return {
        model: clearNotice({
          ...modifyFields(model, {
            settings: () => settings,
            settingsRollback: () => Option.none(),
          }),
          settingsDraft: draft,
        }),
      }
    },

    RestoredQueuedGrades: ({ grades }) => {
      const known = new Set(model.queuedGrades.map((entry) => entry.id))
      const restored = grades.filter((entry) => !known.has(entry.id))
      const queuedGrades = [...model.queuedGrades, ...restored]
      const pendingIds = new Set(model.review.pending.map((entry) => entry.id))
      const offline = queuedGrades.filter((entry) => !pendingIds.has(entry.id))
      return {
        model: {
          ...model,
          queuedGrades,
          review: { ...model.review, offline },
        },
        commands: restored.map((entry) => SubmitGrade(entry)),
      }
    },

    LoadFailed: ({ error, retry }) => {
      let next = model
      if (retry === 'saveSettings' && Option.isSome(model.settingsRollback)) {
        next = {
          ...model,
          settings: model.settingsRollback.value,
          settingsRollback: Option.none(),
          settingsDraft: { ...model.settingsDraft, saving: false },
        }
      }
      return {
        model: modifyFields(next, {
          notice: () => Option.some({ message: error, retry }),
          ...(retry === 'reviewQueue' && model.review.bypassDueLimit
            ? { review: () => ({ ...model.review, phase: 'done' as const }) }
            : {}),
        }),
      }
    },

    ClickedRetry: () =>
      Option.match(model.notice, {
        onNone: () => ({ model }),
        onSome: (notice) =>
          notice.retry === 'saveSettings'
            ? {
                model: beginSettingsSave(model),
                commands: [SaveSettings({ settings: settingsFromDraft(model) })],
              }
            : { model, commands: retryCommandsFor(model, notice.retry) },
      }),

    // A Start action is a navigation: the review route fetches its own queue.
    StartedReview: ({ deckId }) => {
      const path = Option.match(deckId, {
        onNone: (): AppRoute => ({ _tag: 'Review' }),
        onSome: (id): AppRoute => ({ _tag: 'ReviewDeck', deckId: id }),
      })
      return { model, commands: [NavigateToPath({ path: routeToUrl(path) })] }
    },

    GotReviewQueue: ({
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
      const route = model.route
      const deckId = route._tag === 'ReviewDeck' ? Option.some(route.deckId) : Option.none()
      // The queue is empty for two reasons: nothing waits, or a limit
      // stopped everything. Only a capped empty queue is a limit stop — a
      // short fetch (fewer Cards than the limit allows) is just empty.
      const limitStopped = cards.length === 0 && (newCapped || dueCapped || totalNew + totalDue > 0)
      const queueCounts = {
        queueTotalDue: totalDue,
        queueTotalNew: totalNew,
        queueReviewedToday: reviewedToday,
        queueNewToday: newToday,
        queueNewCapped: newCapped,
        queueDueCapped: dueCapped,
        queueServedDue: cards.filter((card) => card.state !== 'new').length,
        queueServedNew: cards.filter((card) => card.state === 'new').length,
      }
      return {
        model: clearNotice(
          modifyFields(model, {
            // A cached queue answers first; the network answer replaces it
            // only when it carries Cards, so offline Cards never flash away.
            review: () =>
              beyondLimit
                ? {
                    ...model.review,
                    cards: [...model.review.cards, ...cards],
                    index: model.review.cards.length,
                    revealed: false,
                    phase: cards.length === 0 ? 'done' : 'reviewing',
                    dayStartUtc: Option.some(dayStartUtc),
                    lapseMinutes,
                    doneKind: cards.length === 0 && (newCapped || dueCapped) ? 'limits' : 'empty',
                    bypassDueLimit: true,
                    queueTotalDue: totalDue,
                    queueTotalNew: 0,
                    queueReviewedToday: reviewedToday,
                    queueNewToday: newToday,
                    queueNewCapped: false,
                    queueDueCapped: dueCapped,
                    queueServedDue:
                      model.review.queueServedDue +
                      cards.filter((card) => card.state !== 'new').length,
                    queueServedNew: model.review.queueServedNew,
                  }
                : cards.length === 0 && model.review.cards.length > 0
                  ? model.review
                  : {
                      ...idleReview,
                      offline: model.queuedGrades,
                      phase: cards.length === 0 ? 'done' : 'reviewing',
                      cards: [...cards],
                      dayStartUtc: Option.some(dayStartUtc),
                      lapseMinutes,
                      doneKind: limitStopped ? 'limits' : 'empty',
                      bypassDueLimit: false,
                      ...queueCounts,
                    },
          }),
        ),
        commands:
          cards.length === 0 || beyondLimit
            ? []
            : [PersistReviewQueue({ deckId, cards: [...cards], dayStartUtc, lapseMinutes })],
      }
    },

    RevealedAnswer: () => ({
      model: modifyFields(model, { review: () => ({ ...model.review, revealed: true }) }),
    }),

    ClickedGrade: ({ grade }) => gradeCurrent(model, grade),

    ClickedSuspendCurrentCard: () => {
      const card = model.review.cards[model.review.index]
      if (
        model.review.phase !== 'reviewing' ||
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
        }
      }
      if (origin === 'deck' && model.route._tag === 'DeckDetail') {
        const next = modifyFields(model, {
          cardSuspensionPending: () => Option.none(),
          cardSuspensionError: () => Option.none(),
        })
        return Update.combine<Model, Message>(next, [
          decks.revalidateOrLoad,
          (current) => deckDetail.revalidateOrLoad(current, { deckId: model.route.deckId }),
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

    PressedGrade: ({ grade }) => gradeCurrent(model, grade),

    // Space reveals, then grades Good: the one-hand rhythm.
    PressedSpace: () => {
      const review = model.review
      if (review.phase !== 'reviewing') return { model }
      if (!review.revealed) {
        return { model: modifyFields(model, { review: () => ({ ...review, revealed: true }) }) }
      }
      return gradeCurrent(model, 'Good')
    },

    GradeAccepted: ({ id, accepted }) => {
      const review = model.review
      const queuedGrades = model.queuedGrades.filter((entry) => entry.id !== id)
      const entry =
        review.pending.find((pending) => pending.id === id) ??
        review.offline.find((pending) => pending.id === id)
      if (entry === undefined) return { model: { ...model, queuedGrades } }
      const leechCard = accepted.leechSuspended
        ? (review.cards.find((card) => card.cardId === accepted.cardId) ??
          review.requeue.find((card) => card.cardId === accepted.cardId))
        : undefined
      const removedBefore = accepted.leechSuspended
        ? review.cards
            .slice(0, review.index)
            .filter((card) => card.cardId === accepted.cardId).length
        : 0
      const cards = accepted.leechSuspended
        ? review.cards.filter((card) => card.cardId !== accepted.cardId)
        : review.cards
      const index = Math.max(0, review.index - removedBefore)
      return {
        model: modifyFields(model, {
          queuedGrades: () => queuedGrades,
          review: () => ({
            ...review,
            cards,
            index,
            phase:
              review.phase === 'reviewing' && index >= cards.length ? 'done' : review.phase,
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
          }),
        }),
      }
    },

    ClickedUndoGrade: () => {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return { model }
      return { model, commands: [UndoGrade({ cardId: last.value.cardId })] }
    },

    UndoneGrade: ({ cardId }) => {
      const review = model.review
      const last = review.lastGrade
      if (Option.isNone(last) || last.value.cardId !== cardId) return { model }
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
      return {
        model: modifyFields(model, {
          review: () => ({
            ...review,
            cards,
            index: restoredLeech === undefined ? Math.max(0, review.index - 1) : review.index,
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
      }
    },

    UndoFailed: ({ error }) => ({
      model: modifyFields(model, {
        review: () => ({ ...model.review, error: Option.some(error) }),
      }),
    }),

    ClickedRetryUndo: () => {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return { model }
      return { model, commands: [UndoGrade({ cardId: last.value.cardId })] }
    },

    ClickedExport: () => ({ model, commands: [FetchExport()] }),

    GotExport: ({ filename, json }) => ({
      model,
      commands: [DownloadFile({ filename, json })],
    }),

    ExportFailed: ({ error }) => ({
      model: modifyFields(model, {
        notice: () => Option.some({ message: error, retry: 'collectionExport' as const }),
      }),
    }),

    DownloadedExport: () => ({ model }),

    AppliedSwUpdate: () => ({ model }),

    ClickedReloadApp: () => ({ model, commands: [ReloadApp()] }),

    PersistedReviewQueue: () => ({ model }),

    GradeFailed: ({ id, error, durable }) => {
      // Offline or dropped: the grade stays applied on screen and waits in
      // `offline` for the network, leaving `pending` so Retry sends it once.
      // Its id is stable, so the flush cannot double-apply it (ADR 0002).
      const waiting = model.review.pending.find((entry) => entry.id === id)
      const alreadyOffline = model.review.offline.some((entry) => entry.id === id)
      if (waiting === undefined && !alreadyOffline) return { model }
      const persisted = durable || alreadyOffline
      return {
        model: modifyFields(model, {
          review: () => ({
            ...model.review,
            pending: model.review.pending.filter((entry) => entry.id !== id),
            offline: persisted
              ? alreadyOffline || waiting === undefined
                ? model.review.offline
                : [...model.review.offline, waiting]
              : model.review.offline.filter((entry) => entry.id !== id),
            error: Option.some(error),
          }),
        }),
      }
    },

    ClickedRetryGrades: () => ({
      model: modifyFields(model, {
        review: () => ({ ...model.review, error: Option.none() }),
      }),
      commands: model.queuedGrades.map((entry) => SubmitGrade(entry)),
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
        commands: [FetchReviewQueue({ deckId, bypassDueLimit: true })],
      }
    },

    RegainedNetwork: () => {
      const queued = model.queuedGrades
      const refreshed = revalidateVisible(
        modifyFields(model, {
          review: () => ({ ...model.review, error: Option.none() }),
        }),
      )
      if (queued.length === 0) return refreshed
      return {
        model: refreshed.model,
        commands: [...(refreshed.commands ?? []), ...queued.map((entry) => SubmitGrade(entry))],
      }
    },

    // The tab became visible, or the entry above fired: refresh what is shown.
    RevalidateVisible: () => revalidateVisible(model),

    // The picker runs with no panel behind it: nothing shows until a file is
    // picked. `active` stays false, so no worker starts yet.
    ClickedImport: () => ({
      model,
      commands: [PrepareImport()],
    }),

    CancelledImportSelect: () => ({ model }),

    // The pick opens the detail panel; the preview worker reads what the
    // archive holds while it shows. Nothing writes until the Learner presses
    // Start. A failed preview lands the same way, on the panel.
    GotImportFile: ({ id, filename }) => ({
      model: {
        ...model,
        importState: {
          id: Option.some(id),
          filename,
          active: true,
          phase: 'preview',
          readStage: Option.none(),
          preview: Option.none(),
          includeMedia: true,
          status: Option.none(),
          error: Option.none(),
        },
      },
    }),

    GotImportPreview: ({ preview }) => ({
      model: {
        ...model,
        importState: {
          ...model.importState,
          // The preview worker answered, so it can tear down: `active` off
          // ends the subscription stream. Start turns it back on for the run.
          active: false,
          phase: 'preview',
          readStage: Option.none(),
          preview: Option.some(preview),
          error: Option.none(),
        },
      },
    }),

    ToggledImportMedia: ({ isChecked }) => ({
      model: {
        ...model,
        importState: { ...model.importState, includeMedia: isChecked },
      },
    }),

    // Start hands the run to the worker with the Learner's Media choice. The
    // subscription starts it because the phase moved, not because of a
    // Command here.
    ClickedStartImport: () =>
      model.importState.phase === 'preview' && Option.isSome(model.importState.id)
        ? {
            model: {
              ...model,
              importState: {
                ...model.importState,
                active: true,
                phase: 'running',
                readStage: Option.none(),
                status: Option.none(),
                error: Option.none(),
              },
            },
          }
        : { model },

    // A kept archive means an Import was interrupted. Resume it: the worker
    // calls `start` again and D1 returns the cursors it stopped at. Resume
    // past the detail panel: the pick already happened, and the preview would
    // only re-read what the run is about to write.
    RestoredImportJob: ({ job }) =>
      Option.match(job, {
        onNone: () => ({ model }),
        onSome: (restored) => ({
          model: {
            ...model,
            importState: {
              id: Option.some(restored.id),
              filename: restored.filename,
              active: true,
              phase: 'running',
              readStage: Option.none(),
              preview: Option.none(),
              includeMedia: true,
              status: Option.none(),
              error: Option.none(),
            },
          },
        }),
      }),

    // Cached list answers reseed their Queries as `Success`, so a cold boot
    // offline shows the last data at once. The route loads already started
    // move each Query to `Refreshing` when they run; a seed that arrives
    // after a fetch completed only fills Queries still `Idle`, so a fresh
    // answer never loses to an older cache.
    RestoredCachedQueries: ({ answers }) => ({ model: seedCachedQueries(model, answers) }),

    // A newer shell waits in the worker. The banner offers the reload; the
    // learner takes it when no review is in flight — never forced.
    ServiceWorkerAvailable: () => ({ model: { ...model, swUpdateReady: true } }),

    ImportWorkerPhase: ({ phase }) => ({
      model: {
        ...model,
        importState: {
          ...model.importState,
          phase,
          // The read is over once the worker moves on; a retry starts it anew.
          readStage: phase === 'reading' ? model.importState.readStage : Option.none(),
        },
      },
    }),

    ReportedImportReadStage: ({ stage }) => ({
      model: {
        ...model,
        importState: { ...model.importState, readStage: Option.some(stage) },
      },
    }),

    ReportedImport: ({ progress }) => ({
      model: { ...model, importState: { ...model.importState, status: Option.some(progress) } },
    }),

    CompletedImport: ({ progress }) => {
      const next: Model = {
        ...model,
        importState: {
          id: Option.none(),
          filename: model.importState.filename,
          active: false,
          phase: 'done',
          readStage: Option.none(),
          preview: model.importState.preview,
          includeMedia: model.importState.includeMedia,
          status: Option.some(progress),
          error: Option.none(),
        },
      }
      // The Decks page paints what the Import just wrote, and the archive is no
      // longer needed.
      return Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => ({ model: current, commands: [ClearImportJob()] }),
      ])
    },

    // The archive is kept, so Retry can resume without another file pick. A
    // failed preview keeps the detail panel, so the Learner can retry the
    // read or pick another file; a failed run keeps its cursors for Retry.
    FailedImport: ({ error }) =>
      model.importState.phase === 'preview'
        ? {
            model: {
              ...model,
              importState: {
                ...model.importState,
                active: false,
                preview: Option.none(),
                status: Option.none(),
                error: Option.some(error),
              },
            },
          }
        : {
            model: {
              ...model,
              importState: {
                ...model.importState,
                active: false,
                phase: 'failed',
                error: Option.some(error),
              },
            },
          },

    ClickedRetryImport: () =>
      Option.match(model.importState.id, {
        onNone: () => ({ model }),
        // A failed preview retries the read: back to waiting for the preview
        // worker, which the subscription starts. A failed run retries the run.
        onSome: () =>
          model.importState.phase === 'preview'
            ? {
                model: {
                  ...model,
                  importState: {
                    ...model.importState,
                    active: true,
                    preview: Option.none(),
                    readStage: Option.none(),
                    error: Option.none(),
                  },
                },
              }
            : {
                model: {
                  ...model,
                  importState: {
                    ...model.importState,
                    active: true,
                    phase: 'running',
                    error: Option.none(),
                  },
                },
              },
      }),

    // Stopping a run tears the worker down and forgets the archive, which is
    // what "active" going false makes the subscription do. The Import's cursors
    // stay in D1, so importing the same file again later resumes it.
    ClickedCancelImport: () => ({
      model: { ...model, importState: idleImport },
      commands: [ClearImportJob()],
    }),

    ClickedDismissImport: () => ({
      model: { ...model, importState: idleImport },
      commands: [ClearImportJob()],
    }),

    ClearedImportJob: () => ({ model }),

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
      return Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => deckDetail.revalidateOrLoad(current, { deckId }),
      ])
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
    }),

    ClickedCancelDeckConfirm: () => ({
      model: modifyFields(model, {
        deckManage: () => ({
          ...model.deckManage,
          confirming: Option.none(),
          error: Option.none(),
        }),
      }),
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
      return Update.combine<Model, Message>(next, [
        decks.revalidateOrLoad,
        (current) => deckDetail.revalidateOrLoad(current, { deckId }),
      ])
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

    EditedRetention: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          desiredRetention: toNumber(value, model.settingsDraft.desiredRetention),
          saved: false,
          saving: false,
        },
      },
    }),

    EditedWeights: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, weightsText: value, saved: false, saving: false },
      },
    }),

    EditedMaximumInterval: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          maximumInterval: toInt(value, model.settingsDraft.maximumInterval),
          saved: false,
          saving: false,
        },
      },
    }),

    EditedNewPerDay: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          newPerDay: toInt(value, model.settingsDraft.newPerDay),
          saved: false,
          saving: false,
        },
      },
    }),

    EditedReviewsPerDay: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          reviewsPerDay: toInt(value, model.settingsDraft.reviewsPerDay),
          saved: false,
          saving: false,
        },
      },
    }),

    EditedLapseMinutes: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          lapseMinutes: toInt(value, model.settingsDraft.lapseMinutes),
          saved: false,
          saving: false,
        },
      },
    }),

    EditedRolloverHour: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          dayRolloverHour: toInt(value, model.settingsDraft.dayRolloverHour),
          saved: false,
          saving: false,
        },
      },
    }),

    ToggledTapToReveal: ({ isChecked }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          tapToReveal: isChecked,
          saved: false,
          saving: false,
        },
      },
    }),

    // The pick applies at once: the Command writes the DOM + storage, and the
    // Model mirrors the pick so the section re-renders with the ring on the
    // picked swatch. Unknown values never reach the view — `settingsView`
    // only sends keys from `themeKeys`.
    PickedTheme: ({ theme }) => ({
      model: { ...model, theme },
      commands: [ApplyTheme({ theme })],
    }),

    AppliedTheme: () => ({ model }),

    ClickedSaveSettings: () => {
      if (model.settingsDraft.saving || Option.isSome(model.settingsRollback)) return { model }
      const error = validateDraft(model.settingsDraft)
      if (error !== undefined) {
        return {
          model: {
            ...model,
            settingsDraft: {
              ...model.settingsDraft,
              weightsError: Option.some(error),
              saved: false,
              saving: false,
            },
          },
        }
      }
      const next = beginSettingsSave(model)
      return {
        model: next,
        commands: [SaveSettings({ settings: settingsFromDraft(model) })],
      }
    },

    ClickedResetSettings: () => ({
      model: { ...model, settingsDraft: draftFromSettings(model.settings) },
    }),

    GotHintMessage: ({ slot, message }) => foldHintMessage(model, slot, message),
  })
