-- nook schema: one Learner, Decks of Cards, one Review log, one settings row.
--
-- Writes follow ADR 0003: no BEGIN TRANSACTION anywhere. Multi-statement writes
-- go through D1 `batch()`, which runs atomically.

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_delta INTEGER NOT NULL DEFAULT 0,
  last_studied_at TEXT,
  retention_7d INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks (id),
  due_in_days INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  difficulty INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX cards_deck_id_idx ON cards (deck_id);

-- Append-only per-Learner log (ADR 0002). Card state derives from these rows.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards (id),
  grade TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX reviews_card_id_idx ON reviews (card_id);
CREATE INDEX reviews_reviewed_at_idx ON reviews (reviewed_at);

-- Singleton row (id = 1). The settings page edits this; FSRS reads it.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
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

-- Seed the singleton settings row with the FSRS-6 defaults the contract documents.
INSERT INTO settings (
  id, fsrs_desired_retention, fsrs_weights, fsrs_maximum_interval,
  fsrs_new_per_day, fsrs_reviews_per_day, fsrs_lapse_minutes,
  behaviour_review_sounds, behaviour_tap_to_reveal,
  behaviour_day_rollover_hour, behaviour_keep_awake
) VALUES (
  1, 0.9,
  '0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.7969,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729',
  365, 20, 200, 10,
  1, 1, 4, 0
);
