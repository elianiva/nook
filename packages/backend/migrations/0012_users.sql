-- Multiple users: every table that holds a Learner's collection gains an owner.
--
-- Ids are not globally unique. A Deck, Note, Card, or Import id comes from an
-- Anki archive or a JSON export, so two users importing the same file produce
-- the same ids. Each of these tables is therefore keyed by (user_id, id), and
-- every reference between them carries user_id as well, so a row can only point
-- at a row of the same user. Services add `user_id = ?` to every statement.
--
-- Everything that exists before this migration belongs to the owner `legacy`.
-- The first admin sign-in adopts it (`adoptLegacyCollection`), which rewrites
-- `legacy` to that user's id. ON UPDATE CASCADE lets the references follow.
--
-- SQLite cannot change a primary key, so each table is renamed to `*_old`,
-- recreated, refilled, and dropped. Foreign keys are deferred until the end of
-- the migration so parents and children can be swapped in any order.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE undone_reviews RENAME TO undone_reviews_old;
ALTER TABLE review_snapshots RENAME TO review_snapshots_old;
ALTER TABLE reviews RENAME TO reviews_old;
ALTER TABLE cards RENAME TO cards_old;
ALTER TABLE notes RENAME TO notes_old;
ALTER TABLE note_types RENAME TO note_types_old;
ALTER TABLE decks RENAME TO decks_old;
ALTER TABLE imports RENAME TO imports_old;
ALTER TABLE settings RENAME TO settings_old;

DROP INDEX IF EXISTS cards_buried_until_idx;
DROP INDEX IF EXISTS cards_deck_id_idx;
DROP INDEX IF EXISTS cards_due_at_idx;
DROP INDEX IF EXISTS cards_import_id_idx;
DROP INDEX IF EXISTS notes_import_id_idx;
DROP INDEX IF EXISTS notes_note_type_id_idx;
DROP INDEX IF EXISTS reviews_card_id_idx;
DROP INDEX IF EXISTS reviews_import_id_idx;
DROP INDEX IF EXISTS reviews_reviewed_at_idx;

CREATE TABLE imports (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  notes_cursor INTEGER NOT NULL DEFAULT 0,
  cards_cursor INTEGER NOT NULL DEFAULT 0,
  note_count INTEGER NOT NULL DEFAULT 0,
  card_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  include_history INTEGER NOT NULL DEFAULT 0,
  reviews_cursor INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE decks (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_delta INTEGER NOT NULL DEFAULT 0,
  last_studied_at TEXT,
  retention_7d INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  new_per_day INTEGER,
  reviews_per_day INTEGER,
  lapse_minutes INTEGER,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE note_types (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sort_field_ord INTEGER NOT NULL,
  css TEXT NOT NULL,
  fields TEXT NOT NULL,
  templates TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE notes (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  note_type_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  fields TEXT NOT NULL,
  tags TEXT NOT NULL,
  modified INTEGER NOT NULL,
  import_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  media_import_id TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, import_id) REFERENCES imports (user_id, id) ON UPDATE CASCADE,
  FOREIGN KEY (user_id, media_import_id) REFERENCES imports (user_id, id) ON UPDATE CASCADE
);

CREATE TABLE cards (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  due_in_days INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  difficulty INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  note_id TEXT,
  template_ord INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  flag INTEGER NOT NULL DEFAULT 0,
  import_id TEXT,
  due_at TEXT,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  introduced_day TEXT,
  buried_until TEXT,
  buried_sibling_of TEXT,
  review_lapses INTEGER NOT NULL DEFAULT 0,
  grade_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, deck_id) REFERENCES decks (user_id, id) ON UPDATE CASCADE,
  FOREIGN KEY (user_id, import_id) REFERENCES imports (user_id, id) ON UPDATE CASCADE
);

CREATE TABLE reviews (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  grade TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  leech_suspended INTEGER NOT NULL DEFAULT 0,
  state_after TEXT,
  stability_after REAL,
  difficulty_after REAL,
  due_in_days_after INTEGER,
  due_at_after TEXT,
  import_id TEXT,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, card_id) REFERENCES cards (user_id, id) ON UPDATE CASCADE,
  FOREIGN KEY (user_id, import_id) REFERENCES imports (user_id, id) ON UPDATE CASCADE
);

CREATE TABLE review_snapshots (
  user_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  state TEXT NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  due_in_days INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  introduced_day TEXT,
  last_reviewed_at TEXT,
  buried_until TEXT,
  review_lapses INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER,
  PRIMARY KEY (user_id, review_id),
  FOREIGN KEY (user_id, review_id) REFERENCES reviews (user_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id, card_id) REFERENCES cards (user_id, id) ON UPDATE CASCADE
);

CREATE TABLE undone_reviews (
  user_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  undone_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, review_id)
);

