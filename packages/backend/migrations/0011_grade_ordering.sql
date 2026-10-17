-- Order concurrent grades and remember undone ones.
--
-- `cards.grade_seq` is the Card's version. Every grade and every undo bumps it
-- and nothing lowers it, so a grade that was computed from a stale read can be
-- told apart from one computed from the current Card (the write is guarded on
-- the version it read). Undo restores the scheduling state, never the version.
--
-- `undone_reviews` keeps the id of each undone grade. Undo deletes the Review
-- row, so without this a late replay of the same id looks new and lands again.

ALTER TABLE cards ADD COLUMN grade_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE undone_reviews (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  undone_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
