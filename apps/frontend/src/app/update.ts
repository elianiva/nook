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
import { NavigateInternal } from './commands'
import {
  FetchDeckDetail,
  FetchDecks,
  FetchOverview,
  FetchSettings,
  SaveSettings,
} from './api-commands'
import { PrepareImport, RunImport } from './import-commands'
import type { LoadRetry } from './model'
import { Message, detailFor, draftFromSettings, seedModel, validateDraft } from './model'
import type { Model } from './model'
import { AppRoute, urlToAppRoute } from './routes'

/** Fetch the data the route's screen renders. The seeded Model paints instantly; answers replace it. */
const commandsForRoute = (route: AppRoute) =>
  AppRoute.match(route, {
    Home: () => [FetchOverview(), FetchDecks()],
    Decks: () => [FetchDecks()],
    DeckDetail: ({ deckId }) => [FetchDeckDetail({ deckId })],
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
    commands: commandsForRoute(model.route),
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

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedLink: ({ request }) =>
      Navigation.UrlRequest.match(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url })] }),
        External: () => ({ model }),
      }),

    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url)
      // A new screen means a new fetch; the old notice belongs to the old screen.
      const next: Model = { ...clearNotice(model), route }
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

    StartedDeckReview: () => ({ model }),

    ClickedImport: () => ({ model, commands: [PrepareImport()] }),

    CancelledImportSelect: () => ({ model }),

    GotImportFile: ({ file, id }) => ({
      model: {
        ...model,
        importState: {
          id: Option.some(id),
          filename: file.name,
          phase: 'reading',
          status: Option.none(),
          error: Option.none(),
        },
      },
      commands: [RunImport({ file, id })],
    }),

    // A tick can already be in flight when the run finishes, so a finished or
    // failed Import ignores it rather than flipping back to "importing".
    PolledImport: ({ status }) =>
      model.importState.phase === 'done' || model.importState.phase === 'failed'
        ? { model }
        : {
            model: {
              ...model,
              importState: { ...model.importState, phase: 'writing', status: Option.some(status) },
            },
          },

    CompletedImport: ({ status }) => ({
      model: {
        ...model,
        importState: {
          id: Option.none(),
          filename: model.importState.filename,
          phase: 'done',
          status: Option.some(status),
          error: Option.none(),
        },
      },
      // The Decks page paints what the Import just wrote.
      commands: [FetchDecks()],
    }),

    FailedImport: ({ error }) => ({
      model: {
        ...model,
        importState: {
          ...model.importState,
          id: Option.none(),
          phase: 'failed',
          error: Option.some(error),
        },
      },
    }),

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
