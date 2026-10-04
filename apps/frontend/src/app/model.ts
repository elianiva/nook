/**
 * The app shell's Model and Message (the TEA core).
 *
 * The Model holds the current Route plus one screen-state slice per screen.
 * Each slice is plain data shaped exactly like the backend response it
 * carries — seeded from `@nook/api` dummy data at boot so the first paint
 * is instant, then replaced by answers from the fetch Commands. Views read
 * the Model only; `update` is the only place that writes it.
 *
 * Data-volume contract (mirrors `@nook/api`):
 * - home/decks hold `DeckSummary` rows only — counts plus the next Review,
 *   never Card bodies
 * - the deck page holds one `DeckDetail`: its summary plus scheduling-state
 *   rows for its own Cards
 * - settings holds `AppSettings`, edited locally until Save
 */

import { Option, Schema as S } from 'effect'
import { File } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { Navigation } from 'foldkit'
import { Url } from 'foldkit'
import {
  AppSettings,
  DeckDetail,
  DeckSummary,
  DUMMY_DECKS,
  DUMMY_OVERVIEW,
  DUMMY_SETTINGS,
  ImportId,
  ImportStatus,
  Overview,
  dummyCardsFor,
} from '@nook/api'
import { AppRoute, urlToAppRoute } from './routes'

/** Editable copy of the settings form. The text field for FSRS weights stays a string so half-typed input never corrupts the numeric model. */
export const SettingsDraft = S.Struct({
  desiredRetention: S.Number,
  weightsText: S.String,
  weightsError: S.Option(S.String),
  maximumInterval: S.Number,
  newPerDay: S.Number,
  reviewsPerDay: S.Number,
  lapseMinutes: S.Number,
  reviewSounds: S.Boolean,
  tapToReveal: S.Boolean,
  dayRolloverHour: S.Number,
  keepAwake: S.Boolean,
  saved: S.Boolean,
})
export type SettingsDraft = typeof SettingsDraft.Type

export const draftFromSettings = (settings: AppSettings): SettingsDraft => ({
  desiredRetention: settings.fsrs.desiredRetention,
  weightsText: settings.fsrs.weights.map((weight) => String(weight)).join(', '),
  weightsError: Option.none(),
  maximumInterval: settings.fsrs.maximumInterval,
  newPerDay: settings.fsrs.newPerDay,
  reviewsPerDay: settings.fsrs.reviewsPerDay,
  lapseMinutes: settings.fsrs.lapseMinutes,
  reviewSounds: settings.behaviour.reviewSounds,
  tapToReveal: settings.behaviour.tapToReveal,
  dayRolloverHour: settings.behaviour.dayRolloverHour,
  keepAwake: settings.behaviour.keepAwake,
  saved: false,
})

const parseWeights = (text: string): ReadonlyArray<number> | undefined => {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return undefined
  const values = parts.map((part) => Number(part))
  return values.every((value) => Number.isFinite(value)) ? values : undefined
}

/** Validate the draft. Returns the error message, or `undefined` when the draft is clean. */
export const validateDraft = (draft: SettingsDraft): string | undefined => {
  if (!(draft.desiredRetention >= 0.7 && draft.desiredRetention <= 0.95)) {
    return 'Desired retention must be between 0.70 and 0.95.'
  }
  const weights = parseWeights(draft.weightsText)
  if (weights === undefined) return 'Weights must be a comma-separated list of numbers.'
  if (weights.length !== 17) return `Weights need 17 values (FSRS-6), found ${weights.length}.`
  if (!Number.isInteger(draft.maximumInterval) || draft.maximumInterval < 1) {
    return 'Maximum interval must be a whole number of days, at least 1.'
  }
  if (!Number.isInteger(draft.newPerDay) || draft.newPerDay < 0) {
    return 'New Cards per day must be 0 or more.'
  }
  if (!Number.isInteger(draft.reviewsPerDay) || draft.reviewsPerDay < 0) {
    return 'Reviews per day must be 0 or more.'
  }
  if (!Number.isInteger(draft.lapseMinutes) || draft.lapseMinutes < 1) {
    return 'Lapse minutes must be at least 1.'
  }
  if (
    !Number.isInteger(draft.dayRolloverHour) ||
    draft.dayRolloverHour < 0 ||
    draft.dayRolloverHour > 23
  ) {
    return 'Day rollover hour must be 0–23.'
  }
  return undefined
}

/** Which fetch or save a notice retry runs. */
export const LoadRetry = S.Literals(['overview', 'decks', 'deckDetail', 'settings', 'saveSettings'])
export type LoadRetry = typeof LoadRetry.Type

/** A failed fetch or save, as the banner shows it: what failed, and what retry runs. */
export const LoadNotice = S.Struct({
  /** One sentence for the Learner. Never a stack trace or a status code. */
  message: S.String,
  /** Which fetch or save to run again when the Learner presses retry. */
  retry: LoadRetry,
})
export type LoadNotice = typeof LoadNotice.Type

