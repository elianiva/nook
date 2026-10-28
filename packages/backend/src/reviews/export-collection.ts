/**
 * The whole collection as plain rows.
 */

import { Effect, Option, Schema } from 'effect'
import { CollectionExport, EXPORT_VERSION, StorageUnavailable } from '@nook/api'
import type { ExportCard, ExportDeck, ExportNote, ExportNoteType, ExportReview } from '@nook/api'
import { decodeRows, withStorageErrorPassThrough } from '../storage-error'
import type { ReviewsDeps } from './reads'
import { CardStateRow } from './rows'

export const makeExportCollection = ({ sql, userId }: ReviewsDeps) => {
  /**
   * The whole collection as plain rows: Decks, Notes, Cards with scheduling
   * state, and the Review log. The browser downloads it as one JSON file.
   * Media files stay in R2; the export names what it cannot carry.
   */
  const exportCollection = (): Effect.Effect<CollectionExport, StorageUnavailable> =>
    Effect.gen(function* () {
      const deckRows = yield* sql`SELECT id, name, description, new_per_day AS "newPerDay",
            reviews_per_day AS "reviewsPerDay", lapse_minutes AS "lapseMinutes"
            FROM decks WHERE user_id = ${userId} ORDER BY name`
      const decks = yield* decodeRows(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          description: Schema.String,
          newPerDay: Schema.NullOr(Schema.Number),
          reviewsPerDay: Schema.NullOr(Schema.Number),
          lapseMinutes: Schema.NullOr(Schema.Number),
        }),
        deckRows,
      )
      const noteTypeRows = yield* sql`SELECT id, name, kind, sort_field_ord AS "sortFieldOrd",
            css, fields, templates FROM note_types WHERE user_id = ${userId} ORDER BY rowid`
      const rawNoteTypes = yield* decodeRows(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          kind: Schema.Literals(['normal', 'cloze']),
          sortFieldOrd: Schema.Number,
          css: Schema.String,
          fields: Schema.String,
          templates: Schema.String,
        }),
        noteTypeRows,
      )
      const noteRows = yield* sql`SELECT id, note_type_id AS "noteTypeId", guid,
            fields, tags, modified FROM notes WHERE user_id = ${userId} ORDER BY rowid`
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
              due_at AS "dueAt", due_in_days AS "dueInDays", introduced_day AS "introducedDay",
              COALESCE(reps, 0) AS reps, COALESCE(lapses, 0) AS lapses,
              last_reviewed_at AS "lastReviewedAt", COALESCE(review_lapses, 0) AS "reviewLapses"
              FROM cards WHERE user_id = ${userId} ORDER BY rowid`
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
          dueInDays: Schema.Number,
          introducedDay: Schema.NullOr(Schema.String),
          reps: Schema.Number,
          lapses: Schema.Number,
          reviewLapses: Schema.Number,
          lastReviewedAt: Schema.NullOr(Schema.String),
        }),
        cardRows,
      )
      const reviewRows =
        yield* sql`SELECT id, card_id AS "cardId", grade, reviewed_at AS "reviewedAt",
              state_after AS "stateAfter", stability_after AS "stabilityAfter",
              difficulty_after AS "difficultyAfter", due_in_days_after AS "dueInDaysAfter",
              due_at_after AS "dueAtAfter", leech_suspended AS "leechSuspended"
              FROM reviews WHERE user_id = ${userId} ORDER BY reviewed_at ASC, rowid ASC`
      const reviews = yield* decodeRows(
        Schema.Struct({
          id: Schema.String,
          cardId: Schema.String,
          grade: Schema.Literals(['Again', 'Hard', 'Good', 'Easy']),
          reviewedAt: Schema.String,
          stateAfter: Schema.NullOr(CardStateRow),
          stabilityAfter: Schema.NullOr(Schema.Number),
          difficultyAfter: Schema.NullOr(Schema.Number),
          dueInDaysAfter: Schema.NullOr(Schema.Number),
          dueAtAfter: Schema.NullOr(Schema.String),
          leechSuspended: Schema.Number,
        }),
        reviewRows,
      )

      const parseArray = (text: string): ReadonlyArray<unknown> =>
        Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(text).pipe(
          Option.getOrElse((): ReadonlyArray<unknown> => []),
        )
      const noteTypes: Array<ExportNoteType> = rawNoteTypes.map((noteType) => ({
        id: noteType.id,
        name: noteType.name,
        kind: noteType.kind,
        sortFieldOrd: noteType.sortFieldOrd,
        css: noteType.css,
        fields: [...parseArray(noteType.fields)],
        templates: [...parseArray(noteType.templates)],
      }))
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
        dueInDays: card.dueInDays,
        introducedDay: card.introducedDay,
        reps: card.reps,
        lapses: card.lapses,
        reviewLapses: card.reviewLapses,
        lastReviewedAt: card.lastReviewedAt,
      }))
      const decksOut: Array<ExportDeck> = decks.map((deck) => ({ ...deck }))
      const reviewsOut: Array<ExportReview> = reviews.map((review) => ({
        ...review,
        leechSuspended: review.leechSuspended === 1,
      }))
      return {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        decks: decksOut,
        noteTypes,
        notes,
        cards,
        reviews: reviewsOut,
      } satisfies CollectionExport
    }).pipe(Effect.withSpan('Reviews.export'), (self) =>
      withStorageErrorPassThrough(self, 'export the collection'),
    )

  return exportCollection
}
