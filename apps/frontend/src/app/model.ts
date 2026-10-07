/**
 * The app shell's Model and Message (the TEA core).
 *
 * The Model holds the current Route plus one screen-state slice per screen.
 * The list and detail slices are Query Models, so each carries its own
 * `AsyncData` state; settings is plain data edited locally until Save. Views
 * read the Model only; `update` is the only place that writes it.
 *
 * Data-volume contract (mirrors `@nook/api`):
 * - home/decks hold `DeckSummary` rows only — counts plus the next Review,
 *   never Card bodies
 * - the deck page holds one `DeckDetail`: its summary plus per-Card rows
 *   with prompt previews, retained per deck id
 * - settings holds `AppSettings`, edited locally until Save
 */

import { Option, Schema as S } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { Navigation } from 'foldkit'
import { Url } from 'foldkit'
import {
  AppSettings,
  FsrsHealthReport,
  CardReviewEvent,
  CardReviewHistory,
  CardId,
  DEFAULT_SETTINGS,
  DeckDetail,
  DeckId,
  DeckSummary,
  Grade,
  ImportId,
  Overview,
  ReviewAccepted,
  ReviewCard,
} from '@nook/api'
import { ImportPreview, ImportProgress, ImportReadStage } from '@/lib/import-worker-protocol'
import { readTheme } from '@/lib/theme'
import { deckDetailQuery, decksQuery, overviewQuery } from './queries'
import { AppRoute, urlToAppRoute } from './routes'
import * as Tooltip from '@/components/ui/tooltip'

/** Hint slot ids for the settings page tooltips. */
export const hintSlots = [
  'desired-retention',
  'maximum-interval',
  'new-per-day',
  'reviews-per-day',
  'lapse-minutes',
  'tap-to-reveal',
  'day-rollover',
  'section-fsrs',
  'section-defaults',
  'section-behaviour',
  'section-appearance',
  'section-collection',
] as const
export type HintSlot = (typeof hintSlots)[number]

/** One Foldkit Tooltip Model per hint slot, keyed by slot id. */
export const Hints = S.Record(S.String, Tooltip.Model)
export type Hints = typeof Hints.Type

/** Every hint starts hidden. */
export const initHints = (): Hints =>
  Object.fromEntries(hintSlots.map((slot) => [slot, Tooltip.init({ id: `hint-${slot}` })])) as Hints

/** Editable copy of the settings form. FSRS parameters stay server-owned until a safe optimizer exists. */
export const SettingsDraft = S.Struct({
  desiredRetention: S.Number,
  validationError: S.Option(S.String),
  maximumInterval: S.Number,
  newPerDay: S.Number,
  reviewsPerDay: S.Number,
  lapseMinutes: S.Number,
  tapToReveal: S.Boolean,
  dayRolloverHour: S.Number,
  saved: S.Boolean,
  saving: S.Boolean,
})
export type SettingsDraft = typeof SettingsDraft.Type

export const draftFromSettings = (settings: AppSettings): SettingsDraft => ({
  desiredRetention: settings.fsrs.desiredRetention,
  validationError: Option.none(),
  maximumInterval: settings.fsrs.maximumInterval,
  newPerDay: settings.fsrs.newPerDay,
  reviewsPerDay: settings.fsrs.reviewsPerDay,
  lapseMinutes: settings.fsrs.lapseMinutes,
  tapToReveal: settings.behaviour.tapToReveal,
  dayRolloverHour: settings.behaviour.dayRolloverHour,
  saved: false,
  saving: false,
})

