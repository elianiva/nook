/**
 * `Reviews` — the review queue and the grade write.
 *
 * The queue reads the Cards that are due now plus the new Cards the day's
 * limit allows, joins each to its Note and Note Type, and renders both sides
 * with `@nook/anki/render`. The browser never holds the whole collection: it
 * asks for a queue and gets rendered Cards back.
 *
 * A grade is one append-only row in the Review log (ADR 0002) plus the Card's
 * derived scheduling state, written in one `db.batch` (ADR 0003). A replayed
 * submission id is ignored, so a dropped response cannot double-apply a grade.
 *
 * The learner day starts at `dayRolloverHour` in the learner timezone, not at
 * UTC midnight: the per-day counts count Reviews since that boundary, while
 * due-ness compares `due_at` against now. Due instants land at the boundary,
 * never at review-minute plus N days. `Again` re-queues later this session
 * (after `lapseMinutes`); grading a Card buries its same-Note siblings until
 * the next day.
 *
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry). A Card id no Card answers to is a 404 `CardNotFound`.
 */

import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import { renderCard, scopeCss } from '@nook/anki/render'
import {
  CardId,
  CardNotFound,
  CollectionExport,
  DeckId,
  ReviewsRpc,
  StorageUnavailable,
} from '@nook/api'
import type {
  ExportCard,
  ExportDeck,
  ExportNote,
  ExportReview,
  ReviewAccepted,
  ReviewCard,
  ReviewQueue,
  ReviewSubmission,
  UndoAccepted,
} from '@nook/api'
import { runStatements } from './batch'
import { dayStartUtc, dueInstantUtc, resolveTimezone, reviewDayKey } from './day-boundary'
import { scheduleReview } from './fsrs'
import { StoredField, StoredTemplate } from './note-type-rows'
import { CountRow, decodeRows, withStorageErrorPassThrough } from './storage-error'
import type { StorageError } from './storage-error'

/** The element the scoped Note Type stylesheet is confined to. The screen uses the same id. */
const CARD_SCOPE = '#nook-card'

/** How many rendered Cards one queue carries. ADR 0001 sizes the device's prefetch at this. */
const QUEUE_LIMIT = 200

/** Where the browser loads a Media file from. */
const mediaUrl = (name: string): string => `/api/media/${encodeURIComponent(name)}`

const CardStateRow = Schema.Literals(['new', 'learning', 'review', 'relearning'])

/** One row of the queue join. */
const QueueRow = Schema.Struct({
  cardId: Schema.String,
  deckId: Schema.String,
  noteId: Schema.String,
  templateOrd: Schema.Number,
  state: CardStateRow,
  stability: Schema.Number,
  difficulty: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  dueInDays: Schema.Number,
  noteFields: Schema.String,
  noteTags: Schema.String,
  noteTypeName: Schema.String,
  noteTypeKind: Schema.Literals(['normal', 'cloze']),
  noteTypeCss: Schema.String,
  noteTypeFields: Schema.String,
  noteTypeTemplates: Schema.String,
  deckName: Schema.String,
})

/** One row of the `cards` table, as the scheduler reads it. */
const CardRow = Schema.Struct({
  cardId: Schema.String,
  deckId: Schema.String,
  state: CardStateRow,
  stability: Schema.Number,
  difficulty: Schema.Number,
  reps: Schema.Number,
  lapses: Schema.Number,
  dueInDays: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  noteId: Schema.NullOr(Schema.String),
  introducedDay: Schema.NullOr(Schema.String),
  buriedUntil: Schema.NullOr(Schema.String),
  lastReviewedAt: Schema.NullOr(Schema.String),
})

/** The FSRS knobs, read straight from the singleton settings row. */
const FsrsRow = Schema.Struct({
  weights: Schema.String,
  desiredRetention: Schema.Number,
  maximumInterval: Schema.Number,
  newPerDay: Schema.Number,
  reviewsPerDay: Schema.Number,
  lapseMinutes: Schema.Number,
  dayRolloverHour: Schema.Number,
})

