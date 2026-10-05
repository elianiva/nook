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
 * SQL and row-decode failures surface as `StorageUnavailable` (a 503 the
 * frontend can retry). A Card id no Card answers to is a 404 `CardNotFound`.
 */

import { Context, Effect, Layer, Option, Schema } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import * as Sql from 'effect/sql/SqlClient'
import { renderCard, scopeCss } from '@nook/anki/render'
import { Api, CardId, CardNotFound, DeckId, StorageUnavailable } from '@nook/api'
import type { ReviewAccepted, ReviewCard, ReviewQueue, ReviewSubmission } from '@nook/api'
import { runStatements } from './batch'
import { scheduleReview } from './fsrs'
import { decodeRows, withStorageErrorPassThrough } from './storage-error'
import type { StorageError } from './storage-error'

/** The element the scoped Note Type stylesheet is confined to. The screen uses the same id. */
const CARD_SCOPE = '#nook-card'

/** Where the browser loads a Media file from. */
const mediaUrl = (name: string): string => `/api/media/${encodeURIComponent(name)}`

const CardStateRow = Schema.Literals(['new', 'learning', 'review', 'relearning'])

/** One Field or Template as the Note Type's JSON column stores it. */
const StoredField = Schema.Struct({ ord: Schema.Number, name: Schema.String })
const StoredTemplate = Schema.Struct({
  ord: Schema.Number,
  name: Schema.String,
  questionFormat: Schema.String,
  answerFormat: Schema.String,
})

/** One row of the queue join. */
const QueueRow = Schema.Struct({
  cardId: Schema.String,
  deckId: Schema.String,
  noteId: Schema.String,
  templateOrd: Schema.Number,
  state: CardStateRow,
  stability: Schema.Number,
  difficulty: Schema.Number,
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
  lastReviewedAt: Schema.NullOr(Schema.String),
})

/** The FSRS knobs, read straight from the singleton settings row. */
const FsrsRow = Schema.Struct({
  weights: Schema.String,
  desiredRetention: Schema.Number,
  maximumInterval: Schema.Number,
  newPerDay: Schema.Number,
  reviewsPerDay: Schema.Number,
})

const CountRow = Schema.Struct({ n: Schema.Number })

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
    queue(deckId: Option.Option<DeckId>): Effect.Effect<ReviewQueue, StorageUnavailable>
    grade(
      submission: ReviewSubmission,
    ): Effect.Effect<ReviewAccepted, CardNotFound | StorageUnavailable>
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
          fsrs_reviews_per_day AS "reviewsPerDay"
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
            last_reviewed_at AS "lastReviewedAt"
            FROM cards WHERE id = ${cardId}`
          const decoded = yield* decodeRows(CardRow, rows)
          return decoded[0]
        })

      /**
       * Due Cards first, then new ones, capped by the day's limits.
       *
       * The two limits differ, so the query returns `reviewsPerDay + newPerDay`
       * rows ordered due-first and the split happens here. `dueInDays` for a
       * Card with no due instant (a new Card) is 0.
       */
      const queue = (
        deckId: Option.Option<DeckId>,
      ): Effect.Effect<ReviewQueue, StorageUnavailable> =>
        Effect.gen(function* () {
          const fsrs = yield* readFsrs
          const deck = Option.getOrNull(deckId)
          const rows = yield* sql`SELECT c.id AS "cardId", c.deck_id AS "deckId",
            c.note_id AS "noteId", c.template_ord AS "templateOrd",
            c.state AS state, c.stability AS stability, c.difficulty AS difficulty,
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
              AND (c.state = 'new' OR (c.due_at IS NOT NULL AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
              AND (${deck} IS NULL OR c.deck_id = ${deck})
            ORDER BY CASE WHEN c.state = 'new' THEN 1 ELSE 0 END, c.due_at
            LIMIT ${fsrs.reviewsPerDay + fsrs.newPerDay}`
          const decoded = yield* decodeRows(QueueRow, rows)
          const due = decoded.filter((row) => row.state !== 'new').slice(0, fsrs.reviewsPerDay)
          const fresh = decoded.filter((row) => row.state === 'new').slice(0, fsrs.newPerDay)
          const cards = yield* Effect.forEach([...due, ...fresh], toReviewCard, { concurrency: 1 })
          return { cards } satisfies ReviewQueue
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
            } satisfies ReviewAccepted
          }

          const fsrs = yield* readFsrs
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
            new Date(),
          )
          const interval = scheduled.intervalDays

          // The Review row and the Card's new state land together; the deck's
          // last-studied stamp rides along. D1 runs the batch atomically.
          yield* runStatements([
            sql`INSERT INTO reviews (id, card_id, grade, reviewed_at)
              VALUES (${submission.id}, ${submission.cardId}, ${submission.grade},
              strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
            sql`UPDATE cards SET state = ${scheduled.state}, stability = ${scheduled.stability},
              difficulty = ${scheduled.difficulty}, due_in_days = ${interval},
              due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ${`+${interval} days`}),
              reps = ${scheduled.reps}, lapses = ${scheduled.lapses},
              last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ${submission.cardId}`,
            sql`UPDATE decks SET last_studied_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ${card.deckId}`,
          ])

          return {
            cardId: submission.cardId,
            grade: submission.grade,
            state: scheduled.state,
            dueInDays: interval,
            stability: scheduled.stability,
            difficulty: scheduled.difficulty,
            intervalDays: interval,
          } satisfies ReviewAccepted
        }).pipe(Effect.withSpan('Reviews.grade'), (self) =>
          withStorageErrorPassThrough(self, 'save the review'),
        )

      return Reviews.of({ queue, grade })
    }),
  )
}

export const ReviewsHandlers = HttpApiBuilder.group(Api, 'reviews', (handlers) =>
  Effect.gen(function* () {
    const reviews = yield* Reviews
    return handlers.handleAll({
      queue: ({ query }) => reviews.queue(Option.fromUndefinedOr(query.deckId)),
      grade: ({ payload }) => reviews.grade(payload),
    })
  }),
)
