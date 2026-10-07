/**
 * `@nook/api` — the contract and the data model.
 *
 * Everything the browser and the Worker must agree on lives here:
 *
 * - the domain Schemas that cross the network boundary (Deck, Settings, …)
 * - `DEFAULT_SETTINGS`, the settings the form starts from before the server answers
 * - the Effect RPC contract, one `RpcGroup` per feature area plus the merged `Api`
 *
 * The browser and the Worker share this module: the Worker implements the
 * handlers, the browser calls them through one RPC client. The payload of each
 * procedure carries what used to ride in the URL or query string (deck ids,
 * timezones), so the wire is one RPC route instead of one REST path per action.
 *
 * The browser bundle imports this package, so it stays free of runtime
 * behaviour. Anything that needs a database client, a bucket, a clock, or a
 * request belongs in `@nook/backend` instead.
 *
 * Data-volume contract:
 *
 * - one learner, a handful of Decks (fewer than 20), each Deck holding
 *   dozens to low hundreds of Cards
 * - `DeckSummary` is the list-screen projection: counts plus the next
 *   Review only, never full Card bodies
 * - the deck page carries a plain-text prompt preview per Card; full bodies
 *   still arrive one at a time in the review queue
 * - the review queue serves one Card at a time; the browser never holds the
 *   whole collection
 */

import { Effect, Schema as S } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

/** Stable identifiers. Branded so a Deck id cannot flow where a Card id is expected. */
export const DeckId = S.String.pipe(S.brand('DeckId'))
export type DeckId = typeof DeckId.Type

export const CardId = S.String.pipe(S.brand('CardId'))
export type CardId = typeof CardId.Type

export const NoteTypeId = S.String.pipe(S.brand('NoteTypeId'))
export type NoteTypeId = typeof NoteTypeId.Type

/** Where a Card is in its life. */
export const CardState = S.Literals(['new', 'learning', 'review', 'relearning'])
export type CardState = typeof CardState.Type

/** One recallable item. Deck-detail rows carry a plain-text `preview` of the prompt side; full bodies still arrive one at a time in the review queue. */
export const Card = S.Struct({
  id: CardId,
  deckId: DeckId,
  /** ISO 8601 UTC instant this Card comes back. Absent for new Cards. */
  dueAt: S.Option(S.String),
  /** Days until this Card comes back. 0 means due now. Negative means overdue. */
  dueInDays: S.Number,
  /** Current FSRS stability in days. Owned by FSRS; shown on the deck page for transparency, never edited directly. */
  stability: S.Number,
  /** Current FSRS difficulty, 1–10. Owned by FSRS; shown, never edited directly. */
  difficulty: S.Number,
  state: CardState,
  /** Plain-text prompt preview for the deck page's Card rows. Empty when the Card has no readable text (media-only). */
  preview: S.optional(S.String).pipe(S.withDecodingDefault(Effect.succeed(''))),
})
export type Card = typeof Card.Type

/** The list-screen projection of a Deck: identity, counts, and the next Review. Never full Card bodies. */
export const DeckSummary = S.Struct({
  id: DeckId,
  name: S.String,
  description: S.String,
  /** Cards never reviewed. */
  newCount: S.Number,
  /** Cards due for Review right now. */
  dueCount: S.Number,
  /** All Cards in the Deck, including new and due. */
  totalCount: S.Number,
  /** ISO date of the most recent Review session. Absent when never studied. */
  lastStudiedAt: S.Option(S.String),
  /** Share reviewed in the last 7 days, 0–100. Drives the progress bar. */
  retention7d: S.Number,
})
export type DeckSummary = typeof DeckSummary.Type

/** One Deck with enough Card detail for its own page: the summary plus per-Card rows with prompt previews. Full bodies still arrive one at a time in the review queue. */
export const DeckDetail = S.Struct({
  summary: DeckSummary,
  cards: S.Array(Card),
})
export type DeckDetail = typeof DeckDetail.Type

/**
 * A Deck's new identity, as the rename endpoint receives it.
 *
 * The screen validates the name is non-blank before sending; the backend
 * trims both fields before storing.
 */
export const DeckRename = S.Struct({
  name: S.String,
  description: S.String,
})
export type DeckRename = typeof DeckRename.Type