/** Validate the draft. Returns the error message, or `undefined` when the draft is clean. */
export const validateDraft = (draft: SettingsDraft): string | undefined => {
  if (!(draft.desiredRetention >= 0.7 && draft.desiredRetention <= 0.95)) {
    return 'Desired retention must be between 0.70 and 0.95.'
  }
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

/** Where the review screen is: fetching a queue, showing a Card, or at an end. */
export const ReviewPhase = S.Literals(['loading', 'reviewing', 'done', 'failed'])
export type ReviewPhase = typeof ReviewPhase.Type

/** Why the review session ended with no Cards to show. */
export const ReviewDoneKind = S.Literals(['empty', 'limits'])
export type ReviewDoneKind = typeof ReviewDoneKind.Type

/** A Grade the app has applied on screen but the server has not confirmed yet. */
export const ReviewPending = S.Struct({
  id: S.String,
  cardId: CardId,
  grade: Grade,
})
export type ReviewPending = typeof ReviewPending.Type

/**
 * The review screen's state.
 *
 * `cards` is the queue the server served, already rendered. `index` walks it,
 * and `graded` counts what this session has landed. A Grade advances `index`
 * immediately and rides in `pending` until the server confirms it, so grading
 * never waits for the network; a failed Grade stays in `pending` for Retry.
 * An `Again` grade re-queues its Card later this session (`requeue`), unless
 * the learner has seen it enough times (`maxRequeue`).
 */
export const ReviewState = S.Struct({
  phase: ReviewPhase,
  cards: S.Array(ReviewCard),
  index: S.Number,
  revealed: S.Boolean,
  pending: S.Array(ReviewPending),
  graded: S.Number,
  /** Cards graded `Again` that return later this session, with their lapse counts. */
  requeue: S.Array(ReviewCard),
  /** ISO 8601 UTC instant the learner-day boundary sits at, for the countdown. */
  dayStartUtc: S.Option(S.String),
  /** Minutes after which a lapsed Card returns. Mirrors the saved settings. */
  lapseMinutes: S.Number,
  /** The last landed grade, for Undo. Cleared by the next grade. */
  lastGrade: S.Option(ReviewPending),
  /** Whether the last grade was just undone, for the confirmation. */
  undone: S.Boolean,
  /** Cards queued to grade while offline, flushed when the network returns. */
  offline: S.Array(ReviewPending),
  /** Card whose suspend action is awaiting server confirmation. */
  suspensionPending: S.Option(CardId),
  /** The last suspend failure, shown without advancing the current Card. */
  suspensionError: S.Option(S.String),
  /** Most recent automatically suspended leech, with its review count. */
  leechSuspendedCard: S.Option(ReviewCard),
  leechSuspendedReviewLapses: S.Number,
  /** Why the last grade failed, as one sentence for the Learner. */
  error: S.Option(S.String),
  /** Why the session ended with no Cards: truly empty, or stopped by a limit. */
  doneKind: ReviewDoneKind,
  /** This session explicitly bypassed the daily due limit. Never persisted. */
  bypassDueLimit: S.Boolean,
  /** What the queue knew when it landed: the counts behind the done screen. */
  queueTotalDue: S.Number,
  queueTotalNew: S.Number,
  queueReviewedToday: S.Number,
  queueNewToday: S.Number,
  queueNewCapped: S.Boolean,
  queueDueCapped: S.Boolean,
  /** Due and new Cards the landed queue served, for the "N more" remainder. */
  queueServedDue: S.Number,
  queueServedNew: S.Number,
})
export type ReviewState = typeof ReviewState.Type

export const idleReview: ReviewState = {
  phase: 'loading',
  cards: [],
  index: 0,
  revealed: false,
  pending: [],
  graded: 0,
  requeue: [],
  dayStartUtc: Option.none(),
  lapseMinutes: 10,
  lastGrade: Option.none(),
  undone: false,
  offline: [],
  suspensionPending: Option.none(),
  suspensionError: Option.none(),
  leechSuspendedCard: Option.none(),
  leechSuspendedReviewLapses: 0,
  error: Option.none(),
  doneKind: 'empty',
  bypassDueLimit: false,
  queueTotalDue: 0,
  queueTotalNew: 0,
  queueReviewedToday: 0,
  queueNewToday: 0,
  queueNewCapped: false,
  queueDueCapped: false,
  queueServedDue: 0,
  queueServedNew: 0,
}

/** Which fetch or save a notice retry runs. The list and detail reads are Queries now, so they carry their own Retry. */
export const LoadRetry = S.Literals([
  'reviewQueue',
  'settings',
  'saveSettings',
  'queuedGrades',
  'undoReview',
  'collectionExport',
])
export type LoadRetry = typeof LoadRetry.Type

/** A failed fetch or save, as the banner shows it: what failed, and what retry runs. */
export const LoadNotice = S.Struct({
  /** One sentence for the Learner. Never a stack trace or a status code. */
  message: S.String,
  /** Which fetch or save to run again when the Learner presses retry. */
  retry: LoadRetry,
})
export type LoadNotice = typeof LoadNotice.Type

/** Which destructive deck action the Manage section is confirming, if any. Only one confirm is open at a time. */
export const DeckConfirm = S.Literals(['reset', 'remove'])
export type DeckConfirm = typeof DeckConfirm.Type

/** Server values to restore if an optimistic rename or limit change fails. */
export const DeckCacheSnapshot = S.Struct({
  deckId: DeckId,
  summaries: S.Option(S.Array(DeckSummary)),
  detail: S.Option(DeckDetail),
})
export type DeckCacheSnapshot = typeof DeckCacheSnapshot.Type

/**
 * The deck page's Manage section: the rename draft plus which destructive
 * confirm is open.
 *
 * `deckId` names the Deck this state belongs to; opening the section for
 * another Deck reseeds the draft from its summary, so a stale name never
 * leaks across pages. `saving` marks a mutation in flight, `saved` the
 * confirmation after a rename lands, and `error` the last mutation failure
 * as one sentence for the Learner.
 *
 * The limits draft holds the three override fields as text: blank means
 * "follow Settings" (`null` on the wire), so half-typed input never
 * corrupts the numeric model. `limitsSaved` confirms a limits save the way
 * `saved` confirms a rename. `cardsOpen` folds the long Card list away —
 * the Manage section sits below it, so a Deck with hundreds of Cards would
 * otherwise bury its own settings.
 */
export const DeckManage = S.Struct({
  deckId: S.Option(DeckId),
  name: S.String,
  description: S.String,
  editing: S.Boolean,
  confirming: S.Option(DeckConfirm),
  saving: S.Boolean,
  saved: S.Boolean,
  error: S.Option(S.String),
  editingLimits: S.Boolean,
  newPerDay: S.String,
  reviewsPerDay: S.String,
  lapseMinutes: S.String,
  limitsSaving: S.Boolean,
  limitsSaved: S.Boolean,
  limitsError: S.Option(S.String),
  cardsOpen: S.Boolean,
})
export type DeckManage = typeof DeckManage.Type

export const idleDeckManage: DeckManage = {
  deckId: Option.none(),
  name: '',
  description: '',
  editing: false,
  confirming: Option.none(),
  saving: false,
  saved: false,
  error: Option.none(),
  editingLimits: false,
  newPerDay: '',
  reviewsPerDay: '',
  lapseMinutes: '',
  limitsSaving: false,
  limitsSaved: false,
  limitsError: Option.none(),
  cardsOpen: false,
}

/** The limits draft for a Deck, seeded from its summary: overrides as text, blank for "follow Settings". */
export const limitsTextFromSummary = (summary: {
  limits: { newPerDay: number | null; reviewsPerDay: number | null; lapseMinutes: number | null }
}): { newPerDay: string; reviewsPerDay: string; lapseMinutes: string } => ({
  newPerDay: summary.limits.newPerDay === null ? '' : String(summary.limits.newPerDay),
  reviewsPerDay: summary.limits.reviewsPerDay === null ? '' : String(summary.limits.reviewsPerDay),
  lapseMinutes: summary.limits.lapseMinutes === null ? '' : String(summary.limits.lapseMinutes),
})

/**
 * An Import the client can resume: its id and the archive's name.
 *
 * The archive's bytes stay in IndexedDB, out of the Model, because a Blob does
 * not belong in the state a view reads.
 */
export const ImportJobMeta = S.Struct({
  id: ImportId,
  filename: S.String,
})
export type ImportJobMeta = typeof ImportJobMeta.Type

/**
 * One restored query answer, decoded and ready to seed its Query. `update`
 * folds each answer into the matching Query Model as `Success`, so a cold
 * boot offline shows the last cached data before the route loads run.
 */
export const RestoredAnswer = S.Union([
  S.Struct({ kind: S.Literal('overview'), value: Overview }),
  S.Struct({ kind: S.Literal('decks'), value: S.Array(DeckSummary) }),
  S.Struct({ kind: S.Literal('deckDetail'), deckId: DeckId, value: DeckDetail }),
])
export type RestoredAnswer = typeof RestoredAnswer.Type

/** Where an Import is, for the panel to name. `preview` means the archive is picked but nothing runs yet. `running` means the worker should be up. */
export const ImportPhase = S.Literals([
  'idle',
  'preview',
  'running',
  'reading',
  'writing',
  'done',
  'failed',
])
export type ImportPhase = typeof ImportPhase.Type

/** What the Decks page knows about the Import it last started or watched. */
export const ImportState = S.Struct({
  /**
   * The archive's content hash, which is also the Import's id in D1. `Some`
   * while a run can resume, including after it fails; `None` once it is done
   * or dismissed.
   */
  id: S.Option(ImportId),
  filename: S.String,
  /**
   * Whether the Import worker should be running. This is what the subscription
   * keys on, so the worker is not torn down when only the phase moves.
   */
  active: S.Boolean,
  /** Where the run is: picked, reading, writing rows, or an end. */
  phase: ImportPhase,
  /**
   * Where the read of the archive has reached, while the phase is `reading`
   * or `preview`. The worker reports each open step as it happens, so the
   * panel names what the run is doing. `None` before the first step arrives
   * and after reading.
   */
  readStage: S.Option(ImportReadStage),
  /** What the archive holds, read before anything is written. `None` until the preview arrives. */
  preview: S.Option(ImportPreview),
  /** Whether the run writes the archive's Media. The Learner toggles this on the detail panel. */
  includeMedia: S.Boolean,
  /** The last counts the worker reported, for the progress bar. */
  status: S.Option(ImportProgress),
  /** Why the last run failed, as one sentence for the Learner. */
  error: S.Option(S.String),
})
export type ImportState = typeof ImportState.Type

export const idleImport: ImportState = {
  id: Option.none(),
  filename: '',
  active: false,
  phase: 'idle',
  readStage: Option.none(),
  preview: Option.none(),
  includeMedia: true,
  status: Option.none(),
  error: Option.none(),
}

export const Model = S.Struct({
  route: AppRoute,
  /** The overview Query: due counts, streak, and the activity strip. */
  overview: overviewQuery.Model,
  /** The decks Query. Home and Decks share it, so one answer fills both. */
  decks: decksQuery.Model,
  /** The deck detail KeyedQuery, retained per deck id. */
  deckDetail: deckDetailQuery.Model,
  /** The review screen's queue and cursor. */
  review: ReviewState,
  settings: AppSettings,
  settingsDraft: SettingsDraft,
  fsrsDiagnostics: S.Option(FsrsHealthReport),
  fsrsDiagnosticsLoading: S.Boolean,
  fsrsDiagnosticsError: S.Option(S.String),
  /** The Import the Decks page is showing: what is running, or what last ran. */
  importState: ImportState,
  /** The deck page's Manage section: rename draft and destructive confirms. */
  deckManage: DeckManage,
  /** Server cache values held while an optimistic deck mutation is in flight. */
  deckMutationRollback: S.Option(DeckCacheSnapshot),
  /** Grades in IndexedDB's durable outbox until the server confirms them. */
  queuedGrades: S.Array(ReviewPending),
  /** Server-authoritative settings to restore if an optimistic save fails. */
  settingsRollback: S.Option(AppSettings),
  /** Card-level suspension mutation shown in the expanded deck list. */
  cardSuspensionPending: S.Option(CardId),
  cardSuspensionError: S.Option(S.Struct({ cardId: CardId, message: S.String })),
  /** Per-card grade history currently opened from the deck's card list. */
  cardHistoryCard: S.Option(CardId),
  cardHistoryLoading: S.Boolean,
  cardHistory: S.Array(CardReviewEvent),
  cardHistoryTotal: S.Number,
  cardHistoryError: S.Option(S.String),
  /** The picked Mochi theme, mirrored from storage so the swatch ring moves on
   *  pick. Local-only; the DOM attribute and `localStorage` stay authoritative
   *  for paint, and a reload re-reads them. */
  theme: S.String,
  /** One hint tooltip Model per settings slot. Local-only; never saved. */
  hints: Hints,
  /** The last fetch or save that failed, with a retry for its route. `None` when everything answers. */
  notice: S.Option(LoadNotice),
  /** A newer shell waits in the worker. The banner offers the reload; never forced during review. */
  swUpdateReady: S.Boolean,
})
export type Model = typeof Model.Type

export const seedModel = (url: Url.Url): Model => ({
  route: urlToAppRoute(url),
  overview: overviewQuery.init(),
  decks: decksQuery.init(),
  deckDetail: deckDetailQuery.init(),
  review: idleReview,
  settings: DEFAULT_SETTINGS,
  settingsDraft: draftFromSettings(DEFAULT_SETTINGS),
  fsrsDiagnostics: Option.none(),
  fsrsDiagnosticsLoading: false,
  fsrsDiagnosticsError: Option.none(),
  importState: idleImport,
  deckManage: idleDeckManage,
  deckMutationRollback: Option.none(),
  queuedGrades: [],
  settingsRollback: Option.none(),
  cardSuspensionPending: Option.none(),
  cardSuspensionError: Option.none(),
  cardHistoryCard: Option.none(),
  cardHistoryLoading: false,
  cardHistory: [],
  cardHistoryTotal: 0,
  cardHistoryError: Option.none(),
  theme: readTheme(),
  hints: initHints(),
  notice: Option.none(),
  swUpdateReady: false,
})

export const Message = defineMessageUnion({
  /** A link or back/forward navigation was requested. */
  ClickedLink: { request: Navigation.UrlRequest },
  /** The URL changed (link, back/forward, or cold load). */
  ChangedUrl: { url: Url.Url },
  CompletedNavigate: {},
  /** A Query's fetch completed. The wrapper routes it back through its lifted fold. */
  GotOverviewMessage: { message: overviewQuery.Message },
  GotDecksMessage: { message: decksQuery.Message },
  GotDeckDetailMessage: { message: deckDetailQuery.Message },
  GotSettings: { settings: AppSettings },
  ClickedRetryFsrsDiagnostics: {},
  GotFsrsDiagnostics: { diagnostics: FsrsHealthReport },
  FsrsDiagnosticsFailed: { error: S.String },
  SavedSettings: { settings: AppSettings },
  /** The durable grade outbox was loaded at boot. */
  RestoredQueuedGrades: { grades: S.Array(ReviewPending) },
  /** A Query shows its own error, so its Retry is its own Message. */
  ClickedRetryOverview: {},
  ClickedRetryDecks: {},
  ClickedRetryDeckDetail: { deckId: DeckId },
  /** Hover or focus warmed a deck link: load its detail while it is still missing. */
  PrefetchedDeckDetail: { deckId: DeckId },
  /** A fetch or save failed. The notice carries the retry. */
  LoadFailed: { error: S.String, retry: LoadRetry },
  /** The Learner pressed retry on the notice banner. */
  ClickedRetry: {},
  /** The Learner pressed a Start action: one Deck's queue, or every Deck's. */
  StartedReview: { deckId: S.Option(DeckId) },
  /** The backend answered with the Cards to review, already rendered. */
  GotReviewQueue: {
    cards: S.Array(ReviewCard),
    dayStartUtc: S.String,
    lapseMinutes: S.Number,
    reviewedToday: S.Number,
    newToday: S.Number,
    totalNew: S.Number,
    totalDue: S.Number,
    newCapped: S.Boolean,
    dueCapped: S.Boolean,
    /** This response was requested by the session-only due-limit bypass. */
    beyondLimit: S.Boolean,
  },
  /** The Learner revealed the answer side. */
  RevealedAnswer: {},
  /** The Learner graded the shown Card. */
  ClickedGrade: { grade: Grade },
  /** The Learner suspended the current Card without grading it. */
  ClickedSuspendCurrentCard: {},
  /** The Learner restored a suspended Card from its deck page. */
  ClickedRestoreCard: { cardId: CardId },
  /** The Learner opened a Card's review history from its deck row. */
  ClickedCardHistory: { cardId: CardId },
  /** The Learner retried a Card history request that failed. */
  ClickedRetryCardHistory: { cardId: CardId },
  /** The backend answered with the Card's newest saved grade events. */
  GotCardHistory: { cardId: CardId, history: CardReviewHistory },
  /** The Card history could not be read. */
  CardHistoryFailed: { cardId: CardId, error: S.String },
  /** Suspension changed on the server; review history and schedule are intact. */
  CardSuspensionSaved: {
    cardId: CardId,
    suspended: S.Boolean,
    origin: S.Literals(['review', 'deck']),
  },
  /** Suspension did not change on the server. */
  CardSuspensionFailed: { error: S.String, origin: S.Literals(['review', 'deck']) },
  /** A grade key was pressed. Ignored unless the answer is showing. */
  PressedGrade: { grade: Grade },
  /** Space or Enter was pressed: reveal, then grade Good. */
  PressedSpace: {},
  /** The server accepted the grade and rescheduled the Card. */
  GradeAccepted: { id: S.String, accepted: ReviewAccepted },
  /** The Learner pressed Undo on the last grade. */
  ClickedUndoGrade: {},
  /** The server undid the last grade and restored the Card. */
  UndoneGrade: { cardId: CardId },
  /** Undo did not land. It waits for Retry. */
  UndoFailed: { error: S.String },
  /** The Learner pressed Retry on a failed undo. */
  ClickedRetryUndo: {},
  /** The browser regained its network. Offline grades flush. */
  RegainedNetwork: {},
  /** The network returned or the tab became visible: refresh the shown queries. */
  RevalidateVisible: {},
  /** The Learner asked for the collection file. */
  ClickedExport: {},
  /** The collection arrived, ready to download. */
  GotExport: { filename: S.String, json: S.String },
  /** The collection file downloaded. */
  DownloadedExport: {},
  /** The review queue was cached on this device. */
  PersistedReviewQueue: {},
  /** The export did not land. */
  ExportFailed: { error: S.String },
  /** The grade did not land. It waits in `pending` for Retry. */
  GradeFailed: { id: S.String, error: S.String, durable: S.Boolean },
  /** The Learner pressed Retry on a grade that did not land. */
  ClickedRetryGrades: {},
  /** The learner chose to continue with due Cards only, past today's cap. */
  ClickedContinuePastDueLimit: {},
  /** The Learner pressed the Import button. */
  ClickedImport: {},
  /** The Learner picked an archive, and it hashes to this Import id. Nothing runs yet: the detail panel previews it first. */
  GotImportFile: { id: ImportId, filename: S.String },
  /** The archive's contents, read for the detail panel before anything is written. */
  GotImportPreview: { preview: ImportPreview },
  /** The Learner toggled Media on the detail panel. */
  ToggledImportMedia: { isChecked: S.Boolean },
  /** The Learner pressed Start on the detail panel. */
  ClickedStartImport: {},
  /** The Learner dismissed the file picker. Nothing was picked, so the panel closes. */
  CancelledImportSelect: {},
  /** Boot found a stored Import to resume, or none. */
  RestoredImportJob: { job: S.Option(ImportJobMeta) },
  /** Boot found cached list answers to seed the Queries, possibly none. */
  RestoredCachedQueries: { answers: S.Array(RestoredAnswer) },
  /** A newer shell is cached and waits for the next load. Never force-reloads. */
  ServiceWorkerAvailable: {},
  /** The Learner accepted the waiting shell: reload into it. */
  ClickedReloadApp: {},
  /** The reload was requested. The page unloads; nothing reads this. */
  AppliedSwUpdate: {},
  /** The Import worker opened the archive, or moved on to writing its rows. */
  ImportWorkerPhase: { phase: S.Literals(['reading', 'writing']) },
  /** The worker reached another step of opening the archive. */
  ReportedImportReadStage: { stage: ImportReadStage },
  /** The worker answered with how far the running Import has come. */
  ReportedImport: { progress: ImportProgress },
  /** The Import wrote every Note and Card it found. */
  CompletedImport: { progress: ImportProgress },
  /** The Import stopped before it finished. The archive is kept, so Retry resumes. */
  FailedImport: { error: S.String },
  /** The Learner pressed Retry on a stopped Import. */
  ClickedRetryImport: {},
  /** The Learner stopped a running Import. */
  ClickedCancelImport: {},
  /** The Learner dismissed the Import panel. */
  ClickedDismissImport: {},
  /** The stored archive was deleted. */
  ClearedImportJob: {},
  // Settings draft edits. Each carries the raw field value; validation runs on save.
  EditedRetention: { value: S.String },
  EditedMaximumInterval: { value: S.String },
  EditedNewPerDay: { value: S.String },
  EditedReviewsPerDay: { value: S.String },
  EditedLapseMinutes: { value: S.String },
  EditedRolloverHour: { value: S.String },
  ToggledTapToReveal: { isChecked: S.Boolean },
  /** The learner picked a Mochi swatch in Appearance. Applies at once. */
  PickedTheme: { theme: S.String },
  /** `ApplyTheme` ran: the DOM and storage already hold the theme. */
  AppliedTheme: {},
  ClickedSaveSettings: {},
  ClickedResetSettings: {},
  /** A settings hint tooltip moved (hover, focus, leave, Escape). */
  GotHintMessage: { slot: S.String, message: Tooltip.Message },
  /** The Learner opened the rename form, seeded from the deck's summary. */
  ClickedEditDeck: { deckId: DeckId, name: S.String, description: S.String },
  /** The Learner typed in the rename form. */
  TypedDeckName: { value: S.String },
  TypedDeckDescription: { value: S.String },
  /** The Learner closed the rename form without saving. */
  ClickedCancelDeckEdit: {},
  /** The Learner saved the rename form. */
  ClickedSaveDeck: { deckId: DeckId },
  /** The rename landed. The detail and list reads refresh after it. */
  RenamedDeck: { deckId: DeckId },
  /** The Learner typed a per-deck limit override. Blank follows Settings. */
  TypedDeckNewPerDay: { value: S.String },
  TypedDeckReviewsPerDay: { value: S.String },
  TypedDeckLapseMinutes: { value: S.String },
  /** The Learner opened the limits form, seeded from the deck's summary. */
  ClickedEditDeckLimits: {
    deckId: DeckId,
    newPerDay: S.String,
    reviewsPerDay: S.String,
    lapseMinutes: S.String,
  },
  /** The Learner saved the limits form. */
  ClickedSaveDeckLimits: { deckId: DeckId },
  /** The limits landed. The detail and list reads refresh after it. */
  SavedDeckLimits: { deckId: DeckId },
  /** The Learner closed the limits form without saving. */
  ClickedCancelDeckLimits: {},
  /** The Learner cleared the limits form to follow Settings. */
  ClickedResetDeckLimits: {},
  /** The Learner folded or unfolded the deck page's Card list. */
  ToggledDeckCards: {},
  /** The Learner opened a destructive confirm. Only one is open at a time. */
  ClickedResetDeck: { deckId: DeckId },
  ClickedRemoveDeck: { deckId: DeckId },
  /** The Learner closed the open confirm without acting. */
  ClickedCancelDeckConfirm: {},
  /** The Learner confirmed a destructive action. */
  ClickedConfirmResetDeck: { deckId: DeckId },
  ClickedConfirmRemoveDeck: { deckId: DeckId },
  /** The reset landed. The detail and list reads refresh after it. */
  ResetDeckDone: { deckId: DeckId },
  /** The removal landed. The app leaves for the deck list. */
  RemovedDeck: {},
  /** A deck mutation failed. The Manage section shows the reason. */
  DeckManageFailed: { deckId: DeckId, error: S.String },
})
export type Message = typeof Message.Type