/** One Deck's limit overrides, as the `decks` table stores them. */
const DeckLimitsRow = Schema.Struct({
  newPerDay: Schema.NullOr(Schema.Number),
  reviewsPerDay: Schema.NullOr(Schema.Number),
  lapseMinutes: Schema.NullOr(Schema.Number),
})

/** One row of the last grade, for undo. */
const LastReviewRow = Schema.Struct({
  id: Schema.String,
  cardId: Schema.String,
  grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
})

/** Renders one queue row into a Card the browser can show. */
const toReviewCard = (row: typeof QueueRow.Type): Effect.Effect<ReviewCard, Schema.SchemaError> =>
  Effect.gen(function* () {
    const fields = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(StoredField)),
    )(row.noteTypeFields)
    const templates = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(StoredTemplate)),
    )(row.noteTypeTemplates)
    const noteFields = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(row.noteFields)
    const noteTags = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.String)),
    )(row.noteTags)

    const rendered = renderCard({
      noteType: {
        name: row.noteTypeName,
        kind: row.noteTypeKind,
        css: row.noteTypeCss,
        fields,
        templates,
      },
      note: { fields: noteFields, tags: noteTags },
      templateOrd: row.templateOrd,
      deckName: row.deckName,
      mediaUrl,
    })

    return {
      cardId: CardId.make(row.cardId),
      deckId: DeckId.make(row.deckId),
      noteId: row.noteId,
      question: rendered.question,
      answer: rendered.answer,
      css: scopeCss(rendered.css, CARD_SCOPE),
      state: row.state,
      dueAt: row.dueAt === null ? Option.none() : Option.some(row.dueAt),
      dueInDays: row.dueInDays,
      stability: row.stability,
      difficulty: row.difficulty,
    } satisfies ReviewCard
  })

/**
 * Reviews read and write through the `SqlClient` the layer closes over, so the
 * service interface carries no requirements — see `Decks` for why.
 */
export class Reviews extends Context.Service<
  Reviews,
  {
    queue(input: {
      deckId: Option.Option<DeckId>
      timezone?: string | undefined
      bypassDueLimit?: boolean | undefined
    }): Effect.Effect<ReviewQueue, StorageUnavailable>
    grade(
      submission: ReviewSubmission,
    ): Effect.Effect<ReviewAccepted, CardNotFound | StorageUnavailable>
    undo(input: { cardId: CardId }): Effect.Effect<UndoAccepted, CardNotFound | StorageUnavailable>
    exportCollection(): Effect.Effect<CollectionExport, StorageUnavailable>
  }
