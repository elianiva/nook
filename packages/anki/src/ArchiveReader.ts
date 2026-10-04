import { Effect, Option, Schema, Stream } from 'effect'
import * as Sql from 'effect/sql/SqlClient'
import type { Row } from 'effect/sql/SqlConnection'
import type { SqlError } from 'effect/sql/SqlError'
import { AnkiCard, AnkiNote } from './AnkiContent'
import type { AnkiReadError } from './AnkiErrors'
import {
  NOTETYPE_KIND_CLOZE,
  decodeDeckKind,
  decodeFieldConfig,
  decodeNotetypeConfig,
  decodeTemplateConfig,
} from './AnkiModel'
import { AnkiDeck, AnkiField, AnkiNoteType, AnkiTemplate } from './AnkiManifest'

/**
 * Every statement this package runs against an Anki collection.
 *
 * Two rules hold for all of them, and both come from a collation Anki registers
 * at runtime and neither wa-sqlite nor `node:sqlite` has. SQLite refuses to
 * compare values under an unknown collation, so a query that needs one fails
 * rather than answering.
 *
 * The first rule: never read the `tags` table. Its primary key is collated, and
 * its contents are the Tags that `notes.tags` already carries.
 *
 * The second rule: never order by a collated column. `decks.name`,
 * `notetypes.name`, `fields.name`, `templates.name`, `deck_config.name`, and
 * `tags.tag` are all collated. Order by `id`, which is the rowid, or by `ord`
 * alongside `ntid`, which is the `fields` and `templates` primary key.
 *
 * Deck options and the review log are never read. nook starts every imported Card
 * as new and applies its own limits, so Anki's scheduling state has nowhere to go.
 *
 * A damaged blob fails in the error channel with a corrupt-archive error
 * carrying a fix, never a thrown decode error. A page that ends without a last
 * row ends the stream: an empty `Option` is the last page, not a crash.
 */

/** Runs a statement and decodes every row it returns. */
const decodeRows =
  <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(schema: S) =>
  (
    rows: Effect.Effect<ReadonlyArray<Row>, SqlError>,
  ): Effect.Effect<ReadonlyArray<S['Type']>, AnkiReadError> =>
    Effect.flatMap(rows, Schema.decodeUnknownEffect(Schema.Array(schema)))

const CountRow = Schema.Struct({ n: Schema.Number })

const countOf = (
  rows: Effect.Effect<ReadonlyArray<Row>, SqlError>,
): Effect.Effect<number, AnkiReadError> =>
  decodeRows(CountRow)(rows).pipe(Effect.map((decoded) => decoded.at(0)?.n ?? 0))

/** Anki's `col.ver`: the schema of the database inside the archive. */
export const readSchemaVersion = (sql: Sql.SqlClient): Effect.Effect<number, AnkiReadError> =>
  countOf(sql`SELECT ver AS n FROM col`)

/** How many Notes the archive holds, without reading any of them. */
export const countNotes = (sql: Sql.SqlClient): Effect.Effect<number, AnkiReadError> =>
  countOf(sql`SELECT count(*) AS n FROM notes`)

/** How many Cards the archive holds, without reading any of them. */
export const countCards = (sql: Sql.SqlClient): Effect.Effect<number, AnkiReadError> =>
  countOf(sql`SELECT count(*) AS n FROM cards`)

const DeckRow = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  kind: Schema.Uint8Array,
})

/**
 * The Decks an archive holds, minus the filtered ones.
 *
 * A filtered Deck is a saved search rather than a place Cards live, and the Cards
 * it gathered carry the Deck they came from in `cards.odid`. Skipping it here is
 * what lets the Card reader send every Card home.
 */
export const readDecks = (
  sql: Sql.SqlClient,
): Effect.Effect<ReadonlyArray<AnkiDeck>, AnkiReadError> =>
  sql`SELECT id, name, kind FROM decks ORDER BY id`.pipe(
    decodeRows(DeckRow),
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) => decodeDeckKind(row.kind).pipe(Effect.map((kind) => ({ row, kind })))),
      ),
    ),
    Effect.flatMap((pairs) =>
      Schema.decodeUnknownEffect(Schema.Array(AnkiDeck))(
        pairs.flatMap(({ row, kind }) =>
          kind.filtered ? [] : [{ id: row.id, name: row.name, description: kind.description }],
        ),
      ),
    ),
  )

const NotetypeRow = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  config: Schema.Uint8Array,
})

const FieldRow = Schema.Struct({
  ntid: Schema.Number,
  ord: Schema.Number,
  name: Schema.String,
  config: Schema.Uint8Array,
})

const TemplateRow = Schema.Struct({
  ntid: Schema.Number,
  ord: Schema.Number,
  name: Schema.String,
  config: Schema.Uint8Array,
})

const toField = (row: typeof FieldRow.Type): Effect.Effect<AnkiField, AnkiReadError> =>
  decodeFieldConfig(row.config).pipe(
    Effect.flatMap((config) =>
      Schema.decodeUnknownEffect(AnkiField)({
        ord: row.ord,
        name: row.name,
        rightToLeft: config.rightToLeft,
        fontName: config.fontName,
        fontSize: config.fontSize,
        plainText: config.plainText,
        description: config.description,
        sticky: config.sticky,
      }),
    ),
  )