-- One row per user, written with the account (`provisionUser`) with the FSRS
-- defaults.
CREATE TABLE settings (
  user_id TEXT PRIMARY KEY,
  fsrs_desired_retention REAL NOT NULL,
  fsrs_weights TEXT NOT NULL,
  fsrs_maximum_interval INTEGER NOT NULL,
  fsrs_new_per_day INTEGER NOT NULL,
  fsrs_reviews_per_day INTEGER NOT NULL,
  fsrs_lapse_minutes INTEGER NOT NULL,
  behaviour_review_sounds INTEGER NOT NULL,
  behaviour_tap_to_reveal INTEGER NOT NULL,
  behaviour_day_rollover_hour INTEGER NOT NULL,
  behaviour_keep_awake INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO imports (user_id, id, filename, status, notes_cursor, cards_cursor, note_count,
  card_count, media_count, error, created_at, updated_at, include_history, reviews_cursor,
  review_count)
SELECT 'legacy', id, filename, status, notes_cursor, cards_cursor, note_count, card_count,
  media_count, error, created_at, updated_at, include_history, reviews_cursor, review_count
FROM imports_old;

INSERT INTO decks (user_id, id, name, description, due_delta, last_studied_at, retention_7d,
  created_at, updated_at, new_per_day, reviews_per_day, lapse_minutes)
SELECT 'legacy', id, name, description, due_delta, last_studied_at, retention_7d, created_at,
  updated_at, new_per_day, reviews_per_day, lapse_minutes
FROM decks_old;

INSERT INTO note_types (user_id, id, name, kind, sort_field_ord, css, fields, templates,
  updated_at)
SELECT 'legacy', id, name, kind, sort_field_ord, css, fields, templates, updated_at
FROM note_types_old;

INSERT INTO notes (user_id, id, note_type_id, guid, fields, tags, modified, import_id,
  updated_at, media_import_id)
SELECT 'legacy', id, note_type_id, guid, fields, tags, modified, import_id, updated_at,
  media_import_id
FROM notes_old;

INSERT INTO cards (user_id, id, deck_id, due_in_days, stability, difficulty, state, created_at,
  updated_at, note_id, template_ord, suspended, flag, import_id, due_at, reps, lapses,
  last_reviewed_at, introduced_day, buried_until, buried_sibling_of, review_lapses, grade_seq)
SELECT 'legacy', id, deck_id, due_in_days, stability, difficulty, state, created_at, updated_at,
  note_id, template_ord, suspended, flag, import_id, due_at, reps, lapses, last_reviewed_at,
  introduced_day, buried_until, buried_sibling_of, review_lapses, grade_seq
FROM cards_old;

INSERT INTO reviews (user_id, id, card_id, grade, reviewed_at, leech_suspended, state_after,
  stability_after, difficulty_after, due_in_days_after, due_at_after, import_id)
SELECT 'legacy', id, card_id, grade, reviewed_at, leech_suspended, state_after,
  stability_after, difficulty_after, due_in_days_after, due_at_after, import_id
FROM reviews_old;

INSERT INTO review_snapshots (user_id, review_id, card_id, state, stability, difficulty,
  due_in_days, due_at, reps, lapses, introduced_day, last_reviewed_at, buried_until,
  review_lapses, suspended)
SELECT 'legacy', review_id, card_id, state, stability, difficulty, due_in_days, due_at, reps,
  lapses, introduced_day, last_reviewed_at, buried_until, review_lapses, suspended
FROM review_snapshots_old;

INSERT INTO undone_reviews (user_id, review_id, card_id, undone_at)
SELECT 'legacy', review_id, card_id, undone_at FROM undone_reviews_old;

INSERT INTO settings (user_id, fsrs_desired_retention, fsrs_weights, fsrs_maximum_interval,
  fsrs_new_per_day, fsrs_reviews_per_day, fsrs_lapse_minutes, behaviour_review_sounds,
  behaviour_tap_to_reveal, behaviour_day_rollover_hour, behaviour_keep_awake, created_at,
  updated_at)
SELECT 'legacy', fsrs_desired_retention, fsrs_weights, fsrs_maximum_interval, fsrs_new_per_day,
  fsrs_reviews_per_day, fsrs_lapse_minutes, behaviour_review_sounds, behaviour_tap_to_reveal,
  behaviour_day_rollover_hour, behaviour_keep_awake, created_at, updated_at
FROM settings_old;

DROP TABLE undone_reviews_old;
DROP TABLE review_snapshots_old;
DROP TABLE reviews_old;
DROP TABLE cards_old;
DROP TABLE notes_old;
DROP TABLE note_types_old;
DROP TABLE decks_old;
DROP TABLE imports_old;
DROP TABLE settings_old;

CREATE INDEX cards_deck_id_idx ON cards (user_id, deck_id);
CREATE INDEX cards_due_at_idx ON cards (user_id, due_at);
CREATE INDEX cards_buried_until_idx ON cards (user_id, buried_until);
CREATE INDEX cards_import_id_idx ON cards (user_id, import_id);
CREATE INDEX notes_import_id_idx ON notes (user_id, import_id);
CREATE INDEX notes_note_type_id_idx ON notes (user_id, note_type_id);
CREATE INDEX reviews_card_id_idx ON reviews (user_id, card_id);
CREATE INDEX reviews_import_id_idx ON reviews (user_id, import_id);
CREATE INDEX reviews_reviewed_at_idx ON reviews (user_id, reviewed_at);
