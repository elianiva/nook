-- Day boundary, per-day limits, and sibling burying.
--
-- `day_start_utc` is the UTC instant the learner's day starts at: rollover hour
-- in the learner timezone, converted to UTC. Due-ness compares `due_at` against
-- it, and the per-day counts count Reviews since it, so a learner past midnight
-- but before rollover still sees yesterday's day. The Worker computes it per
-- request from `dayRolloverHour` and the browser's timezone; the column is only
-- ever written by a grade, never read as the boundary itself.
--
-- `introduced_day` marks which learner-day a new Card entered review, so
-- `newPerDay` counts introductions per day instead of capping the queue length.
-- `buried_until` hides a Card until an instant, which is how sibling burying
-- and Again re-queue share one mechanism: both set a future instant the queue
-- skips. `buried_sibling_of` names the Card whose grading buried this one, so
-- undo can unbury it; an in-session re-queue buries with NULL instead.

ALTER TABLE cards ADD COLUMN introduced_day TEXT;
ALTER TABLE cards ADD COLUMN buried_until TEXT;
ALTER TABLE cards ADD COLUMN buried_sibling_of TEXT;
CREATE INDEX cards_buried_until_idx ON cards (buried_until);

-- The day the Card entered review, as `YYYY-MM-DD` in the learner timezone.
-- Backfill from the last Review so existing collections keep their limits.
UPDATE cards SET introduced_day = date(last_reviewed_at) WHERE last_reviewed_at IS NOT NULL AND state != 'new';

-- The Card's scheduling state before each grade, for undo. One row per Review
-- log row, written in the same batch as the grade; undo restores it exactly
-- and deletes both rows. Reviews written before this migration have no
-- snapshot and cannot be undone.
CREATE TABLE review_snapshots (
  review_id TEXT PRIMARY KEY REFERENCES reviews (id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards (id),
  state TEXT NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  due_in_days INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  introduced_day TEXT,
  last_reviewed_at TEXT,
  buried_until TEXT
);