/** Home-screen overview numbers, derived from all Decks. */
export const Overview = S.Struct({
  /** Cards due for Review right now, across every Deck. */
  dueNow: S.Number,
  /** Cards reviewed today. */
  reviewedToday: S.Number,
  /** Day streak. */
  streakDays: S.Number,
  /** Share of due Cards cleared today, 0–100. */
  todayProgress: S.Number,
  /** Reviews per day for the last 14 days, oldest first. */
  activity14d: S.Array(S.Number),
})
export type Overview = typeof Overview.Type

/** FSRS scheduling knobs. Mirrors the FSRS-6 defaults the backend will use; the settings page edits these, never stability/difficulty directly. */
export const FsrsSettings = S.Struct({
  /** Target recall probability, 0.7–0.95. */
  desiredRetention: S.Number,
  /** FSRS-6 weight vector (21 values). Advanced; edited as text. */
  weights: S.Array(S.Number),
  /** Cap on any single interval, in days. */
  maximumInterval: S.Number,
  /** New Cards introduced per day. */
  newPerDay: S.Number,
  /** Reviews allowed per day. */
  reviewsPerDay: S.Number,
  /** Minutes after which a paused review session lapses back to the queue. */
  lapseMinutes: S.Number,
})
export type FsrsSettings = typeof FsrsSettings.Type

/** Behaviour knobs: what the review session feels like. */
export const BehaviourSettings = S.Struct({
  /** Show the answer with a tap anywhere, not just the button. */
  tapToReveal: S.Boolean,
  /** Hour (0–23) at which the next day's Reviews become due. */
  dayRolloverHour: S.Number,
})
export type BehaviourSettings = typeof BehaviourSettings.Type

/** Everything the settings page edits. */
export const AppSettings = S.Struct({
  fsrs: FsrsSettings,
  behaviour: BehaviourSettings,
})
export type AppSettings = typeof AppSettings.Type

/** An Import's identity: the SHA-256 of the archive it read, as lowercase hex. */
export const ImportId = S.String.pipe(S.brand('ImportId'))
export type ImportId = typeof ImportId.Type

/**
 * One Note as it crosses the wire during an Import.
 *
 * The browser reads the archive and the Worker stores what it read, so the
 * Note's Fields and Tags arrive as the arrays nook uses rather than as Anki's
 * separator-joined columns. `id` is Anki's own note id, which is what makes a
 * re-import an overwrite: the same archive produces the same ids.
 */
export const ImportNote = S.Struct({
  id: S.Number,
  guid: S.String,
  noteTypeId: S.Number,
  /** Unix seconds, as Anki stores it. */
  modified: S.Number,
  fields: S.Array(S.String),
  tags: S.Array(S.String),
})
export type ImportNote = typeof ImportNote.Type

/** One Card as it crosses the wire during an Import. Scheduling is dropped: every imported Card starts new. */
export const ImportCard = S.Struct({
  id: S.Number,
  noteId: S.Number,
  deckId: S.Number,
  templateOrd: S.Number,
  suspended: S.Boolean,
  flag: S.Number,
})
export type ImportCard = typeof ImportCard.Type

/** One Deck as it crosses the wire during an Import. `name` is the display name, components joined with `::`. */
export const ImportDeck = S.Struct({
  id: S.Number,
  name: S.String,
  description: S.String,
})
export type ImportDeck = typeof ImportDeck.Type

/** One Field of an imported Note Type. */
export const ImportField = S.Struct({
  ord: S.Number,
  name: S.String,
  rightToLeft: S.Boolean,
  fontName: S.NullOr(S.String),
  fontSize: S.NullOr(S.Number),
  plainText: S.Boolean,
  description: S.String,
  sticky: S.Boolean,
})
export type ImportField = typeof ImportField.Type

/** One Template of an imported Note Type. Each Template produces one Card from a Note. */
export const ImportTemplate = S.Struct({
  ord: S.Number,
  name: S.String,
  questionFormat: S.String,
  answerFormat: S.String,
  deckId: S.Number,
})
export type ImportTemplate = typeof ImportTemplate.Type

/** A Note Type as it crosses the wire during an Import. */
export const ImportNoteType = S.Struct({
  id: S.Number,
  name: S.String,
  kind: S.Literals(['normal', 'cloze']),
  sortFieldOrd: S.Number,
  css: S.String,
  fields: S.Array(ImportField),
  templates: S.Array(ImportTemplate),
})
export type ImportNoteType = typeof ImportNoteType.Type

