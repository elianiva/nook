/**
 * Update: message → model transition, plus `init`.
 *
 * `init` parses the boot URL into the starting Route and seeds the Model;
 * `routeLoads` starts each screen's reads. The list and detail reads are
 * Queries, so `update` folds their Messages through a lifted fold and starts
 * them with `revalidateOrLoad`. A Query shows its own failure and Retry;
 * a `LoadFailed` answer — settings and the review queue — sets the notice.
 *
 * Settings edits write into `settingsDraft` only; Save validates the draft
 * and, when clean, sends it through the save Command, whose answer copies
 * into `settings`.
 */

import { Option } from 'effect'
import { Navigation, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import type { Grade } from '@nook/api'
import { NavigateInternal, NavigateToPath } from './commands'
import {
  DownloadFile,
  FetchExport,
  FetchReviewQueue,
  FetchSettings,
  LoadCachedQueue,
  PersistReviewQueue,
  SaveSettings,
  SubmitGrade,
  UndoGrade,
} from './api-commands'
import { ClearImportJob, PrepareImport, RestoreImportJob } from './import-commands'
import { ApplyTheme } from './theme-commands'
import type { LoadRetry } from './model'
import {
  Message,
  draftFromSettings,
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
 * queue stay plain fetches: the settings form and the review session own their
 * own transitions.
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
        FetchReviewQueue({ deckId: Option.none() }),
        FetchSettings(),
      ],
    }),
    ReviewDeck: ({ deckId }) => ({
      model,
      commands: [
        LoadCachedQueue({ deckId: Option.some(deckId) }),
        FetchReviewQueue({ deckId: Option.some(deckId) }),
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
    // worker can pick it up again.
    commands: [...(loads.commands ?? []), RestoreImportJob()],
  }
}

/** The fetch or save the notice retry runs, rebuilt from the current route and draft. */
const retryCommandsFor = (model: Model, retry: LoadRetry) => {
  switch (retry) {
    case 'reviewQueue': {
      const route = model.route
      if (route._tag === 'ReviewDeck') {
        return [
          LoadCachedQueue({ deckId: Option.some(route.deckId) }),
          FetchReviewQueue({ deckId: Option.some(route.deckId) }),
        ]
      }
      return [
        LoadCachedQueue({ deckId: Option.none() }),
        FetchReviewQueue({ deckId: Option.none() }),
      ]
    }
    case 'settings':
      return [FetchSettings()]
    case 'saveSettings':
      return [SaveSettings({ settings: settingsFromDraft(model) })]
    case 'undoReview': {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return []
      return [UndoGrade({ cardId: last.value.cardId })]
    }
    case 'collectionExport':
      return [FetchExport()]
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
  if (card === undefined || !review.revealed) return { model }
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
      // belong to the old screen.
      return routeLoads({ ...clearNotice(model), route, review: idleReview })
    },

    CompletedNavigate: () => ({ model }),

    GotOverviewMessage: ({ message }) => overview.fold(model, message),

    GotDecksMessage: ({ message }) => decks.fold(model, message),

    GotDeckDetailMessage: ({ message }) => deckDetail.fold(model, message),

    ClickedRetryOverview: () => overview.revalidateOrLoad(model),

    ClickedRetryDecks: () => decks.revalidateOrLoad(model),

    ClickedRetryDeckDetail: ({ deckId }) => deckDetail.revalidateOrLoad(model, { deckId }),

    GotSettings: ({ settings }) => ({
      model: clearNotice({
        ...modifyFields(model, { settings: () => settings }),
        settingsDraft: draftFromSettings(settings),
      }),
    }),

    SavedSettings: ({ settings }) => ({
      model: clearNotice({
        ...modifyFields(model, { settings: () => settings }),
        settingsDraft: { ...draftFromSettings(settings), saved: true },
      }),
    }),

    LoadFailed: ({ error, retry }) => ({
      model: modifyFields(model, { notice: () => Option.some({ message: error, retry }) }),
    }),

    ClickedRetry: () =>
      Option.match(model.notice, {
        onNone: () => ({ model }),
        onSome: (notice) => ({ model, commands: retryCommandsFor(model, notice.retry) }),
      }),

    TypedDecksQuery: ({ value }) => ({
      model: modifyFields(model, { decksQuery: () => value }),
    }),

    // A Start action is a navigation: the review route fetches its own queue.
    StartedReview: ({ deckId }) => {
      const path = Option.match(deckId, {
        onNone: (): AppRoute => ({ _tag: 'Review' }),
        onSome: (id): AppRoute => ({ _tag: 'ReviewDeck', deckId: id }),
      })
      return { model, commands: [NavigateToPath({ path: routeToUrl(path) })] }
    },

    GotReviewQueue: ({ cards, dayStartUtc, lapseMinutes }) => {
      const route = model.route
      const deckId = route._tag === 'ReviewDeck' ? Option.some(route.deckId) : Option.none()
      return {
        model: clearNotice(
          modifyFields(model, {
            // A cached queue answers first; the network answer replaces it
            // only when it carries Cards, so offline Cards never flash away.
            review: () =>
              cards.length === 0 && model.review.cards.length > 0
                ? model.review
                : {
                    ...idleReview,
                    phase: cards.length === 0 ? 'done' : 'reviewing',
                    cards: [...cards],
                    dayStartUtc: Option.some(dayStartUtc),
                    lapseMinutes,
                  },
          }),
        ),
        commands:
          cards.length === 0
            ? []
            : [PersistReviewQueue({ deckId, cards: [...cards], dayStartUtc, lapseMinutes })],
      }
    },

    RevealedAnswer: () => ({
      model: modifyFields(model, { review: () => ({ ...model.review, revealed: true }) }),
    }),

    ClickedGrade: ({ grade }) => gradeCurrent(model, grade),

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

    GradeAccepted: ({ id }) => ({
      model: modifyFields(model, {
        review: () => ({
          ...model.review,
          pending: model.review.pending.filter((entry) => entry.id !== id),
          offline: model.review.offline.filter((entry) => entry.id !== id),
        }),
      }),
    }),

    FlushedOfflineGrade: ({ id }) => ({
      model: modifyFields(model, {
        review: () => ({
          ...model.review,
          pending: model.review.pending.filter((entry) => entry.id !== id),
          offline: model.review.offline.filter((entry) => entry.id !== id),
        }),
      }),
    }),

    ClickedUndoGrade: () => {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return { model }
      return { model, commands: [UndoGrade({ cardId: last.value.cardId })] }
    },

    UndoneGrade: ({ cardId }) => {
      const review = model.review
      const last = review.lastGrade
      if (Option.isNone(last) || last.value.cardId !== cardId) return { model }
      // The undone Card steps back to the front: drop its re-queued copy
      // when `Again` appended one, and show it again unrevealed.
      const cards =
        last.value.grade === 'Again'
          ? review.cards.filter((card, index) => index !== review.cards.length - 1)
          : review.cards
      return {
        model: modifyFields(model, {
          review: () => ({
            ...review,
            cards,
            index: Math.max(0, review.index - 1),
            revealed: false,
            requeue: review.requeue.filter((card) => card.cardId !== cardId),
            pending: review.pending.filter((entry) => entry.cardId !== cardId),
            graded: Math.max(0, review.graded - 1),
            lastGrade: Option.none(),
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

    PersistedReviewQueue: () => ({ model }),

    GradeFailed: ({ error }) => {
      // Offline or dropped: the grade stays applied on screen and waits in
      // `offline` for the network, leaving `pending` so Retry sends it once.
      // Its id is stable, so the flush cannot double-apply it (ADR 0002).
      const waiting = model.review.pending.slice(-1)
      return {
        model: modifyFields(model, {
          review: () => ({
            ...model.review,
            pending: model.review.pending.slice(0, -1),
            offline: [...model.review.offline, ...waiting],
            error: Option.some(error),
          }),
        }),
      }
    },

    ClickedRetryGrades: () => ({
      model: modifyFields(model, {
        review: () => ({ ...model.review, error: Option.none() }),
      }),
      commands: [...model.review.pending, ...model.review.offline].map((entry) =>
        SubmitGrade(entry),
      ),
    }),

    RegainedNetwork: () => {
      const queued = model.review.offline
      if (queued.length === 0) return { model }
      return {
        model: modifyFields(model, {
          review: () => ({ ...model.review, error: Option.none() }),
        }),
        commands: queued.map((entry) => SubmitGrade(entry)),
      }
    },

    // Clear the last Import and show "preparing" while the picker is open and
    // the archive is hashed. `active` stays false, so no worker starts yet.
    ClickedImport: () => ({
      model: { ...model, importState: { ...idleImport, phase: 'preparing' } },
      commands: [PrepareImport()],
    }),

    CancelledImportSelect: () => ({ model: { ...model, importState: idleImport } }),

    GotImportFile: ({ id, filename }) => ({
      model: {
        ...model,
        importState: {
          id: Option.some(id),
          filename,
          active: true,
          phase: 'running',
          status: Option.none(),
          error: Option.none(),
        },
      },
    }),

    // A kept archive means an Import was interrupted. Resume it: the worker
    // calls `start` again and D1 returns the cursors it stopped at.
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
              status: Option.none(),
              error: Option.none(),
            },
          },
        }),
      }),

    ImportWorkerPhase: ({ phase }) => ({
      model: { ...model, importState: { ...model.importState, phase } },
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

    // The archive is kept, so Retry can resume without another file pick.
    FailedImport: ({ error }) => ({
      model: {
        ...model,
        importState: {
          ...model.importState,
          active: false,
          phase: 'failed',
          error: Option.some(error),
        },
      },
    }),

    ClickedRetryImport: () =>
      Option.match(model.importState.id, {
        onNone: () => ({ model }),
        onSome: () => ({
          model: {
            ...model,
            importState: {
              ...model.importState,
              active: true,
              phase: 'running',
              error: Option.none(),
            },
          },
        }),
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

    EditedRetention: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          desiredRetention: toNumber(value, model.settingsDraft.desiredRetention),
          saved: false,
        },
      },
    }),

    EditedWeights: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, weightsText: value, saved: false },
      },
    }),

    EditedMaximumInterval: ({ value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          maximumInterval: toInt(value, model.settingsDraft.maximumInterval),
          saved: false,
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
        },
      },
    }),

    ToggledTapToReveal: ({ isChecked }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, tapToReveal: isChecked, saved: false },
      },
    }),

    // The pick applies at once: the Command writes the DOM + storage, and the
    // section re-reads the stored value so the picked swatch marks itself as
    // current without waiting for the answer. Unknown values never reach the
    // view — `settingsView` only sends keys from `themeKeys`.
    PickedTheme: ({ theme }) => ({ model, commands: [ApplyTheme({ theme })] }),

    AppliedTheme: () => ({ model }),

    ClickedSaveSettings: () => {
      const error = validateDraft(model.settingsDraft)
      if (error !== undefined) {
        return {
          model: {
            ...model,
            settingsDraft: {
              ...model.settingsDraft,
              weightsError: Option.some(error),
              saved: false,
            },
          },
        }
      }
      return {
        model: {
          ...model,
          settingsDraft: { ...model.settingsDraft, weightsError: Option.none(), saved: false },
        },
        commands: [SaveSettings({ settings: settingsFromDraft(model) })],
      }
    },

    ClickedResetSettings: () => ({
      model: { ...model, settingsDraft: draftFromSettings(model.settings) },
    }),
  })
