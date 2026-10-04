import { Effect } from 'effect'
import { AnkiCorruptArchive } from './AnkiErrors'
import { ProtobufReader } from './Protobuf'

/**
 * The four protobuf messages Anki keeps in the collection's `config` and `kind`
 * columns.
 *
 * From schema 15 on, a Note Type, its Fields, and its Templates live in the
 * `notetypes`, `fields`, and `templates` tables, and each row's settings are a
 * protobuf blob beside the columns Anki searches on. The JSON in the old `col`
 * table is dead from schema 14 on, so these blobs are the only source.
 *
 * Only the fields nook needs are read. The browser formats, the deck options, the
 * LaTeX settings, and the cloze deletion requirements are all skipped, which
 * costs nothing: a decoder that steps over an unknown field stays correct when
 * Anki adds one.
 *
 * Every decoder fails with a corrupt-archive error carrying a fix, never a
 * thrown decode error: a truncated blob means the collection is damaged, not
 * that the code ran somewhere it cannot.
 */

/** A config blob that is not the message it claims to be: truncated bytes, not a crash. */
const corruptConfig = (what: string): AnkiCorruptArchive =>
  new AnkiCorruptArchive({
    reason: 'integrity',
    message: `This Anki export is damaged: its ${what} does not parse. Export it again from Anki.`,
  })

/**
 * `Notetype.Config`, in `notetypes.config`.
 *
 * ```proto
 * Notetype.Config {
 *   Notetype.Config.Kind kind = 1;      // 0 normal, 1 cloze
 *   uint32 sort_field_idx = 2;          // 0 is the first Field
 *   string css = 3;
 *   int64 target_deck_id_unused = 4;
 *   string latex_pre = 5;
 *   string latex_post = 6;
 *   bool latex_svg = 7;
 * }
 * ```
 */
export const decodeNotetypeConfig = (
  bytes: Uint8Array,
): Effect.Effect<{ kind: number; sortFieldIdx: number; css: string }, AnkiCorruptArchive> =>
  Effect.try({
    try: () => {
      let kind = 0
      let sortFieldIdx = 0
      let css = ''
      const reader = new ProtobufReader(bytes)
      for (let tag = reader.next(); tag !== null; tag = reader.next()) {
        if (tag.number === 1 && tag.wireType === 'varint') {
          kind = reader.varint()
        } else if (tag.number === 2 && tag.wireType === 'varint') {
          sortFieldIdx = reader.varint()
        } else if (tag.number === 3 && tag.wireType === 'lengthDelimited') {
          css = reader.string()
        } else {
          reader.skip(tag)
        }
      }
      return { kind, sortFieldIdx, css }
    },
    catch: () => corruptConfig('note type configuration'),
  })

/** `Notetype.Config.Kind`: the value that marks a cloze Note Type. */
export const NOTETYPE_KIND_CLOZE = 1

/**
 * `Notetype.Field.Config`, in `fields.config`.
 *
 * ```proto
 * Notetype.Field.Config {
 *   bool sticky = 1;
 *   bool rtl = 2;
 *   string font_name = 3;
 *   uint32 font_size = 4;
 *   string description = 5;
 *   bool plain_text = 6;
 *   bool collapsed = 7;
 *   bool exclude_from_search = 8;
 *   bool prevent_deletion = 11;
 * }
 * ```
 */
export const decodeFieldConfig = (
  bytes: Uint8Array,
): Effect.Effect<
  {
    sticky: boolean
    rightToLeft: boolean
    fontName: string | null
    fontSize: number | null
    description: string
    plainText: boolean
  },
  AnkiCorruptArchive