/**
 * What the archive said it holds, sent once when an Import starts.
 *
 * The counts give progress a denominator and the Decks and Note Types are
 * written up front, so a Note or Card can reference them no matter which
 * batch it lands in.
 */
export const ImportManifest = S.Struct({
  schemaVersion: S.Number,
  noteTypes: S.Array(ImportNoteType),
  decks: S.Array(ImportDeck),
  noteCount: S.Number,
  cardCount: S.Number,
  /** How many Media files the archive carries. They stream into R2 during the Import. */
  mediaCount: S.Number,
})
export type ImportManifest = typeof ImportManifest.Type

/**
 * How far an Import has come, and everything the screens need to show it.
 *
 * The cursors are the last Anki id written in each stream. A run that fails
 * midway reads them back and continues, so the browser never restarts an
 * Import it already began.
 */
export const ImportStatus = S.Struct({
  id: ImportId,
  filename: S.String,
  status: S.Literals(['running', 'done', 'failed']),
  notesCursor: S.Number,
  cardsCursor: S.Number,
  notesImported: S.Number,
  cardsImported: S.Number,
  noteCount: S.Number,
  cardCount: S.Number,
  /** Media the archive carries, streamed into R2 during the Import. */
  mediaCount: S.Number,
  /** Why the last run failed, for the screen to show. `None` while it runs or after it finishes. */
  error: S.Option(S.String),
})
export type ImportStatus = typeof ImportStatus.Type

/** What the browser sends to begin an Import. */
export const ImportStart = S.Struct({
  id: ImportId,
  filename: S.String,
  manifest: ImportManifest,
})
export type ImportStart = typeof ImportStart.Type

/** One step of each stream. Either array may be empty: Notes and Cards are separate streams. */
export const ImportBatchPayload = S.Struct({
  notes: S.Array(ImportNote),
  cards: S.Array(ImportCard),
})
export type ImportBatchPayload = typeof ImportBatchPayload.Type

/** Why a run stopped, as one sentence for the Learner. */
export const ImportFailure = S.Struct({ error: S.String })
export type ImportFailure = typeof ImportFailure.Type

/** Deck id on the URL that names no Deck. Returned as a 404. */
export class DeckNotFound extends S.TaggedError<DeckNotFound>()('DeckNotFound', {
  deckId: DeckId,
}) {}

/** The URL names no Import. Returned as a 404. */
export class ImportNotFound extends S.TaggedError<ImportNotFound>()('ImportNotFound', {
  importId: ImportId,
}) {}

/**
 * The database did not answer. Returned as a 503 so the browser can retry.
 *
 * Every endpoint that reads D1 can fail with this. The message stays generic
 * on purpose; the detail goes to the server log, not to the Learner.
 */
export class StorageUnavailable extends S.TaggedError<StorageUnavailable>()('StorageUnavailable', {
  message: S.String,
}) {}

/** The judgement a Learner makes during a Review. The order is FSRS's rating order. */
export const Grade = S.Literals(['Again', 'Hard', 'Good', 'Easy'])
export type Grade = typeof Grade.Type

/**
 * One Card as the review queue serves it.
 *
 * The two sides arrive rendered, because the Worker owns the Note Type's
 * Template and stylesheet. `css` is scoped to the card container, so a Note
 * Type's stylesheet cannot restyle the app.
 */
export const ReviewCard = S.Struct({
  cardId: CardId,
  deckId: DeckId,
  noteId: S.String,
  /** The question side, rendered from the Note Type's Template. */
  question: S.String,
  /** The answer side, with the question repeated through `FrontSide`. */
  answer: S.String,
  /** The Note Type's stylesheet, scoped to the card container. */
  css: S.String,
  state: CardState,
  dueAt: S.Option(S.String),
  dueInDays: S.Number,
  stability: S.Number,
  difficulty: S.Number,
})
export type ReviewCard = typeof ReviewCard.Type

/** The Cards waiting to be reviewed, due first, then new. */
export const ReviewQueue = S.Struct({
  cards: S.Array(ReviewCard),
  /** ISO 8601 UTC instant the learner-day boundary sits at, for the client's clock display. */
  dayStartUtc: S.String,
})
export type ReviewQueue = typeof ReviewQueue.Type

