/**
 * Update: message → model transition, plus `init`.
 *
 * `init` parses the boot URL into the starting Route and seeds the Model
 * from dummy data so the first paint is instant; per-route fetch Commands
 * replace the seed. `ChangedUrl` re-parses on every navigation and resolves
 * the deck page when the route carries a deck id.
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

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? fallback : parsed
}

const toInt = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isInteger(parsed) ? fallback : parsed
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
      const next: Model = { ...model, route }
      return {
        model: { ...next, deckDetail: AppRouteMatchDetail(next) },
        commands: commandsForRoute(route),
      }
    },

    CompletedNavigate: () => ({ model }),

    GotOverview: ({ overview }) => ({
      model: modifyFields(model, { overview: () => overview }),
    }),

    GotDecks: ({ decks }) => {
      const next: Model = modifyFields(model, { decks: () => [...decks] })
      return { model: { ...next, deckDetail: AppRouteMatchDetail(next) } }
    },

    GotDeckDetail: ({ detail }) => ({
      model: modifyFields(model, { deckDetail: () => Option.some(detail) }),
    }),

    GotSettings: ({ settings }) => ({
      model: {
        ...modifyFields(model, { settings: () => settings }),
        settingsDraft: draftFromSettings(settings),
      },
    }),

    SavedSettings: ({ settings }) => ({
      model: {
        ...modifyFields(model, { settings: () => settings }),
        settingsDraft: { ...draftFromSettings(settings), saved: true },
      },
    }),

    LoadFailed: () => ({ model }),

    TypedDecksQuery: ({ value }) => ({
      model: modifyFields(model, { decksQuery: () => value }),
    }),

    StartedDeckReview: () => ({ model }),

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
      const weights = model.settingsDraft.weightsText.split(',').map((part) => Number(part.trim()))
      const settings = {
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
      return {
        model: {
          ...model,
          settingsDraft: { ...model.settingsDraft, weightsError: Option.none(), saved: false },
        },
        commands: [SaveSettings({ settings })],
      }
    },

    ClickedResetSettings: () => ({
      model: { ...model, settingsDraft: draftFromSettings(model.settings) },
    }),
  })
