import { Schema, SchemaTransformation } from 'effect'
import { joinFields, joinTags, splitFields, splitTags } from './Text'

/** Anki's `cards.queue` for a Card the Learner suspended. */
const CARD_QUEUE_SUSPENDED = -1

/** Anki's `cards.queue` for a Card in the new queue, which is where nook puts every imported Card. */
const CARD_QUEUE_NEW = 0

/**
 * `cards.flags` holds a star colour, not a bit set, so only the low three bits
 * are the flag. Anki reserves everything above it.
 */
const CARD_FLAG_MASK = 0b111

/**
 * A codec, built through `SchemaTransformation` rather than from a bare
 * `{ decode, encode }` object.
 *
 * `Schema.decodeTo` accepts a plain object in its types, but it hands that
 * object straight to the interpreter, which then reads a `_tag` off the
 * functions and finds nothing. Wrapping is what makes it work.
 */
const codec = <A, B>(decode: (from: A) => B, encode: (to: B) => A) =>
  SchemaTransformation.transform({ decode, encode })

/**
 * One row of Anki's `notes` table, read into nook's terms.
 *
 * Anki joins a Note's Fields into one column with a unit separator and its Tags
 * into one column with spaces, so both splits are codecs here rather than code
 * at the call site. The column names are Anki's; the field names are nook's.
 */
export const AnkiNote = Schema.Struct({
  /** Anki's note id, which is the millisecond timestamp of the Note's creation. */
  id: Schema.Number,
  guid: Schema.String,
  noteTypeId: Schema.Number,
  /** Unix seconds, as Anki stores it. */
  modified: Schema.Number,
  fields: Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), codec(splitFields, joinFields)),
  ),
  tags: Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), codec(splitTags, joinTags)),
  ),
}).pipe(Schema.encodeKeys({ noteTypeId: 'mid', modified: 'mod', fields: 'flds' }))

export type AnkiNote = typeof AnkiNote.Type

const AnkiCardRow = Schema.Struct({
  id: Schema.Number,
  nid: Schema.Number,
  did: Schema.Number,
  odid: Schema.Number,
  ord: Schema.Number,
  queue: Schema.Number,
  flags: Schema.Number,
})

/**
 * One row of Anki's `cards` table, read into nook's terms.
 *
 * A Card carries no scheduling here. nook starts every imported Card as new, so
 * `due`, `ivl`, `factor`, `reps`, `lapses`, `left`, `type`, and `odue` are never
 * read at all. What survives is the Learner's own intent: which Deck the Card is
 * in, and whether they suspended it or starred it.
 *
 * The whole row needs one transform, because a filtered Deck has to be resolved
 * away: a Card one moved carries the Deck it came from in `odid`, and nook has no
 * filtered Decks, so the Card goes home.
 */
export const AnkiCard = AnkiCardRow.pipe(
  Schema.decodeTo(
    Schema.Struct({
      id: Schema.Number,
      noteId: Schema.Number,
      deckId: Schema.Number,
      templateOrd: Schema.Number,
      suspended: Schema.Boolean,
      flag: Schema.Number,
    }),
    codec(
      (row) => ({
        id: row.id,
        noteId: row.nid,
        deckId: row.odid !== 0 ? row.odid : row.did,
        templateOrd: row.ord,
        suspended: row.queue === CARD_QUEUE_SUSPENDED,
        flag: row.flags & CARD_FLAG_MASK,
      }),
      // nook never writes a Card back, but the codec needs both directions, and
      // this one describes the Card nook would have written: no origin Deck, and
      // a queue that matches whether the Card is suspended.
      (card) => ({
        id: card.id,
        nid: card.noteId,
        did: card.deckId,
        odid: 0,
        ord: card.templateOrd,
        queue: card.suspended ? CARD_QUEUE_SUSPENDED : CARD_QUEUE_NEW,
        flags: card.flag,
      }),
    ),
  ),
)

export type AnkiCard = typeof AnkiCard.Type

/**
 * One Media file the archive carries, and where its bytes live. `entry` is the
 * zip entry name, which for a modern archive is the Media file's index as a
 * decimal string.
 */
export const AnkiMediaEntry = Schema.Struct({
  name: Schema.String,
  entry: Schema.String,
  /** The size Anki declares, in bytes. */
  bytes: Schema.Number,
  /** The SHA-1 Anki declares, as lowercase hex. */
  checksum: Schema.String,
})

export type AnkiMediaEntry = typeof AnkiMediaEntry.Type

/** One Media file, with its bytes. */
export const AnkiMedia = Schema.Struct({
  name: Schema.String,
  bytes: Schema.Uint8Array,
  /** The SHA-1 Anki declares, as lowercase hex. nook compares it against the bytes. */
  checksum: Schema.String,
})

export type AnkiMedia = typeof AnkiMedia.Type
