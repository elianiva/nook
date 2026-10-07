-- Leech detection counts failed Reviews only when a Card was in review mode.
-- The scheduler's `lapses` still includes Again grades during learning and
-- relearning, so it is intentionally not reused for the Anki-style trigger.

ALTER TABLE cards ADD COLUMN review_lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN leech_suspended INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_snapshots ADD COLUMN review_lapses INTEGER NOT NULL DEFAULT 0;
-- NULL means the old snapshot predates suspension tracking; Undo must not
-- guess that the Card was active and clear a later/manual suspension.
ALTER TABLE review_snapshots ADD COLUMN suspended INTEGER;

-- Snapshots record the state immediately before each grade. Older reviews
-- without snapshots cannot be classified reliably and are conservatively
-- omitted from the leech counter.
UPDATE cards SET review_lapses = (
  SELECT COUNT(*) FROM reviews r
  JOIN review_snapshots s ON s.review_id = r.id
  WHERE r.card_id = cards.id AND r.grade = 'Again' AND s.state = 'review'
);

-- Undo snapshots need the same leech counter as the Card. Reconstruct each
-- historical before-grade value from earlier review-mode Again events.
UPDATE review_snapshots SET review_lapses = (
  SELECT COUNT(*) FROM reviews current
  JOIN reviews previous ON previous.card_id = current.card_id
  JOIN review_snapshots prior ON prior.review_id = previous.id
  WHERE current.id = review_snapshots.review_id
    AND previous.rowid < current.rowid
    AND previous.grade = 'Again' AND prior.state = 'review'
);
