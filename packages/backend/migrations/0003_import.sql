-- Import tracking, plus the content an `.apkg` archive carries.
--
-- An Import is keyed by the SHA-256 of the archive's bytes, so importing the
-- same file twice lands on the same row. The second run reads the cursors
-- below and continues from the last Anki id each stream wrote, and every row
-- it writes is an upsert keyed by Anki's own id, so re-importing overwrites
-- instead of duplicating. A run that dies midway resumes at its cursor rather
-- than starting over.
--
-- Progress is not stored: it is the count of rows whose `import_id` is this
-- Import, read back in the same query as the cursors. A stored counter would
-- drift the moment a batch was retried or a second archive was imported.
--
-- Writes follow ADR 0003: no BEGIN TRANSACTION anywhere. The cursor is the
-- commit point, and every statement before it is idempotent, so a batch that
-- half-lands is repaired by the next attempt.

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  -- The last Anki id written in each stream. Notes and Cards are separate
  -- streams with separate ids, so each needs its own high-water mark.
  notes_cursor INTEGER NOT NULL DEFAULT 0,
  cards_cursor INTEGER NOT NULL DEFAULT 0,
  -- What the archive said it held, so progress has a denominator. Media is
  -- counted but not stored: nook has no bucket for it yet.
  note_count INTEGER NOT NULL DEFAULT 0,
  card_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A Note Type: the rules that turn a Note into Cards. Fields and Templates are
-- small, ordered lists that are only ever read whole, so they ride as JSON.
CREATE TABLE note_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sort_field_ord INTEGER NOT NULL,
  css TEXT NOT NULL,
  fields TEXT NOT NULL,
  templates TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A Note: the stored content Cards are generated from. Anki joins Fields and
-- Tags into single columns, so nook stores them as JSON arrays instead.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  note_type_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  fields TEXT NOT NULL,
  tags TEXT NOT NULL,
  modified INTEGER NOT NULL,
  import_id TEXT NOT NULL REFERENCES imports (id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX notes_note_type_id_idx ON notes (note_type_id);
CREATE INDEX notes_import_id_idx ON notes (import_id);

-- Imported Cards land in the existing `cards` table as new Cards, so the
-- screens that already read it show an Import without knowing where it came
-- from. These columns tie a Card back to the Note it renders and to the Import
-- that wrote it; a seeded Card has neither.
ALTER TABLE cards ADD COLUMN note_id TEXT;
ALTER TABLE cards ADD COLUMN template_ord INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN import_id TEXT REFERENCES imports (id);
CREATE INDEX cards_import_id_idx ON cards (import_id);