>()('nook/backend/Reviews') {
  static readonly layer = Layer.effect(
    Reviews,
    Effect.gen(function* () {
      const sql = yield* Sql.SqlClient

      const readFsrs = Effect.gen(function* () {
        const rows = yield* sql`SELECT fsrs_weights AS weights,
          fsrs_desired_retention AS "desiredRetention",
          fsrs_maximum_interval AS "maximumInterval",
          fsrs_new_per_day AS "newPerDay",
          fsrs_reviews_per_day AS "reviewsPerDay",
          fsrs_lapse_minutes AS "lapseMinutes",
          behaviour_day_rollover_hour AS "dayRolloverHour"
          FROM settings WHERE id = 1`
        const decoded = yield* decodeRows(FsrsRow, rows)
        const row = decoded[0]
        if (row === undefined) {
          return yield* new StorageUnavailable({
            message:
              'Could not read the scheduler settings. The settings store is missing its row.',
          })
        }
        return row
      })

      const readCard = (
        cardId: CardId,
      ): Effect.Effect<typeof CardRow.Type | undefined, StorageError> =>
        Effect.gen(function* () {
          const rows = yield* sql`SELECT id AS "cardId", deck_id AS "deckId", state, stability,
            difficulty, COALESCE(reps, 0) AS reps, COALESCE(lapses, 0) AS lapses,
            COALESCE(CAST(julianday(due_at) - julianday('now') AS INTEGER), 0) AS "dueInDays",
            due_at AS "dueAt", note_id AS "noteId", introduced_day AS "introducedDay",
            buried_until AS "buriedUntil",
            last_reviewed_at AS "lastReviewedAt"
            FROM cards WHERE id = ${cardId}`
          const decoded = yield* decodeRows(CardRow, rows)
          return decoded[0]
        })

      /**
       * Due Cards first, then new ones, capped by the day's remaining limits.
       *
       * The review limit counts distinct Cards answered today (re-grades of
       * one Card count once, like Anki), and the new limit counts Cards
       * introduced today. A buried Card — a same-Note sibling of a graded
       * Card, or an `Again` waiting out its lapse — stays out until its
       * instant passes. `dueInDays` for a Card with no due instant (a new
       * Card) is 0.
       *
       * A deck page names one Deck, so that Deck's overrides win over
       * Settings; the all-decks queue keeps the global values. The answer
       * carries both the queue and the counts behind it, so the done screen
       * can name the limit instead of "nothing due".
       */
      const queue = (input: {
        deckId: Option.Option<DeckId>
        timezone?: string | undefined
        bypassDueLimit?: boolean | undefined
      }): Effect.Effect<ReviewQueue, StorageUnavailable> =>
        Effect.gen(function* () {
          const fsrs = yield* readFsrs
          const now = new Date()
          const timezone = resolveTimezone(input.timezone)
          const boundary = dayStartUtc(timezone, fsrs.dayRolloverHour, now)
          const todayKey = reviewDayKey(timezone, fsrs.dayRolloverHour, now)
          const deck = Option.getOrNull(input.deckId)

          const limitsRows =
            deck === null
              ? []
              : yield* sql`SELECT new_per_day AS "newPerDay", reviews_per_day AS "reviewsPerDay",
                lapse_minutes AS "lapseMinutes" FROM decks WHERE id = ${deck}`
          const limitsDecoded = yield* decodeRows(DeckLimitsRow, limitsRows)
          const override = limitsDecoded[0]
          const newPerDay = override?.newPerDay ?? fsrs.newPerDay
          const reviewsPerDay = override?.reviewsPerDay ?? fsrs.reviewsPerDay
          const lapseMinutes = override?.lapseMinutes ?? fsrs.lapseMinutes

          // Anki behaviour: one Card counts once, no matter how often it was
          // graded today. `Again` re-grades never consume the review limit.
          const reviewCountRows = yield* sql`SELECT COUNT(DISTINCT card_id) AS n FROM reviews
            WHERE reviewed_at >= ${boundary}
            AND (${deck} IS NULL OR card_id IN (SELECT id FROM cards WHERE deck_id = ${deck}))`
          const reviewCounts = yield* decodeRows(CountRow, reviewCountRows)
          const reviewedToday = reviewCounts[0]?.n ?? 0
          const newCountRows = yield* sql`SELECT COUNT(*) AS n FROM cards
            WHERE introduced_day >= ${todayKey} AND state != 'new'
            AND (${deck} IS NULL OR deck_id = ${deck})`
          const newCounts = yield* decodeRows(CountRow, newCountRows)
          const introducedToday = newCounts[0]?.n ?? 0

          // Totals before the limits, for the done screen's "N more tomorrow".
          const totalDueRows = yield* sql`SELECT COUNT(*) AS n FROM cards c
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND c.state != 'new' AND c.due_at IS NOT NULL
              AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (${deck} IS NULL OR c.deck_id = ${deck})`
          const totalDue = (yield* decodeRows(CountRow, totalDueRows))[0]?.n ?? 0
          const totalNewRows = yield* sql`SELECT COUNT(*) AS n FROM cards c
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND c.state = 'new'
              AND (${deck} IS NULL OR c.deck_id = ${deck})`
          const totalNew = (yield* decodeRows(CountRow, totalNewRows))[0]?.n ?? 0

          const dueAllowed = input.bypassDueLimit
            ? totalDue
            : Math.max(0, reviewsPerDay - reviewedToday)
          const newAllowed = input.bypassDueLimit ? 0 : Math.max(0, newPerDay - introducedToday)

          const rows = yield* sql`SELECT c.id AS "cardId", c.deck_id AS "deckId",
            c.note_id AS "noteId", c.template_ord AS "templateOrd",
            c.state AS state, c.stability AS stability, c.difficulty AS difficulty,
            c.due_at AS "dueAt",
            COALESCE(CAST(julianday(c.due_at) - julianday('now') AS INTEGER), 0) AS "dueInDays",
            n.fields AS "noteFields", n.tags AS "noteTags",
            nt.name AS "noteTypeName", nt.kind AS "noteTypeKind", nt.css AS "noteTypeCss",
            nt.fields AS "noteTypeFields", nt.templates AS "noteTypeTemplates",
            d.name AS "deckName"
            FROM cards c
            JOIN notes n ON n.id = c.note_id
            JOIN note_types nt ON nt.id = n.note_type_id
            JOIN decks d ON d.id = c.deck_id
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND (c.state = 'new' OR (c.due_at IS NOT NULL AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
              AND (${input.bypassDueLimit ?? false} = 0 OR c.state != 'new')
              AND (${deck} IS NULL OR c.deck_id = ${deck})
            ORDER BY CASE WHEN c.state = 'new' THEN 1 ELSE 0 END, c.due_at
            LIMIT ${QUEUE_LIMIT}`
          const decoded = yield* decodeRows(QueueRow, rows)
          const dueWaiting = decoded.filter((row) => row.state !== 'new')
          const newWaiting = decoded.filter((row) => row.state === 'new')
          const due = dueWaiting.slice(0, dueAllowed)
          const fresh = newWaiting.slice(0, newAllowed)
          // A 200-Card prefetch can hold fewer due Cards than the limit
          // allows; only a limit cut counts as capped, never a short fetch.
          const dueCapped = dueWaiting.length > due.length || totalDue > due.length
          const newCapped =
            !input.bypassDueLimit && (newWaiting.length > fresh.length || totalNew > fresh.length)
          const cards = yield* Effect.forEach([...due, ...fresh], toReviewCard, { concurrency: 1 })
          return {
            cards,
            dayStartUtc: boundary,
            lapseMinutes,
            reviewedToday,
            newToday: introducedToday,
            totalNew,
            totalDue,
            newCapped,
            dueCapped,
          } satisfies ReviewQueue
        }).pipe(Effect.withSpan('Reviews.queue'), (self) =>
          withStorageErrorPassThrough(self, 'load the review queue'),
        )

      const grade = (
        submission: ReviewSubmission,
      ): Effect.Effect<ReviewAccepted, CardNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const card = yield* readCard(submission.cardId)
          if (card === undefined) return yield* new CardNotFound({ cardId: submission.cardId })

          const replayRows =
            yield* sql`SELECT COUNT(*) AS n FROM reviews WHERE id = ${submission.id}`
          const replay = yield* decodeRows(CountRow, replayRows)
          if ((replay[0]?.n ?? 0) > 0) {
            // The grade already landed; report the Card as it stands.
            return {
              cardId: submission.cardId,
              grade: submission.grade,
              state: card.state,
              dueInDays: card.dueInDays,
              stability: card.stability,
              difficulty: card.difficulty,
              intervalDays: card.dueInDays,
              dueAt: card.dueAt ?? new Date().toISOString(),
              requeueInSession: false,
            } satisfies ReviewAccepted
          }

          const fsrs = yield* readFsrs
          const now = new Date()
          const timezone = resolveTimezone(submission.timezone)
          const deckLimitsRows = yield* sql`SELECT new_per_day AS "newPerDay",
            reviews_per_day AS "reviewsPerDay", lapse_minutes AS "lapseMinutes"
            FROM decks WHERE id = ${card.deckId}`
          const deckLimitsDecoded = yield* decodeRows(DeckLimitsRow, deckLimitsRows)
          const deckOverride = deckLimitsDecoded[0]
          // The graded Card's own Deck sets its lapse: a deck page's override
          // follows the Card there, without a new wire field.
          const lapseMinutes = deckOverride?.lapseMinutes ?? fsrs.lapseMinutes
          const boundary = dayStartUtc(timezone, fsrs.dayRolloverHour, now)
          const todayKey = reviewDayKey(timezone, fsrs.dayRolloverHour, now)
          const scheduled = scheduleReview(
            {
              stability: card.stability,
              difficulty: card.difficulty,
              state: card.state,
              reps: card.reps,
              lapses: card.lapses,
              lastReviewedAt: card.lastReviewedAt,
            },
            submission.grade,
            {
              weights: fsrs.weights.split(',').map(Number),
              desiredRetention: fsrs.desiredRetention,
              maximumInterval: fsrs.maximumInterval,
            },
            now,
          )
          const interval = scheduled.intervalDays
          const requeueInSession = submission.grade === 'Again'
          // `Again` re-queues later this session, after `lapseMinutes`: the
          // Card buries until then so the queue skips it until it is due.
          // Passing grades bury until the next boundary at the earliest — a
          // sub-day FSRS interval still waits for tomorrow.
          const requeueAt = new Date(now.getTime() + lapseMinutes * 60_000).toISOString()
          const dueAt = requeueInSession
            ? requeueAt
            : dueInstantUtc(boundary, Math.max(1, interval), now, lapseMinutes)
          const buriedUntil = requeueInSession ? requeueAt : null

          // The Review row, its before-grade snapshot, and the Card's new state
          // land together; the deck's last-studied stamp rides along. D1 runs
          // the batch atomically. Siblings — other Cards from the same Note —
          // bury until the next day, so one Note never shows two Cards in a
          // session.
          const nextDay = dueInstantUtc(boundary, 1, now, lapseMinutes)
          const statements = [
            sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
              VALUES (${submission.id}, ${submission.cardId}, ${submission.grade},
              strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
            sql`INSERT INTO review_snapshots (review_id, card_id, state, stability, difficulty,
              due_in_days, due_at, reps, lapses, introduced_day, last_reviewed_at, buried_until)
              VALUES (${submission.id}, ${submission.cardId}, ${card.state}, ${card.stability},
              ${card.difficulty}, ${card.dueInDays}, ${card.dueAt}, ${card.reps}, ${card.lapses},
              ${card.introducedDay}, ${card.lastReviewedAt}, ${card.buriedUntil})`,
            sql`UPDATE cards SET state = ${scheduled.state}, stability = ${scheduled.stability},
              difficulty = ${scheduled.difficulty}, due_in_days = ${requeueInSession ? 0 : interval},
              due_at = ${dueAt},
              buried_until = ${buriedUntil}, buried_sibling_of = NULL,
              introduced_day = CASE WHEN state = 'new' THEN ${todayKey} ELSE introduced_day END,
              reps = ${scheduled.reps}, lapses = ${scheduled.lapses},
              last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ${submission.cardId}`,
            ...(card.noteId === null
              ? []
              : [
                  sql`UPDATE cards SET buried_until = ${nextDay},
                    buried_sibling_of = ${submission.cardId},
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                    WHERE note_id = ${card.noteId} AND id != ${submission.cardId}
                    AND (buried_until IS NULL OR buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
                ]),
            sql`UPDATE decks SET last_studied_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ${card.deckId}`,
          ]
          yield* runStatements(statements)

          return {
            cardId: submission.cardId,
            grade: submission.grade,
            state: scheduled.state,
            dueInDays: interval,
            stability: scheduled.stability,
            difficulty: scheduled.difficulty,
            intervalDays: interval,
            dueAt,
            requeueInSession,
          } satisfies ReviewAccepted
        }).pipe(Effect.withSpan('Reviews.grade'), (self) =>
          withStorageErrorPassThrough(self, 'save the review'),
        )

      /**
       * Undoes the latest grade on `cardId`.
       *
       * The Review log row is deleted and the Card's scheduling state restored
       * from the snapshot the grade wrote; siblings this grade buried are
       * unburied. Only the latest Review on the Card is undoable, and only
       * when it still has its snapshot — grades from before the snapshot
       * migration cannot be undone.
       */
      const undo = (input: {
        cardId: CardId
      }): Effect.Effect<UndoAccepted, CardNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const card = yield* readCard(input.cardId)
          if (card === undefined) return yield* new CardNotFound({ cardId: input.cardId })

          const lastRows = yield* sql`SELECT id, card_id AS "cardId", grade FROM reviews
            WHERE card_id = ${input.cardId} ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`
          const last = yield* decodeRows(LastReviewRow, lastRows)
          const latest = last[0]
          if (latest === undefined) return yield* new CardNotFound({ cardId: input.cardId })

          const snapshotRows = yield* sql`SELECT state, stability, difficulty,
            due_in_days AS "dueInDays", due_at AS "dueAt", reps, lapses,
            introduced_day AS "introducedDay", last_reviewed_at AS "lastReviewedAt",
            buried_until AS "buriedUntil" FROM review_snapshots WHERE review_id = ${latest.id}`
          const snapshots = yield* decodeRows(
            Schema.Struct({
              state: CardStateRow,
              stability: Schema.Number,
              difficulty: Schema.Number,
              dueInDays: Schema.Number,
              dueAt: Schema.NullOr(Schema.String),
              reps: Schema.Number,
              lapses: Schema.Number,
              introducedDay: Schema.NullOr(Schema.String),
              lastReviewedAt: Schema.NullOr(Schema.String),
              buriedUntil: Schema.NullOr(Schema.String),
            }),
            snapshotRows,
          )
          const snapshot = snapshots[0]
          if (snapshot === undefined) return yield* new CardNotFound({ cardId: input.cardId })

          yield* runStatements([
            sql`DELETE FROM reviews WHERE id = ${latest.id}`,
            sql`DELETE FROM review_snapshots WHERE review_id = ${latest.id}`,
            sql`UPDATE cards SET state = ${snapshot.state}, stability = ${snapshot.stability},
              difficulty = ${snapshot.difficulty}, due_in_days = ${snapshot.dueInDays},
              due_at = ${snapshot.dueAt},
              buried_until = ${snapshot.buriedUntil}, buried_sibling_of = NULL,
              introduced_day = ${snapshot.introducedDay},
              reps = ${snapshot.reps}, lapses = ${snapshot.lapses},
              last_reviewed_at = ${snapshot.lastReviewedAt},
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ${input.cardId}`,
            sql`UPDATE cards SET buried_until = NULL, buried_sibling_of = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE buried_sibling_of = ${input.cardId}`,
          ])

          return {
            cardId: input.cardId,
            state: snapshot.state,
            dueInDays: snapshot.dueInDays,
            stability: snapshot.stability,
            difficulty: snapshot.difficulty,
          } satisfies UndoAccepted
        }).pipe(Effect.withSpan('Reviews.undo'), (self) =>
          withStorageErrorPassThrough(self, 'undo the review'),
        )

      /**
       * The whole collection as plain rows: Decks, Notes, Cards with scheduling
       * state, and the Review log. The browser downloads it as one JSON file.
       * Media files stay in R2; the export names what it cannot carry.
       */
      const exportCollection = (): Effect.Effect<CollectionExport, StorageUnavailable> =>
        Effect.gen(function* () {
          const deckRows = yield* sql`SELECT id, name, description FROM decks ORDER BY name`
          const decks = yield* decodeRows(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              description: Schema.String,
            }),
            deckRows,
          )
          const noteRows = yield* sql`SELECT id, note_type_id AS "noteTypeId", guid,
            fields, tags, modified FROM notes ORDER BY rowid`
          const rawNotes = yield* decodeRows(
            Schema.Struct({
              id: Schema.String,
              noteTypeId: Schema.String,
              guid: Schema.String,
              fields: Schema.String,
              tags: Schema.String,
              modified: Schema.Number,
            }),
            noteRows,
          )
          const cardRows = yield* sql`SELECT id, deck_id AS "deckId", note_id AS "noteId",
              template_ord AS "templateOrd", suspended, state, stability, difficulty,
              due_at AS "dueAt", COALESCE(reps, 0) AS reps, COALESCE(lapses, 0) AS lapses,
              last_reviewed_at AS "lastReviewedAt" FROM cards ORDER BY rowid`
          const rawCards = yield* decodeRows(
            Schema.Struct({
              id: Schema.String,
              deckId: Schema.String,
              noteId: Schema.NullOr(Schema.String),
              templateOrd: Schema.Number,
              suspended: Schema.Number,
              state: CardStateRow,
              stability: Schema.Number,
              difficulty: Schema.Number,
              dueAt: Schema.NullOr(Schema.String),
              reps: Schema.Number,
              lapses: Schema.Number,
              lastReviewedAt: Schema.NullOr(Schema.String),
            }),
            cardRows,
          )
          const reviewRows =
            yield* sql`SELECT id, card_id AS "cardId", grade, reviewed_at AS "reviewedAt"
              FROM reviews ORDER BY reviewed_at ASC`
          const reviews = yield* decodeRows(
            Schema.Struct({
              id: Schema.String,
              cardId: Schema.String,
              grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
              reviewedAt: Schema.String,
            }),
            reviewRows,
          )

          const notes: Array<ExportNote> = []
          for (const note of rawNotes) {
            const fields = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.String)),
            )(note.fields).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))
            const tags = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.String)),
            )(note.tags).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))
            notes.push({
              id: note.id,
              noteTypeId: note.noteTypeId,
              guid: note.guid,
              fields: [...fields],
              tags: [...tags],
              modified: note.modified,
            })
          }
          const cards: Array<ExportCard> = rawCards.map((card) => ({
            id: card.id,
            deckId: card.deckId,
            noteId: card.noteId,
            templateOrd: card.templateOrd,
            suspended: card.suspended === 1,
            state: card.state,
            stability: card.stability,
            difficulty: card.difficulty,
            dueAt: card.dueAt,
            reps: card.reps,
            lapses: card.lapses,
            lastReviewedAt: card.lastReviewedAt,
          }))
          const decksOut: Array<ExportDeck> = decks.map((deck) => ({ ...deck }))
          const reviewsOut: Array<ExportReview> = reviews.map((review) => ({ ...review }))
          return {
            exportedAt: new Date().toISOString(),
            decks: decksOut,
            notes,
            cards,
            reviews: reviewsOut,
          } satisfies CollectionExport
        }).pipe(Effect.withSpan('Reviews.export'), (self) =>
          withStorageErrorPassThrough(self, 'export the collection'),
        )

      return Reviews.of({ queue, grade, undo, exportCollection })
    }),
  )
}

export const ReviewsHandlers = ReviewsRpc.toLayer(
  Effect.gen(function* () {
    const reviews = yield* Reviews
    return ReviewsRpc.of({
      reviewsQueue: ({ deckId, timezone, bypassDueLimit }) =>
        reviews.queue({ deckId: Option.fromUndefinedOr(deckId), timezone, bypassDueLimit }),
      reviewsGrade: (payload) => reviews.grade(payload),
      reviewsUndo: ({ cardId }) => reviews.undo({ cardId }),
      reviewsExport: () => reviews.exportCollection(),
    })
  }),
)
