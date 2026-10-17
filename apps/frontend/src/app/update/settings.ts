/**
 * Settings: the draft-to-settings mapping, plus the Settings screen's Messages.
 */

import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'
import { DownloadFile, FetchExport, FetchFsrsDiagnostics, SaveSettings } from '../api-commands'
import { ApplyTheme } from '../theme-commands'
import { draftFromSettings, validateDraft } from '../model'
import type { Model } from '../model'
import { clearNotice } from './notice'
import { defineHandlers } from './handlers'

export const beginSettingsSave = (model: Model): Model => {
  const settings = settingsFromDraft(model)
  return {
    ...model,
    settings,
    settingsRollback: Option.some(model.settings),
    settingsDraft: {
      ...model.settingsDraft,
      validationError: Option.none(),
      saved: false,
      saving: true,
    },
    notice: Option.none(),
  }
}

export const toNumber = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isFinite(parsed) ? fallback : parsed
}

export const toInt = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return value.trim() === '' || !Number.isInteger(parsed) ? fallback : parsed
}

export const settingsFromDraft = (model: Model) => {
  return {
    fsrs: {
      desiredRetention: model.settingsDraft.desiredRetention,
      weights: model.settings.fsrs.weights,
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

export const settingsHandlers = defineHandlers((model) => ({
  GotSettings: ({ settings }) => ({
    model: Option.isSome(model.settingsRollback)
      ? model
      : clearNotice({
          ...modifyFields(model, { settings: () => settings }),
          settingsDraft: draftFromSettings(settings),
        }),
  }),

  ClickedRetryFsrsDiagnostics: () => ({
    model: { ...model, fsrsDiagnosticsLoading: true, fsrsDiagnosticsError: Option.none() },
    commands: [FetchFsrsDiagnostics()],
  }),

  GotFsrsDiagnostics: ({ diagnostics }) => ({
    model: {
      ...model,
      fsrsDiagnostics: Option.some(diagnostics),
      fsrsDiagnosticsLoading: false,
      fsrsDiagnosticsError: Option.none(),
    },
  }),

  FsrsDiagnosticsFailed: ({ error }) => ({
    model: {
      ...model,
      fsrsDiagnosticsLoading: false,
      fsrsDiagnosticsError: Option.some(error),
    },
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
            validationError: Option.some(error),
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
}))
