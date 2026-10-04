/**
 * `@nook/api` — the contract and the data model.
 *
 * Everything the browser and the Worker must agree on lives here:
 *
 * - the domain Schemas that cross the network boundary (Deck, Settings, …)
 * - the seeded dummy data the UI paints with at boot, before fetch answers
 *   replace it
 * - the Effect HttpApi contract, one `HttpApiGroup` per feature area
 *
 * The browser bundle imports this package, so it stays free of runtime
 * behaviour. Anything that needs a database client, a bucket, a clock, or a
 * request belongs in `@nook/backend` instead.
 *
 * Data-volume contract (the boot seed mirrors backend rows):
 *
 * - one learner, a handful of Decks (fewer than 20), each Deck holding
 *   dozens to low hundreds of Cards
 * - `DeckSummary` is the list-screen projection: counts plus the next
 *   Review only, never full Card bodies
 * - the review queue serves one Card at a time; the browser never holds the
 *   whole collection
 */

import { Option, Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'

/** Stable identifiers. Branded so a Deck id cannot flow where a Card id is expected. */
export const DeckId = S.String.pipe(S.brand('DeckId'))
export type DeckId = typeof DeckId.Type

export const CardId = S.String.pipe(S.brand('CardId'))
export type CardId = typeof CardId.Type

export const NoteTypeId = S.String.pipe(S.brand('NoteTypeId'))
export type NoteTypeId = typeof NoteTypeId.Type

/** One recallable item. The list screens never carry prompt/answer bodies — those arrive one at a time in the review queue. */
export const Card = S.Struct({
  id: CardId,
  deckId: DeckId,
  /** Days until this Card comes back. 0 means due now. Negative means overdue. */
  dueInDays: S.Number,
  /** Current FSRS stability in days. Owned by FSRS; shown on the deck page for transparency, never edited directly. */
  stability: S.Number,
  /** Current FSRS difficulty, 1–10. Owned by FSRS; shown, never edited directly. */
  difficulty: S.Number,
  state: S.Literals(['new', 'learning', 'review', 'relearning']),
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
  /** Day-over-day change in due Reviews, for the trend marker. */
  dueDelta: S.Number,
  /** ISO date of the most recent Review session. Absent when never studied. */
  lastStudiedAt: S.Option(S.String),
  /** Share reviewed in the last 7 days, 0–100. Drives the progress bar. */
  retention7d: S.Number,
})
export type DeckSummary = typeof DeckSummary.Type

/** One Deck with enough Card detail for its own page: the summary plus per-Card rows. Bodies stay out; the table shows scheduling state only. */
export const DeckDetail = S.Struct({
  summary: DeckSummary,
  cards: S.Array(Card),
})
export type DeckDetail = typeof DeckDetail.Type

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
  /** FSRS-6 weight vector (17 values). Advanced; edited as text. */
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

/** Behaviour knobs: what the learner hears and when the day rolls over. */
export const BehaviourSettings = S.Struct({
  /** Sound/haptic feedback on grading. */
  reviewSounds: S.Boolean,
  /** Show the answer with a tap anywhere, not just the button. */
  tapToReveal: S.Boolean,
  /** Hour (0–23) at which the next day's Reviews become due. */
  dayRolloverHour: S.Number,
  /** Keep the screen awake during a review session. */
  keepAwake: S.Boolean,
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
  /** How many Media files the archive carries. nook counts them but does not store them yet. */
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
  /** Media the archive carries, which nook does not store yet. The screen says so. */
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

export class DecksGroup extends HttpApiGroup.make('decks')
  .add(
    HttpApiEndpoint.get('list', '/', {
      success: S.Array(DeckSummary),
      error: StorageUnavailable.pipe(HttpApiSchema.status(503)),
    }),
    HttpApiEndpoint.get('getById', '/:deckId', {
      params: { deckId: DeckId },
      success: DeckDetail,
      error: [
        DeckNotFound.pipe(HttpApiSchema.status(404)),
        StorageUnavailable.pipe(HttpApiSchema.status(503)),
      ],
    }),
  )
  .prefix('/decks') {}

export class HomeGroup extends HttpApiGroup.make('home')
  .add(
    HttpApiEndpoint.get('overview', '/', {
      success: Overview,
      error: StorageUnavailable.pipe(HttpApiSchema.status(503)),
    }),
  )
  .prefix('/home') {}

export class SettingsGroup extends HttpApiGroup.make('settings')
  .add(
    HttpApiEndpoint.get('get', '/', {
      success: AppSettings,
      error: StorageUnavailable.pipe(HttpApiSchema.status(503)),
    }),
    HttpApiEndpoint.put('update', '/', {
      payload: AppSettings,
      success: AppSettings,
      error: StorageUnavailable.pipe(HttpApiSchema.status(503)),
    }),
  )
  .prefix('/settings') {}

/**
 * The Import endpoints.
 *
 * The browser reads the archive and the Worker stores what it read, one batch
 * at a time. `start` is keyed by the archive's content hash, so the same file
 * imported twice lands on the same Import and the second run resumes from the
 * cursors `start` returns. `writeBatch` carries the rows for one step of each
 * stream; `complete` marks the Import finished.
 */
export class ImportsGroup extends HttpApiGroup.make('imports')
  .add(
    HttpApiEndpoint.post('start', '/', {
      payload: ImportStart,
      success: ImportStatus,
      error: StorageUnavailable.pipe(HttpApiSchema.status(503)),
    }),
    HttpApiEndpoint.post('writeBatch', '/:importId/batch', {
      params: { importId: ImportId },
      payload: ImportBatchPayload,
      success: ImportStatus,
      error: [
        ImportNotFound.pipe(HttpApiSchema.status(404)),
        StorageUnavailable.pipe(HttpApiSchema.status(503)),
      ],
    }),
    HttpApiEndpoint.post('complete', '/:importId/complete', {
      params: { importId: ImportId },
      success: ImportStatus,
      error: [
        ImportNotFound.pipe(HttpApiSchema.status(404)),
        StorageUnavailable.pipe(HttpApiSchema.status(503)),
      ],
    }),
    HttpApiEndpoint.post('fail', '/:importId/fail', {
      params: { importId: ImportId },
      payload: ImportFailure,
      success: ImportStatus,
      error: [
        ImportNotFound.pipe(HttpApiSchema.status(404)),
        StorageUnavailable.pipe(HttpApiSchema.status(503)),
      ],
    }),
    HttpApiEndpoint.get('get', '/:importId', {
      params: { importId: ImportId },
      success: ImportStatus,
      error: [
        ImportNotFound.pipe(HttpApiSchema.status(404)),
        StorageUnavailable.pipe(HttpApiSchema.status(503)),
      ],
    }),
  )
  .prefix('/imports') {}

export class Api extends HttpApi.make('nook-api')
  .add(DecksGroup)
  .add(HomeGroup)
  .add(SettingsGroup)
  .add(ImportsGroup)
  .prefix('/api') {}

/**
 * Boot seed. The UI paints with this at boot, before fetch answers replace
 * it; the shapes are the shapes the endpoints return, so the views never
 * know which source filled the Model.
 */
export const DUMMY_DECKS: ReadonlyArray<DeckSummary> = [
  {
    id: DeckId.make('deck-japanese-core'),
    name: 'Japanese Core 2k',
    description: 'Everyday vocabulary, kana to kanji',
    newCount: 48,
    dueCount: 132,
    totalCount: 1840,
    dueDelta: 12,
    lastStudiedAt: Option.some('2026-10-02T21:40:00+07:00'),
    retention7d: 68,
  },
  {
    id: DeckId.make('deck-anki-biology'),
    name: 'Biology 101',
    description: 'Cell structure, genetics, evolution',
    newCount: 15,
    dueCount: 64,
    totalCount: 420,
    dueDelta: -8,
    lastStudiedAt: Option.some('2026-10-03T07:15:00+07:00'),
    retention7d: 82,
  },
  {
    id: DeckId.make('deck-capitals'),
    name: 'World Capitals',
    description: 'Countries and their capitals',
    newCount: 0,
    dueCount: 21,
    totalCount: 196,
    dueDelta: 0,
    lastStudiedAt: Option.some('2026-10-01T19:05:00+07:00'),
    retention7d: 91,
  },
  {
    id: DeckId.make('deck-spanish-verbs'),
    name: 'Spanish Verbs',
    description: 'Top 100 irregular conjugations',
    newCount: 22,
    dueCount: 0,
    totalCount: 100,
    dueDelta: 3,
    lastStudiedAt: Option.none(),
    retention7d: 0,
  },
  {
    id: DeckId.make('deck-algorithms'),
    name: 'Algorithms',
    description: 'Complexities and proof sketches',
    newCount: 9,
    dueCount: 37,
    totalCount: 158,
    dueDelta: -2,
    lastStudiedAt: Option.some('2026-09-30T22:10:00+07:00'),
    retention7d: 74,
  },
]

export const DUMMY_OVERVIEW: Overview = {
  dueNow: 254,
  reviewedToday: 96,
  streakDays: 12,
  todayProgress: 27,
  activity14d: [42, 55, 38, 61, 70, 44, 58, 66, 51, 73, 69, 80, 64, 96],
}

export const DUMMY_SETTINGS: AppSettings = {
  fsrs: {
    desiredRetention: 0.9,
    weights: [
      0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.7969, 1.4835,
      0.0614, 0.2629, 1.6483, 0.6014, 1.8729,
    ],
    maximumInterval: 365,
    newPerDay: 20,
    reviewsPerDay: 200,
    lapseMinutes: 10,
  },
  behaviour: {
    reviewSounds: true,
    tapToReveal: true,
    dayRolloverHour: 4,
    keepAwake: false,
  },
}

/** Scheduling-state rows for a deck page. Derived deterministically from the deck id so every deck gets a stable, realistic-looking table. */
export const dummyCardsFor = (deckId: DeckId): ReadonlyArray<Card> => {
  let seed = 0
  for (const char of deckId) seed = (seed * 31 + char.charCodeAt(0)) >>> 0
  const pick = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed % n
  }
  const states = ['new', 'learning', 'review', 'review', 'review', 'relearning'] as const
  return Array.from({ length: 24 }, (_, index) => {
    const state = states[pick(states.length)] ?? 'review'
    return {
      id: CardId.make(`${deckId}#${index + 1}`),
      deckId,
      dueInDays: state === 'new' ? 0 : pick(21) - 3,
      stability: Math.round((0.5 + pick(4000) / 100) * 10) / 10,
      difficulty: 1 + pick(10),
      state,
    } satisfies Card
  })
}
