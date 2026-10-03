import { Schema } from 'effect'

/**
 * Something the reader found that it worked around.
 *
 * A diagnostic never stops an Import. An `.apkg` archive is written by a
 * program nook does not control, and a Learner is better served by a Deck with
 * one broken Note in it than by an Import that stops at the first surprise. The
 * handle collects these so a caller can decide what to tell the Learner.
 */
export const AnkiDiagnostic = Schema.TaggedUnion({
  /** A Note referenced a Media file the archive does not carry. */
  AnkiMissingMedia: { name: Schema.String, noteId: Schema.Number },
  /** A Media file's bytes do not hash to the SHA-1 the archive declares. */
  AnkiMediaChecksumMismatch: { name: Schema.String },
  /** A Card pointed at a Deck that is not in the archive. */
  AnkiUnknownDeck: { cardId: Schema.Number, deckId: Schema.Number },
  /** A Note pointed at a Note Type that is not in the archive. */
  AnkiUnknownNoteType: { noteId: Schema.Number, noteTypeId: Schema.Number },
  /** A Note had a different number of Fields than its Note Type declares. */
  AnkiNoteFieldCountMismatch: {
    noteId: Schema.Number,
    expected: Schema.Number,
    actual: Schema.Number,
  },
})

export type AnkiDiagnostic = typeof AnkiDiagnostic.Type
