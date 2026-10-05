/**
 * Update: message → model transition, plus `init`.
 *
 * `init` parses the boot URL into the starting Route and seeds the Model
 * from dummy data so the first paint is instant; per-route fetch Commands
 * replace the seed. `ChangedUrl` re-parses on every navigation and resolves
 * the deck page when the route carries a deck id.
 *
 * A `Got*` answer clears the notice; a `LoadFailed` answer sets it and keeps
 * the seed on screen, so the Learner always sees data plus a retry. `DeckMissing`
 * clears the deck page to its not-found state, which is an answer, not a failure.
 *
 * Settings edits write into `settingsDraft` only; Save validates the draft
 * and, when clean, sends it through the save Command, whose answer copies
 * into `settings`.
 */

import { Option } from 'effect'
import { Navigation, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import type { Grade } from '@nook/api'
import { NavigateInternal, NavigateToPath } from './commands'
import {
  FetchDeckDetail,
  FetchDecks,
  FetchOverview,
  FetchReviewQueue,
  FetchSettings,
  SaveSettings,
  SubmitGrade,
} from './api-commands'
import { ClearImportJob, PrepareImport, RestoreImportJob } from './import-commands'
import type { LoadRetry } from './model'
import {
  Message,
  detailFor,
  draftFromSettings,
  idleImport,
  idleReview,
  seedModel,
  validateDraft,
} from './model'
import type { Model } from './model'
import { AppRoute, routeToUrl, urlToAppRoute } from './routes'

/** Fetch the data the route's screen renders. The seeded Model paints instantly; answers replace it. */
const commandsForRoute = (route: AppRoute) =>
  AppRoute.match(route, {
    Home: () => [FetchOverview(), FetchDecks()],
    Decks: () => [FetchDecks()],
    DeckDetail: ({ deckId }) => [FetchDeckDetail({ deckId })],
    Review: () => [FetchReviewQueue({ deckId: Option.none() }), FetchSettings()],
    ReviewDeck: ({ deckId }) => [
      FetchReviewQueue({ deckId: Option.some(deckId) }),
      FetchSettings(),
    ],
    Settings: () => [FetchSettings()],
    NotFound: () => [],
  })

export const init = (url: Url): Update.Return<Model, Message> => {
  const model = seedModel(url)
  return {
    model: {
      ...model,
      deckDetail: AppRouteMatchDetail(model),
    },
    // An Import interrupted by a reload is still in IndexedDB; restore it so the
    // worker can pick it up again.
    commands: [...commandsForRoute(model.route), RestoreImportJob()],
  }
}

const AppRouteMatchDetail = (model: Model): Model['deckDetail'] => {
  const route = model.route
  if (route._tag === 'DeckDetail') return detailFor(model.decks, route.deckId)
  return Option.none()
}

/** The fetch or save the notice retry runs, rebuilt from the current route and draft. */
const retryCommandsFor = (model: Model, retry: LoadRetry) => {
  switch (retry) {
    case 'overview':
      return [FetchOverview()]
    case 'decks':
      return [FetchDecks()]
    case 'deckDetail': {
      const route = model.route
      if (route._tag !== 'DeckDetail') return [FetchDecks()]
      return [FetchDeckDetail({ deckId: route.deckId })]
    }
    case 'reviewQueue': {
      const route = model.route
      if (route._tag === 'ReviewDeck') {
        return [FetchReviewQueue({ deckId: Option.some(route.deckId) })]
      }
      return [FetchReviewQueue({ deckId: Option.none() })]
    }
    case 'settings':
      return [FetchSettings()]
    case 'saveSettings':
      return [SaveSettings({ settings: settingsFromDraft(model) })]
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
      reviewSounds: model.settingsDraft.reviewSounds,
      tapToReveal: model.settingsDraft.tapToReveal,
      dayRolloverHour: model.settingsDraft.dayRolloverHour,
      keepAwake: model.settingsDraft.keepAwake,
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
 * not applied twice (ADR 0002).
 */
const gradeCurrent = (model: Model, grade: Grade): Update.Return<Model, Message> => {
  const review = model.review
  const card = review.cards[review.index]
  if (card === undefined || !review.revealed) return { model }
  const entry = { id: crypto.randomUUID(), cardId: card.cardId, grade }
  const index = review.index + 1
  const done = index >= review.cards.length
  return {
    model: clearNotice(
      modifyFields(model, {
        review: () => ({
          ...review,
          index,
          revealed: false,
          pending: [...review.pending, entry],
          graded: review.graded + 1,
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
      // A new screen means a new fetch; the old notice and the old review
      // session belong to the old screen.
      const next: Model = { ...clearNotice(model), route, review: idleReview }
      return {
        model: { ...next, deckDetail: AppRouteMatchDetail(next) },
        commands: commandsForRoute(route),
      }
    },

    CompletedNavigate: () => ({ model }),

    GotOverview: ({ overview }) => ({
      model: clearNotice(modifyFields(model, { overview: () => overview })),
    }),

    GotDecks: ({ decks }) => {
      const next: Model = clearNotice(modifyFields(model, { decks: () => [...decks] }))
      return { model: { ...next, deckDetail: AppRouteMatchDetail(next) } }
    },

    GotDeckDetail: ({ detail }) => ({
      model: clearNotice(modifyFields(model, { deckDetail: () => Option.some(detail) })),
    }),

    DeckMissing: () => ({
      model: clearNotice(modifyFields(model, { deckDetail: () => Option.none() })),
    }),

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

    GotReviewQueue: ({ cards }) => ({
      model: clearNotice(
        modifyFields(model, {
          review: () => ({
            ...idleReview,
            phase: cards.length === 0 ? 'done' : 'reviewing',
            cards: [...cards],
          }),
        }),
      ),
    }),

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
        }),
      }),
    }),

    GradeFailed: ({ error }) => ({
      model: modifyFields(model, {
        review: () => ({ ...model.review, error: Option.some(error) }),
      }),
    }),

    ClickedRetryGrades: () => ({
      model: modifyFields(model, {
        review: () => ({ ...model.review, error: Option.none() }),
      }),
      commands: model.review.pending.map((entry) => SubmitGrade(entry)),
    }),

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

    CompletedImport: ({ progress }) => ({
      model: {
        ...model,
        importState: {
          id: Option.none(),
          filename: model.importState.filename,
          active: false,
          phase: 'done',
          status: Option.some(progress),
          error: Option.none(),
        },
      },
      // The Decks page paints what the Import just wrote, and the archive is no
      // longer needed.
      commands: [FetchDecks(), ClearImportJob()],
    }),

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

    ToggledReviewSounds: ({ isChecked }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, reviewSounds: isChecked, saved: false },
      },
    }),

    ToggledTapToReveal: ({ isChecked }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, tapToReveal: isChecked, saved: false },
      },
    }),

    ToggledKeepAwake: ({ isChecked }) => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, keepAwake: isChecked, saved: false },
      },
    }),

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