const toTemplate = (row: typeof TemplateRow.Type): Effect.Effect<AnkiTemplate, AnkiReadError> =>
  decodeTemplateConfig(row.config).pipe(
    Effect.flatMap((config) =>
      Schema.decodeUnknownEffect(AnkiTemplate)({
        ord: row.ord,
        name: row.name,
        questionFormat: config.questionFormat,
        answerFormat: config.answerFormat,
        deckId: config.deckId,
      }),
    ),
  )

const groupByNoteType = <A extends { readonly ntid: number }>(
  rows: ReadonlyArray<A>,
): ReadonlyMap<number, ReadonlyArray<A>> => {
  const grouped = new Map<number, Array<A>>()
  for (const row of rows) {
    const bucket = grouped.get(row.ntid)
    if (bucket === undefined) {
      grouped.set(row.ntid, [row])
    } else {
      bucket.push(row)
    }
  }
  return grouped
}

/**
 * Every Note Type in the archive, with its Fields and Templates.
 *
 * A Note Type is spread over three tables. nook reads all three and joins them in
 * memory rather than in SQL, because a collection holds tens of Note Types and a
 * few Fields each, so all three tables are small, and three plain queries are
 * easier to keep clear of the collation rule than a join is.
 */
export const readNoteTypes = (
  sql: Sql.SqlClient,
): Effect.Effect<ReadonlyArray<AnkiNoteType>, AnkiReadError> =>
  Effect.all(
    [
      decodeRows(NotetypeRow)(sql`SELECT id, name, config FROM notetypes ORDER BY id`),
      decodeRows(FieldRow)(sql`SELECT ntid, ord, name, config FROM fields ORDER BY ntid, ord`),
      decodeRows(TemplateRow)(
        sql`SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord`,
      ),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.flatMap(([notetypes, fields, templates]) => {
      const fieldsByType = groupByNoteType(fields)
      const templatesByType = groupByNoteType(templates)
      return Effect.all(
        notetypes.map((row) =>
          decodeNotetypeConfig(row.config).pipe(
            Effect.flatMap((config) =>
              Effect.all([
                Effect.all((fieldsByType.get(row.id) ?? []).map(toField)),
                Effect.all((templatesByType.get(row.id) ?? []).map(toTemplate)),
              ]).pipe(
                Effect.map(([decodedFields, decodedTemplates]) => ({
                  id: row.id,
                  name: row.name,
                  kind:
                    config.kind === NOTETYPE_KIND_CLOZE ? ('cloze' as const) : ('normal' as const),
                  sortFieldOrd: config.sortFieldIdx,
                  css: config.css,
                  fields: [...decodedFields],
                  templates: [...decodedTemplates],
                })),
              ),
            ),
          ),
        ),
      )
    }),
    Effect.flatMap((assembled) =>
      Schema.decodeUnknownEffect(Schema.Array(AnkiNoteType))(assembled),
    ),
  )

/**
 * The `id` to page after, or `None` when the page is the last one.
 *
 * A full page names its last row; a short page is the end. When a full page
 * somehow carries no last row, the stream ends rather than crashing: stopping
 * early keeps what was read, and the manifest counts say what is missing.
 */
const nextAfter = <A extends { readonly id: number }>(
  items: ReadonlyArray<A>,
): Option.Option<number> =>
  items.length < 5000 ? Option.none<number>() : Option.fromUndefinedOr(items.at(-1)?.id)

/**
 * Every Note, in Anki id order.
 *
 * Notes page through `id`, one page per pull, so a collection of any size reads
 * without holding all of it at once. The node driver has no cursor stream, and
 * the wasm one only streams from memory, so paging keeps both drivers on the
 * same query path.
 *
 * Every page query touches `notes.id`, which is the rowid and carries no
 * collation. A `LIMIT` with a bound parameter is what keeps the page size out
 * of the SQL text.
 */
export const streamNotes = (sql: Sql.SqlClient): Stream.Stream<AnkiNote, AnkiReadError> =>
  Stream.paginate(0, (after) =>
    sql`SELECT id, guid, mid, mod, flds, tags FROM notes WHERE id > ${after} ORDER BY id LIMIT 5000`.pipe(
      decodeRows(AnkiNote),
      Effect.map((notes) => [notes, nextAfter(notes)] as const),
    ),
  )

/** Every Card, in Anki id order, with its scheduling already discarded. */
export const streamCards = (sql: Sql.SqlClient): Stream.Stream<AnkiCard, AnkiReadError> =>
  Stream.paginate(0, (after) =>
    sql`SELECT id, nid, did, odid, ord, queue, flags FROM cards WHERE id > ${after} ORDER BY id LIMIT 5000`.pipe(
      decodeRows(AnkiCard),
      Effect.map((cards) => [cards, nextAfter(cards)] as const),
    ),
  )