/**
 * One graded Review, as the browser sends it.
 *
 * `id` is generated on the device, so the server can ignore a replay after a
 * dropped response: the same id never lands twice (ADR 0002). The server
 * timestamps the Review, because client clocks lie.
 */
export const ReviewSubmission = S.Struct({
  id: S.String,
  cardId: CardId,
  grade: Grade,
  /** IANA timezone the learner reviews in, e.g. `Asia/Jakarta`. Picks the day boundary. */
  timezone: S.optional(S.String),
})
export type ReviewSubmission = typeof ReviewSubmission.Type

/** The Card's scheduling state after a graded Review. */
export const ReviewAccepted = S.Struct({
  cardId: CardId,
  grade: Grade,
  state: CardState,
  dueInDays: S.Number,
  stability: S.Number,
  difficulty: S.Number,
  intervalDays: S.Number,
  /** ISO 8601 UTC instant the Card comes back, for the client's countdown. */
  dueAt: S.String,
  /** Whether the Card returns later this session, after `lapseMinutes`. Only on `Again`. */
  requeueInSession: S.Boolean,
})
export type ReviewAccepted = typeof ReviewAccepted.Type

/**
 * The last graded Review, undone.
 *
 * Undo deletes the Review log row and restores the Card's scheduling state
 * from before the grade. Only the most recent grade of the session can be
 * undone, and only before another grade lands on the same Card.
 */
export const UndoReview = S.Struct({
  cardId: CardId,
})
export type UndoReview = typeof UndoReview.Type

export const UndoAccepted = S.Struct({
  cardId: CardId,
  state: CardState,
  dueInDays: S.Number,
  stability: S.Number,
  difficulty: S.Number,
})
export type UndoAccepted = typeof UndoAccepted.Type

/** One row of the exported collection: the Note content a Card renders. */
export const ExportNote = S.Struct({
  id: S.String,
  noteTypeId: S.String,
  guid: S.String,
  fields: S.Array(S.String),
  tags: S.Array(S.String),
  modified: S.Number,
})
export type ExportNote = typeof ExportNote.Type

/** One row of the exported collection: a Card and its scheduling state. */
export const ExportCard = S.Struct({
  id: S.String,
  deckId: S.String,
  noteId: S.NullOr(S.String),
  templateOrd: S.Number,
  suspended: S.Boolean,
  state: CardState,
  stability: S.Number,
  difficulty: S.Number,
  dueAt: S.NullOr(S.String),
  reps: S.Number,
  lapses: S.Number,
  lastReviewedAt: S.NullOr(S.String),
})
export type ExportCard = typeof ExportCard.Type

/** One row of the exported collection: a Deck's identity. */
export const ExportDeck = S.Struct({
  id: S.String,
  name: S.String,
  description: S.String,
})
export type ExportDeck = typeof ExportDeck.Type

/** One row of the exported collection: a Review log entry. */
export const ExportReview = S.Struct({
  id: S.String,
  cardId: S.String,
  grade: Grade,
  reviewedAt: S.String,
})
export type ExportReview = typeof ExportReview.Type

/** The whole collection, as the export endpoint serves it. Re-import is out of scope for v1. */
export const CollectionExport = S.Struct({
  exportedAt: S.String,
  decks: S.Array(ExportDeck),
  notes: S.Array(ExportNote),
  cards: S.Array(ExportCard),
  reviews: S.Array(ExportReview),
})
export type CollectionExport = typeof CollectionExport.Type

/** The Card a Review names does not exist. Returned as a 404. */
export class CardNotFound extends S.TaggedError<CardNotFound>()('CardNotFound', {
  cardId: CardId,
}) {}

