-- Optional Anki review history on an Import.
--
-- An Import that opts in carries a third stream beside Notes and Cards: the
-- graded rows of the archive's `revlog`. The server replays each Card's whole
-- history through FSRS-6 and writes the resulting state onto the Card, plus one
-- `reviews` row per replayed Review (with the `state_after` columns from 0008
-- filled in). Default imports never touch any of this.
--
-- The stream is ordered by Card, and a batch never splits a Card's history, so
-- `reviews_cursor` is the last Anki Card id whose history landed. Replaying one
-- Card is a pure function of its history, so a retried batch lands on the same
-- rows: Review ids are `anki-<card id>-<revlog id>` and upsert.
--
-- `include_history` lives on the Import, not only in the request, because a
-- resumed run (after a reload) does not remember the Learner's choice.

ALTER TABLE imports ADD COLUMN include_history INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN reviews_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0;

-- Tie a replayed Review to the Import that wrote it, as `cards` already is.
-- Reviews the Learner graded in nook have none.
ALTER TABLE reviews ADD COLUMN import_id TEXT REFERENCES imports (id);
CREATE INDEX reviews_import_id_idx ON reviews (import_id);