> =>
  Effect.try({
    try: () => {
      let sticky = false
      let rightToLeft = false
      let fontName: string | null = null
      let fontSize: number | null = null
      let description = ''
      let plainText = false
      const reader = new ProtobufReader(bytes)
      for (let tag = reader.next(); tag !== null; tag = reader.next()) {
        if (tag.number === 1 && tag.wireType === 'varint') {
          sticky = reader.bool()
        } else if (tag.number === 2 && tag.wireType === 'varint') {
          rightToLeft = reader.bool()
        } else if (tag.number === 3 && tag.wireType === 'lengthDelimited') {
          fontName = reader.string()
        } else if (tag.number === 4 && tag.wireType === 'varint') {
          fontSize = reader.varint()
        } else if (tag.number === 5 && tag.wireType === 'lengthDelimited') {
          description = reader.string()
        } else if (tag.number === 6 && tag.wireType === 'varint') {
          plainText = reader.bool()
        } else {
          reader.skip(tag)
        }
      }
      return { sticky, rightToLeft, fontName, fontSize, description, plainText }
    },
    catch: () => corruptConfig('field configuration'),
  })

/**
 * `Notetype.Template.Config`, in `templates.config`.
 *
 * ```proto
 * Notetype.Template.Config {
 *   string q_format = 1;
 *   string a_format = 2;
 *   string q_format_browser = 3;
 *   string a_format_browser = 4;
 *   int64 target_deck_id = 5;      // 0 means the Note's own Deck
 * }
 * ```
 */
export const decodeTemplateConfig = (
  bytes: Uint8Array,
): Effect.Effect<
  { questionFormat: string; answerFormat: string; deckId: number },
  AnkiCorruptArchive
> =>
  Effect.try({
    try: () => {
      let questionFormat = ''
      let answerFormat = ''
      let deckId = 0
      const reader = new ProtobufReader(bytes)
      for (let tag = reader.next(); tag !== null; tag = reader.next()) {
        if (tag.number === 1 && tag.wireType === 'lengthDelimited') {
          questionFormat = reader.string()
        } else if (tag.number === 2 && tag.wireType === 'lengthDelimited') {
          answerFormat = reader.string()
        } else if (tag.number === 5 && tag.wireType === 'varint') {
          deckId = reader.varint()
        } else {
          reader.skip(tag)
        }
      }
      return { questionFormat, answerFormat, deckId }
    },
    catch: () => corruptConfig('template configuration'),
  })

/** The `kind` column of a Deck row that holds a normal Deck. */
const DECK_KIND_NORMAL = 1

/** The `kind` column of a Deck row that holds a filtered Deck. */
const DECK_KIND_FILTERED = 2

/** `Deck.Normal.description`, inside the `kind` column of a normal Deck. */
const DECK_NORMAL_DESCRIPTION = 4

/**
 * `Deck.KindContainer`, in `decks.kind`.
 *
 * ```proto
 * Deck.KindContainer {
 *   oneof kind { Deck.Normal normal = 1; Deck.Filtered filtered = 2; }
 * }
 * ```
 *
 * Field 6 and 7 hold the same messages on `Deck` itself, which only exists on
 * the RPC wire: the comment on the proto says the specifics are inlined there
 * so clients skip one level. The database keeps them in the container.
 *
 * A filtered Deck is a saved search rather than a place Cards live, so nook skips
 * it and sends its Cards back to the Decks they came from.
 */
export const decodeDeckKind = (
  bytes: Uint8Array,
): Effect.Effect<{ filtered: boolean; description: string }, AnkiCorruptArchive> =>
  Effect.try({
    try: () => {
      let filtered = false
      let description = ''
      const reader = new ProtobufReader(bytes)
      for (let tag = reader.next(); tag !== null; tag = reader.next()) {
        if (tag.number === DECK_KIND_FILTERED && tag.wireType === 'lengthDelimited') {
          filtered = true
          reader.skip(tag)
        } else if (tag.number === DECK_KIND_NORMAL && tag.wireType === 'lengthDelimited') {
          readNormalKind(reader.bytes(), (value) => {
            description = value
          })
        } else {
          reader.skip(tag)
        }
      }
      return { filtered, description }
    },
    catch: () => corruptConfig('deck configuration'),
  })

const readNormalKind = (bytes: Uint8Array, onDescription: (description: string) => void) => {
  const reader = new ProtobufReader(bytes)
  for (let tag = reader.next(); tag !== null; tag = reader.next()) {
    if (tag.number === DECK_NORMAL_DESCRIPTION && tag.wireType === 'lengthDelimited') {
      onDescription(reader.string())
    } else {
      reader.skip(tag)
    }
  }
}