export class DecksRpc extends RpcGroup.make(
  Rpc.make('decksList', {
    success: S.Array(DeckSummary),
    error: StorageUnavailable,
  }),
  Rpc.make('decksGetById', {
    payload: { deckId: DeckId },
    success: DeckDetail,
    error: S.Union([DeckNotFound, StorageUnavailable]),
  }),
  /**
   * Change a Deck's name and description. A blank name is rejected before
   * it reaches SQL; an unknown id is a `DeckNotFound`.
   */
  Rpc.make('decksRename', {
    payload: { deckId: DeckId, rename: DeckRename },
    success: DeckDetail,
    error: S.Union([DeckNotFound, StorageUnavailable]),
  }),
  /**
   * Clear a Deck's scheduling: every Card returns to `new`, its Review log
   * is removed, and its scheduling state is zeroed. The Notes and the
   * rendered queue are untouched — only the Schedule goes.
   */
  Rpc.make('decksReset', {
    payload: { deckId: DeckId },
    success: DeckDetail,
    error: S.Union([DeckNotFound, StorageUnavailable]),
  }),
  /**
   * Remove a Deck and everything that belongs to it alone: its Cards, its
   * Review log, and Notes no other Deck's Cards reference. Shared Note Types
   * stay. There is no undo; the screen confirms first.
   */
  Rpc.make('decksRemove', {
    payload: { deckId: DeckId },
    success: S.Void,
    error: S.Union([DeckNotFound, StorageUnavailable]),
  }),
) {}

export class HomeRpc extends RpcGroup.make(
  Rpc.make('homeOverview', {
    /** The learner timezone, for the day boundary. The server defaults to UTC without it. */
    payload: { timezone: S.optional(S.String) },
    success: Overview,
    error: StorageUnavailable,
  }),
) {}

export class SettingsRpc extends RpcGroup.make(
  Rpc.make('settingsGet', {
    success: AppSettings,
    error: StorageUnavailable,
  }),
  Rpc.make('settingsUpdate', {
    payload: AppSettings,
    success: AppSettings,
    error: StorageUnavailable,
  }),
) {}

/**
 * The Import procedures.
 *
 * The browser reads the archive and the Worker stores what it read, one batch
 * at a time. `importsStart` is keyed by the archive's content hash, so the same file
 * imported twice lands on the same Import and the second run resumes from the
 * cursors `importsStart` returns. `importsWriteBatch` carries the rows for one step of each
 * stream; `importsComplete` marks the Import finished.
 */
export class ImportsRpc extends RpcGroup.make(
  Rpc.make('importsStart', {
    payload: ImportStart,
    success: ImportStatus,
    error: StorageUnavailable,
  }),
  Rpc.make('importsWriteBatch', {
    payload: { importId: ImportId, batch: ImportBatchPayload },
    success: ImportStatus,
    error: S.Union([ImportNotFound, StorageUnavailable]),
  }),
  Rpc.make('importsComplete', {
    payload: { importId: ImportId },
    success: ImportStatus,
    error: S.Union([ImportNotFound, StorageUnavailable]),
  }),
  Rpc.make('importsFail', {
    payload: { importId: ImportId, error: S.String },
    success: ImportStatus,
    error: S.Union([ImportNotFound, StorageUnavailable]),
  }),
  Rpc.make('importsGet', {
    payload: { importId: ImportId },
    success: ImportStatus,
    error: S.Union([ImportNotFound, StorageUnavailable]),
  }),
) {}

export class ReviewsRpc extends RpcGroup.make(
  Rpc.make('reviewsQueue', {
    payload: { deckId: S.optional(DeckId), timezone: S.optional(S.String) },
    success: ReviewQueue,
    error: StorageUnavailable,
  }),
  Rpc.make('reviewsGrade', {
    payload: ReviewSubmission,
    success: ReviewAccepted,
    error: S.Union([CardNotFound, StorageUnavailable]),
  }),
  Rpc.make('reviewsUndo', {
    payload: UndoReview,
    success: UndoAccepted,
    error: S.Union([CardNotFound, StorageUnavailable]),
  }),
  Rpc.make('reviewsExport', {
    success: CollectionExport,
    error: StorageUnavailable,
  }),
) {}

/** The whole contract: every procedure the browser calls and the Worker serves. */
export class Api extends DecksRpc.merge(SettingsRpc, HomeRpc, ImportsRpc, ReviewsRpc) {}

/**
 * The settings the form starts from, before the server's own answer arrives.
 * They match the FSRS-6 defaults, so a first paint is never misleading.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  fsrs: {
    desiredRetention: 0.9,
    weights: [
      0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
      0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
    ],
    maximumInterval: 365,
    newPerDay: 20,
    reviewsPerDay: 200,
    lapseMinutes: 10,
  },
  behaviour: {
    tapToReveal: true,
    dayRolloverHour: 4,
  },
}