/** What the Decks page knows about the Import it last started or watched. */
export const ImportState = S.Struct({
  /**
   * The archive's content hash, which is also the Import's id in D1. `Some`
   * while a run is in flight, which is what the progress subscription keys on;
   * `None` once it finishes or fails.
   */
  id: S.Option(ImportId),
  filename: S.String,
  /** Where the run is: reading the file, writing batches, finished, or failed. */
  phase: S.Literals(['idle', 'reading', 'writing', 'done', 'failed']),
  /** The last status the Worker reported, for the progress bar. */
  status: S.Option(ImportStatus),
  /** Why the last run failed, as one sentence for the Learner. */
  error: S.Option(S.String),
})
export type ImportState = typeof ImportState.Type

export const idleImport: ImportState = {
  id: Option.none(),
  filename: '',
  phase: 'idle',
  status: Option.none(),
  error: Option.none(),
}

export const Model = S.Struct({
  route: AppRoute,
  overview: Overview,
  decks: S.Array(DeckSummary),
  /** The open deck page, when the route carries a deck id. `None` when the id is unknown. */
  deckDetail: S.Option(DeckDetail),
  /** Search text on the decks page. */
  decksQuery: S.String,
  settings: AppSettings,
  settingsDraft: SettingsDraft,
  /** The Import the Decks page is showing: what is running, or what last ran. */
  importState: ImportState,
  /** The last fetch or save that failed, with a retry for its route. `None` when everything answers. */
  notice: S.Option(LoadNotice),
})
export type Model = typeof Model.Type

export const seedModel = (url: Url.Url): Model => ({
  route: urlToAppRoute(url),
  overview: DUMMY_OVERVIEW,
  decks: [...DUMMY_DECKS],
  deckDetail: Option.none(),
  decksQuery: '',
  settings: DUMMY_SETTINGS,
  settingsDraft: draftFromSettings(DUMMY_SETTINGS),
  importState: idleImport,
  notice: Option.none(),
})

/** Resolve the deck detail for a deck id from the dummy source. `None` for unknown ids. */
export const detailFor = (
  decks: ReadonlyArray<DeckSummary>,
  deckId: string,
): Option.Option<DeckDetail> => {
  const summary = decks.find((deck) => deck.id === deckId)
  if (summary === undefined) return Option.none()
  return Option.some({ summary, cards: [...dummyCardsFor(summary.id)] })
}

export const Message = defineMessageUnion({
  /** A link or back/forward navigation was requested. */
  ClickedLink: { request: Navigation.UrlRequest },
  /** The URL changed (link, back/forward, or cold load). */
  ChangedUrl: { url: Url.Url },
  CompletedNavigate: {},
  /** The backend answered a fetch, or every fetch gave up. */
  GotOverview: { overview: Overview },
  GotDecks: { decks: S.Array(DeckSummary) },
  GotDeckDetail: { detail: DeckDetail },
  GotSettings: { settings: AppSettings },
  SavedSettings: { settings: AppSettings },
  /** The deck id names no deck. The deck page renders its not-found state. */
  DeckMissing: {},
  /** A fetch or save failed. The notice carries the retry; the seed stays on screen. */
  LoadFailed: { error: S.String, retry: LoadRetry },
  /** The Learner pressed retry on the notice banner. */
  ClickedRetry: {},
  /** Decks page search text. */
  TypedDecksQuery: { value: S.String },
  StartedDeckReview: { deckId: S.String },
  /** The Learner pressed the Import button. */
  ClickedImport: {},
  /** The Learner picked an archive, and it hashes to this Import id. */
  GotImportFile: { file: File.File, id: ImportId },
  /** The Learner dismissed the file picker. */
  CancelledImportSelect: {},
  /** The Worker answered with how far the running Import has come. */
  PolledImport: { status: ImportStatus },
  /** The Import wrote every Note and Card it found. */
  CompletedImport: { status: ImportStatus },
  /** The Import stopped before it finished. The cursors are still in D1, so the next run resumes. */
  FailedImport: { error: S.String },
  // Settings draft edits. Each carries the raw field value; validation runs on save.
  EditedRetention: { value: S.String },
  EditedWeights: { value: S.String },
  EditedMaximumInterval: { value: S.String },
  EditedNewPerDay: { value: S.String },
  EditedReviewsPerDay: { value: S.String },
  EditedLapseMinutes: { value: S.String },
  EditedRolloverHour: { value: S.String },
  ToggledReviewSounds: { isChecked: S.Boolean },
  ToggledTapToReveal: { isChecked: S.Boolean },
  ToggledKeepAwake: { isChecked: S.Boolean },
  ClickedSaveSettings: {},
  ClickedResetSettings: {},
})
export type Message = typeof Message.Type
