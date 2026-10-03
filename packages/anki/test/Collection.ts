import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { joinFields, joinTags } from '../src/Text'
import { bytesField, concat, stringField, uint32Field } from './Protobuf'

/**
 * A real Anki collection, written to a real SQLite file.
 *
 * The reader's SQL is the part most likely to be wrong in a way no unit test
 * would catch, because SQLite itself decides whether a query is legal. In
 * particular Anki declares several columns `COLLATE unicase`, a collation
 * `node:sqlite` does not have, and a query that touches one fails at run time
 * rather than at compile time. So these tests run the real thing.
 *
 * The schema is Anki's own, copied from `schema11.sql` for the tables that exist
 * at schema 11 and `schema15_upgrade.sql` for the ones added at schema 15. The
 * columns nook never reads are present but empty, because their absence would
 * make the schema unrealistic.
 *
 * One substitution: Anki declares its name columns `COLLATE unicase`, a
 * collation neither `node:sqlite` nor wa-sqlite has, so a fixture built with
 * it fails at DDL. These fixtures declare `COLLATE nocase` instead. The
 * substitution is faithful because the reader never depends on collation
 * order: it orders by `id` or by `(ntid, ord)` and never touches the `tags`
 * table. The production open path applies the same substitution to real
 * collection bytes before import, so fixtures and production read under the
 * same collation.
 */

export interface DeckSpec {
  readonly id: number
  /** The native name: components joined with a unit separator. */
  readonly name: string
  readonly description?: string
  readonly filtered?: boolean
}

export interface FieldSpec {
  readonly name: string
  readonly ord?: number
  readonly config?: Uint8Array
}

export interface TemplateSpec {
  readonly name: string
  readonly ord?: number
  readonly config?: Uint8Array
}

export interface NoteTypeSpec {
  readonly id: number
  readonly name: string
  /** Anki's `Notetype.Config.Kind`: 0 normal, 1 cloze. */
  readonly kind?: number
  readonly sortFieldIdx?: number
  readonly css?: string
  readonly fields?: ReadonlyArray<FieldSpec>
  readonly templates?: ReadonlyArray<TemplateSpec>
}

export interface NoteSpec {
  readonly id: number
  readonly guid?: string
  readonly noteTypeId: number
  /** Unix seconds. */
  readonly modified?: number
  readonly fields: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
}

export interface CardSpec {
  readonly id: number
  readonly noteId: number
  readonly deckId: number
  readonly templateOrd?: number
  /** The Deck this Card came from before a filtered Deck moved it. */
  readonly originDeckId?: number
  readonly suspended?: boolean
  readonly flag?: number
}

export interface CollectionSpec {
  readonly schemaVersion?: number
  readonly decks?: ReadonlyArray<DeckSpec>
  readonly noteTypes?: ReadonlyArray<NoteTypeSpec>
  readonly notes?: ReadonlyArray<NoteSpec>
  readonly cards?: ReadonlyArray<CardSpec>
}

const SCHEMA = `
CREATE TABLE col (
  id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL,
  ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL,
  conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL
);
CREATE TABLE notes (
  id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL,
  usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL,
  csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL
);
CREATE TABLE cards (
  id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL,
  mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL,
  due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL,
  lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL,
  flags integer NOT NULL, data text NOT NULL
);
CREATE TABLE notetypes (
  id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE nocase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL
);
CREATE TABLE fields (
  ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase,
  config blob NOT NULL, PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
CREATE TABLE templates (
  ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL,
  PRIMARY KEY (ntid, ord)
) WITHOUT ROWID;
CREATE TABLE decks (
  id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase,
  mtime_secs integer NOT NULL, usn integer NOT NULL, common blob NOT NULL, kind blob NOT NULL
);
`

/** `Deck.KindContainer`: a normal Deck carries its description at `Deck.Normal.description`. */
const deckKind = (deck: DeckSpec): Uint8Array =>
  deck.filtered === true
    ? bytesField(2, uint32Field(1, 1))
    : bytesField(1, stringField(4, deck.description ?? ''))

const notetypeConfig = (noteType: NoteTypeSpec): Uint8Array =>
  concat(
    uint32Field(1, noteType.kind ?? 0),
    uint32Field(2, noteType.sortFieldIdx ?? 0),
    stringField(3, noteType.css ?? ''),
  )

/** `node:sqlite` accepts null, number, bigint, string, and byte views. */
type Input = null | number | bigint | string | NodeJS.ArrayBufferView

const insert = (db: DatabaseSync, sql: string, ...params: ReadonlyArray<Input>) => {
  db.prepare(sql).run(...params)
}

/**
 * Writes a collection and returns its path. The caller owns the file, and
 * `removeCollection` deletes the directory it sits in.
 */
export const writeCollection = (spec: CollectionSpec): string => {
  const directory = mkdtempSync(join(tmpdir(), 'nook-anki-'))
  const filename = join(directory, 'collection.anki21')

  const db = new DatabaseSync(filename)
  try {
    db.exec(SCHEMA)
    insert(
      db,
      'INSERT INTO col VALUES (1, 0, 0, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?)',
      spec.schemaVersion ?? 18,
      '{}',
      '{}',
      '{}',
      '{}',
      '{}',
    )

    for (const deck of spec.decks ?? []) {
      insert(
        db,
        'INSERT INTO decks VALUES (?, ?, 0, -1, ?, ?)',
        deck.id,
        deck.name,
        new Uint8Array(0),
        deckKind(deck),
      )
    }
    for (const noteType of spec.noteTypes ?? []) {
      insert(
        db,
        'INSERT INTO notetypes VALUES (?, ?, 0, -1, ?)',
        noteType.id,
        noteType.name,
        notetypeConfig(noteType),
      )
      for (const field of noteType.fields ?? []) {
        insert(
          db,
          'INSERT INTO fields VALUES (?, ?, ?, ?)',
          noteType.id,
          field.ord ?? 0,
          field.name,
          field.config ?? new Uint8Array(0),
        )
      }
      for (const template of noteType.templates ?? []) {
        insert(
          db,
          'INSERT INTO templates VALUES (?, ?, ?, 0, -1, ?)',
          noteType.id,
          template.ord ?? 0,
          template.name,
          template.config ?? new Uint8Array(0),
        )
      }
    }
    for (const note of spec.notes ?? []) {
      insert(
        db,
        'INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, 0, 0, ?)',
        note.id,
        note.guid ?? `guid-${note.id}`,
        note.noteTypeId,
        note.modified ?? 0,
        joinTags(note.tags ?? []),
        joinFields(note.fields),
        note.fields.at(0) ?? '',
        '',
      )
    }
    for (const card of spec.cards ?? []) {
      insert(
        db,
        `INSERT INTO cards VALUES (?, ?, ?, ?, 0, -1, 0, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, '{}')`,
        card.id,
        card.noteId,
        card.deckId,
        card.templateOrd ?? 0,
        card.suspended === true ? -1 : 0,
        card.originDeckId ?? 0,
        card.flag ?? 0,
      )
    }
  } finally {
    db.close()
  }

  return filename
}

export const removeCollection = (filename: string): void => {
  rmSync(join(filename, '..'), { force: true, recursive: true })
}
