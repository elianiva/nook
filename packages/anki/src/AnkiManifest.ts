import { Schema, SchemaTransformation } from 'effect'
import { AnkiMediaEntry } from './AnkiContent'
import { deckComponents, joinComponents } from './DeckName'

/**
 * One Field of a Note Type.
 *
 * `ord` is the Field's position, and it is what a Note's `fields` list is
 * indexed by, so it is kept as a number rather than resolved to a name.
 */
export const AnkiField = Schema.Struct({
  ord: Schema.Number,
  name: Schema.String,
  rightToLeft: Schema.Boolean,
  fontName: Schema.NullOr(Schema.String),
  fontSize: Schema.NullOr(Schema.Number),
  plainText: Schema.Boolean,
  description: Schema.String,
  sticky: Schema.Boolean,
})

export type AnkiField = typeof AnkiField.Type

/**
 * One Template of a Note Type. Each Template produces one Card from a Note, so a
 * Note Type with two Templates gives every Note two Cards.
 */
export const AnkiTemplate = Schema.Struct({
  ord: Schema.Number,
  name: Schema.String,
  /** Anki's `q_format`: the Card's prompt side, before Field substitution. */
  questionFormat: Schema.String,
  /** Anki's `a_format`: the Card's answer side, before Field substitution. */
  answerFormat: Schema.String,
  /** The Deck this Template sends its Cards to, or 0 to mean the Note's own Deck. */
  deckId: Schema.Number,
})

export type AnkiTemplate = typeof AnkiTemplate.Type

/**
 * A Note Type: the rules that turn a Note into Cards.
 *
 * The stylesheet is the Note Type's own, and nook renders Cards with it. Anki
 * applies a shared stylesheet on top, which is not in the archive.
 */
export const AnkiNoteType = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  kind: Schema.Literals(['normal', 'cloze']),
  /** Which Field Anki sorts and searches by, as an index into `fields`. */
  sortFieldOrd: Schema.Number,
  css: Schema.String,
  fields: Schema.Array(AnkiField),
  templates: Schema.Array(AnkiTemplate),
})

export type AnkiNoteType = typeof AnkiNoteType.Type

/**
 * A Deck, as the path of names from the root.
 *
 * `name` is Anki's native name, which joins the components with a unit
 * separator. Anki shows the components joined with `::` instead, which is lossy
 * because a component may contain a colon, so nook keeps the components.
 */
export const AnkiDeck = Schema.Struct({
  id: Schema.Number,
  components: Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      // `SchemaTransformation.transform`, not a bare `{ decode, encode }`: the
      // interpreter reads a `_tag` off the functions it is given.
      SchemaTransformation.transform({ decode: deckComponents, encode: joinComponents }),
    ),
  ),
  description: Schema.String,
}).pipe(Schema.encodeKeys({ components: 'name' }))

export type AnkiDeck = typeof AnkiDeck.Type

/**
 * What an archive holds, read without reading it.
 *
 * The counts let a Learner see the size of an Import before committing to it,
 * which is why nothing here needs a Note or a Card.
 */
export const AnkiManifest = Schema.Struct({
  /** Anki's `col.ver`: the schema of the database inside the archive. */
  schemaVersion: Schema.Number,
  noteTypes: Schema.Array(AnkiNoteType),
  decks: Schema.Array(AnkiDeck),
  media: Schema.Array(AnkiMediaEntry),
  noteCount: Schema.Number,
  cardCount: Schema.Number,
  mediaCount: Schema.Number,
  mediaBytes: Schema.Number,
})

export type AnkiManifest = typeof AnkiManifest.Type
