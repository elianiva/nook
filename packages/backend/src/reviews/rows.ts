/**
 * Constants and row schemas shared by the review operations, plus the queue-row-to-Card renderer.
 */

import { Effect, Option, Schema } from 'effect'
import { renderCard, scopeCss } from '@nook/anki/render'
import { CardId, DeckId, LEECH_LAPSE_THRESHOLD, LEECH_LAPSE_WARNING_INTERVAL } from '@nook/api'
import type { ReviewCard } from '@nook/api'
import { StoredField, StoredTemplate } from '../note-type-rows'

/** The element the scoped Note Type stylesheet is confined to. The screen uses the same id. */
export const CARD_SCOPE = '#nook-card'

/** How many rendered Cards one queue carries. ADR 0001 sizes the device's prefetch at this. */
export const QUEUE_LIMIT = 200

/** How many grade events a Card history request returns, newest first. */
export const HISTORY_LIMIT = 100

/** Where the browser loads a Media file from. Scoped by Import: archive file names repeat across Decks. */
export const mediaUrl = (importId: string, name: string): string =>
  `/api/media/${importId}/${encodeURIComponent(name)}`

export const CardStateRow = Schema.Literals(['new', 'learning', 'review', 'relearning'])

/** One row of the queue join. */
export const QueueRow = Schema.Struct({
  cardId: Schema.String,
  deckId: Schema.String,
  noteId: Schema.String,
  importId: Schema.String,
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
export const CardRow = Schema.Struct({
  cardId: Schema.String,
  deckId: Schema.String,
  state: CardStateRow,
  stability: Schema.Number,
  difficulty: Schema.Number,
  reps: Schema.Number,
  lapses: Schema.Number,
  reviewLapses: Schema.Number,
  suspended: Schema.Number,
  dueInDays: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  noteId: Schema.NullOr(Schema.String),
  introducedDay: Schema.NullOr(Schema.String),
  buriedUntil: Schema.NullOr(Schema.String),
  lastReviewedAt: Schema.NullOr(Schema.String),
})

/** The FSRS knobs, read straight from the singleton settings row. */
export const FsrsRow = Schema.Struct({
  weights: Schema.String,
  desiredRetention: Schema.Number,
  maximumInterval: Schema.Number,
  newPerDay: Schema.Number,
  reviewsPerDay: Schema.Number,
  lapseMinutes: Schema.Number,
  dayRolloverHour: Schema.Number,
})

/** One Deck's limit overrides, as the `decks` table stores them. */
export const DeckLimitsRow = Schema.Struct({
  newPerDay: Schema.NullOr(Schema.Number),
  reviewsPerDay: Schema.NullOr(Schema.Number),
  lapseMinutes: Schema.NullOr(Schema.Number),
})

/** One row of the last grade, for undo. */
export const LastReviewRow = Schema.Struct({
  id: Schema.String,
  cardId: Schema.String,
  grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
  leechSuspended: Schema.Number,
})

/** Anki's default leech point plus recurring half-threshold warnings. */
export const isLeechWarning = (reviewLapses: number): boolean =>
  reviewLapses >= LEECH_LAPSE_THRESHOLD &&
  (reviewLapses - LEECH_LAPSE_THRESHOLD) % LEECH_LAPSE_WARNING_INTERVAL === 0

/** Renders one queue row into a Card the browser can show. */
export const toReviewCard = (
  row: typeof QueueRow.Type,
): Effect.Effect<ReviewCard, Schema.SchemaError> =>
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
      mediaUrl: (name) => mediaUrl(row.importId, name),
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
